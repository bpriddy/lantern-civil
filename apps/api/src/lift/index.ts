import type { ProjectSource } from '../project/source.js';
import { LIFT_PATH_CAP, isSampleCode, readRepo, selectLiftPathsReport } from './read.js';
import { createHash } from 'node:crypto';
import { REGISTRY_PATH } from '../project/registry.js';
import { readLiftProvenance } from './documents-registry.js';
import { applyRefinement, refineSkeleton, validateRefinement } from './refine.js';
import { parse } from 'yaml';
import { zProject } from '@civil/schema';
import type { FileMap, Skeleton } from './skeleton.js';
import { skeletonToDocuments } from './to-documents.js';
import { claimsFromSkeleton, reconcile, toSkeleton } from './claims.js';
import { analysisPaths, analyzeRepository, type AnalysisReport, type AnalyzeAsk, type AnalyzeOptions } from './analysts.js';

/** Where a lift is, for progress: in order. */
export type LiftStage = 'listing' | 'reading' | 'analysing' | 'refining' | 'writing';

/**
 * "Generate graph from repo" / "Update graph from repo" (docs/lift-repo.md): an
 * existing codebase read into Civil's own documents. This is the one place the four
 * stages meet — select, read, refine, map — so the route stays a thin shell around
 * opening the project and landing the result as pending changes.
 *
 * Nothing here writes. The source is read through `ensure` + `read` like every other
 * route (no clone, no working tree — CLAUDE.md's no-local-file-storage), the readers
 * are pure functions over the in-memory file map, and what comes back is a set of
 * civil/ documents the caller saves as pending changes for the author to review.
 */

/** The runner's POST /lift/refine, bound by the caller; absent when no runner is set. */
export type LiftAsk = (body: unknown) => Promise<Record<string, unknown>>;

export interface LiftResult {
  /** civil/* path → content: the documents to land as pending changes. */
  files: Record<string, string>;
  /** One plain paragraph on what was found and written, for the toast. */
  summary: string;
  skeleton: Skeleton;
  /** What the reader or mapper could not resolve — reported, never guessed. */
  diagnostics: string[];
  /** Why the model pass did not contribute, when it did not (no runner, a failure). */
  note: string | null;
  /** How much of the repository was read: every file listed, and those loaded. */
  filesListed: number;
  filesRead: number;
  /** Files the reader wanted but left out because the cap was reached; 0 normally. */
  filesDropped: number;
  /** The agent stage's run, when it was asked: what it said and what was not believed. */
  analysis?: AnalysisReport & { disbelieved: string[] };
}

/**
 * A lift Civil will not run on this project, in words the author can act on. The
 * route answers 422 with it and writes nothing.
 */
export class LiftRefusal extends Error {
  constructor(
    readonly code: 'legacy_layout' | 'python_project',
    message: string,
  ) {
    super(message);
    this.name = 'LiftRefusal';
  }
}

const parseYaml = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Whether reading the repository may write over this project's documents. Two cases
 * it may not, both refused before any work:
 *
 * - a project whose documents are still at the repository root. The lift writes
 *   civil/, and civil/civil.yaml is read first — a fresh one would silently shadow the
 *   author's composition, layout and settings. Moving into civil/ comes first.
 * - a Python project Civil generates code for: its composition exists, its registry is
 *   not a lift's (no lifted_from), and its language is python. Reading it would switch
 *   it to TypeScript and replace the registry's record of what Apply generated — Apply
 *   would stop working on a project where it works.
 */
export function liftRefusal(existing: FileMap, rootCivilYaml: string | undefined): LiftRefusal | null {
  if (existing['civil/civil.yaml'] === undefined && rootCivilYaml !== undefined) {
    return new LiftRefusal(
      'legacy_layout',
      'This project keeps its Civil documents at the repository root. Move them into civil/ first ' +
        '("Move into civil/"), then read the graph from the repo. Nothing was changed.',
    );
  }
  const project = zProject.safeParse(parseYaml(existing['civil/civil.yaml']));
  if (!project.success || project.data.spec.language !== 'python') return null;
  const composition = parseYaml(existing[project.data.spec.composition]) as { spec?: { nodes?: unknown } } | undefined;
  const hasNodes = Array.isArray(composition?.spec?.nodes) && composition.spec.nodes.length > 0;
  if (!hasNodes || readLiftProvenance(existing[REGISTRY_PATH])) return null;
  return new LiftRefusal(
    'python_project',
    'This is a Python project Civil generates code for. Reading the repository would switch it to ' +
      "TypeScript and replace the registry's record of what Apply generated. Generate graph from repo " +
      'is for a TypeScript codebase that has no Civil design yet. Nothing was changed.',
  );
}

/**
 * The skeleton as the model sees it, minus what moves without meaning anything: line
 * numbers. An edit that shifts a module down three lines is not a reason to ask again
 * and reword every description.
 */
function withoutLines(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLines);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'line')
        .map(([key, v]) => [key, withoutLines(v)]),
    );
  }
  return value;
}

/** Docs the model pass may read for naming and description — prose, never code. */
const isDoc = (path: string): boolean =>
  path === 'README.md' || /(^|\/)README\.md$/.test(path) || /^docs\/.+\.md$/.test(path);

/**
 * What the model pass would be shown — the reader's skeleton and the docs — as one
 * hash. Both are deterministic for the same repository (the reader is pure and its
 * output ordered), so an unchanged repository gives the same fingerprint.
 */
/**
 * JSON with every object's keys sorted: the same value always serialises the same.
 * A skeleton assembled from claims that came back out of Postgres (JSONB reorders an
 * object's keys) must fingerprint like the one built from the fresh answer — otherwise
 * an unchanged repository re-asks the model pass and rewords the graph (found live).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export function liftFingerprint(skeleton: Skeleton, docs: Record<string, string>): string {
  const sortedDocs = Object.keys(docs).sort().map((path) => [path, docs[path]]);
  const hash = createHash('sha256').update(canonicalJson({ skeleton: withoutLines(skeleton), docs: sortedDocs })).digest('hex');
  return `sha256:${hash.slice(0, 16)}`;
}

export async function liftRepository(
  source: ProjectSource,
  opts: {
    projectName: string;
    ask?: LiftAsk | undefined;
    /**
     * The runner's POST /lift/analyze: analysts and verifiers (analysts.ts). Opt-in
     * until their answer is memoised per version of the code — agents word things
     * differently each run, and an Update over unchanged code must propose nothing.
     */
    analyze?: AnalyzeAsk | undefined;
    /** The agent stage's memo, version, and pool (analysts.ts AnalyzeOptions). */
    analyzeOptions?: Omit<AnalyzeOptions, 'progress'>;
    /**
     * Called at each stage, so a caller can show a lift that takes minutes as it goes:
     * the stage, a sentence on it, and — while analysing — areas done of total.
     */
    progress?: (stage: LiftStage, detail: string, areas?: { done: number; total: number }) => void;
  },
): Promise<LiftResult> {
  const report = opts.progress ?? (() => {});
  // 1. Which files: the reader decides (package.json, app sources, docs), capped so a
  //    large monorepo stays one request's worth of reads. Hitting the cap is said,
  //    never silent — a graph missing a service should come with the reason.
  report('listing', 'Listing the repository.');
  const listed = source.list();
  const { paths: selected, dropped } = selectLiftPathsReport(listed);

  // 2. Load them in one hydration round, then read synchronously into a plain map —
  //    the readers never see a source, only text. A file that was listed but did not
  //    come back (too large to fetch, gone mid-read) is counted, not skipped silently.
  report('reading', `Reading ${selected.length} files.`);
  await source.ensure?.(selected);
  const repo: Record<string, string> = {};
  const unreadable: string[] = [];
  for (const path of selected) {
    const content = source.read(path);
    if (content !== undefined) repo[path] = content;
    else unreadable.push(path);
  }
  const files: FileMap = repo;

  // 3. Deterministic reading: frameworks detected by package.json, then each app read
  //    with the TypeScript compiler API. This alone is a complete, valid result.
  const read = readRepo(files);

  // 3b. Claims (claims.ts): the reader's findings restated as evidence-backed claims,
  //     checked against the code, weighed, and assembled back into a skeleton. Today
  //     the reader is the only voice, so this is lossless by construction (a tested
  //     property); analysts and verifiers add their claims here, and what survives —
  //     with how sure Civil is and why — is what the graph draws.
  const readerClaims = claimsFromSkeleton(read);
  // Analysts read any language, so they (and the evidence checks on their claims) get
  // the other source files too; the reader above saw only what it understands.
  let seen: FileMap = files;
  if (opts.analyze) {
    const extra = analysisPaths(listed, Object.keys(files), LIFT_PATH_CAP);
    await source.ensure?.(extra);
    const more: Record<string, string> = {};
    for (const path of extra) {
      const content = source.read(path);
      if (content !== undefined) more[path] = content;
    }
    seen = { ...files, ...more };
  }
  const analysis = opts.analyze
    ? await analyzeRepository(opts.analyze, seen, listed, readerClaims, read, {
        ...opts.analyzeOptions,
        progress: (done, total) =>
          report('analysing', `Analysts are reading the code: ${done} of ${total} areas done.`, { done, total }),
      })
    : null;
  const beliefs = reconcile([...readerClaims, ...(analysis?.claims ?? [])], seen, new Set(listed));
  const { skeleton: deterministic, provenance, dropped: disbelieved } = toSkeleton(beliefs, read);

  // 4. The project's current civil/ documents, read through the same source, pending
  //    edits included, so an unreviewed earlier lift is what gets merged with rather
  //    than overwritten (step 6) — and so its registry can say what it was read from.
  const existingPaths = listed.filter((path) => path.startsWith('civil/'));
  await source.ensure?.([...existingPaths, 'civil.yaml']);
  const existing: Record<string, string> = {};
  for (const path of existingPaths) {
    const content = source.read(path);
    if (content !== undefined) existing[path] = content;
  }
  const refusal = liftRefusal(existing, listed.includes('civil.yaml') ? source.read('civil.yaml') : undefined);
  if (refusal) throw refusal;
  // civil.yaml may name a composition outside civil/; it is the canvas the author has,
  // so it is what an Update merges into.
  const named = zProject.safeParse(parseYaml(existing['civil/civil.yaml']));
  if (named.success && existing[named.data.spec.composition] === undefined && listed.includes(named.data.spec.composition)) {
    await source.ensure?.([named.data.spec.composition]);
    const content = source.read(named.data.spec.composition);
    if (content !== undefined) existing[named.data.spec.composition] = content;
  }

  // 5. The optional model pass renames, classifies, and describes within what the
  //    reader found — validated, never inventing; any failure falls back to step 3.
  //    It is asked only when what it would be shown changed since the last lift: the
  //    model words things differently each time, so asking again over unchanged code
  //    would turn every Update into a diff of rephrasings. The recorded answer is
  //    re-validated against today's skeleton before it is reused.
  const docs: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (isDoc(path)) docs[path] = content;
  }
  const fingerprint = liftFingerprint(deterministic, docs);
  const previous = readLiftProvenance(existing[REGISTRY_PATH]);
  // Leniently: an entry that no longer fits today's skeleton costs only itself, and the
  // summary is cleaned the way a fresh answer would be.
  const recorded = previous?.refinement ? validateRefinement(previous.refinement, deterministic, { lenient: true }).refinement : null;
  let { skeleton, refinement, note } =
    recorded && previous?.fingerprint === fingerprint
      ? { skeleton: applyRefinement(deterministic, recorded), refinement: recorded, note: null as string | null }
      : (report('refining', 'Naming and describing what was found.'), await refineSkeleton(deterministic, docs, opts.ask));
  // The model was asked and gave nothing usable, but an earlier lift recorded an answer:
  // keep the names, classes and words the author already reviewed rather than falling
  // back to bare ids — a failed call should not undo a reviewed proposal. It is recorded
  // under the old fingerprint, so the next Update asks the model again.
  let recordedFingerprint = fingerprint;
  if (!refinement && recorded) {
    skeleton = applyRefinement(deterministic, recorded);
    refinement = recorded;
    recordedFingerprint = previous!.fingerprint;
    note = `${(note ?? 'The model pass failed.').replace(/; the graph is the reader's deterministic result\.$/, '.')} The answer from the last lift was reused.`;
  }

  // 6. Map to civil/ documents, merging with what the project already has (Update):
  //    the author's node ids, layout, and anything added by hand survive.
  report('writing', 'Writing the documents.');
  const mapped = skeletonToDocuments(skeleton, {
    projectName: opts.projectName,
    existing,
    refinement,
    // The files themselves, so the registry records each one's content hash and the
    // mapper validates paths against what is really there, not just what it named.
    repo: files,
    liftedFrom: { fingerprint: recordedFingerprint, refinement },
    listed,
    // Keyed by the skeleton's ids, which the model pass may have renamed: follow it.
    provenance: Object.fromEntries(
      Object.entries(provenance).map(([id, p]) => [refinement?.renames[id] ?? id, p]),
    ),
  });

  const diagnostics = [...mapped.diagnostics];
  // A service's call into another deployable is real architecture the composition has
  // no edge for yet (service → another server's boundary): said, never silently lost.
  const servers = new Set(skeleton.servers.map((s) => s.id));
  const crossing = skeleton.services.flatMap((s) => s.dependsOn.filter((d) => servers.has(d)).map((d) => `${s.id} → ${d}`));
  if (crossing.length > 0) {
    diagnostics.push(
      `note: ${crossing.length} call${crossing.length === 1 ? '' : 's'} into another deployable found but not drawn ` +
        `(${crossing.slice(0, 6).join(', ')}${crossing.length > 6 ? ', ...' : ''}) — the graph has no edge from a service to another deployable yet.`,
    );
  }
  if (unreadable.length > 0) {
    diagnostics.unshift(
      `warning: ${unreadable.length} selected file${unreadable.length === 1 ? '' : 's'} could not be read ` +
        `(too large to fetch, or gone): ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ', ...' : ''}`,
    );
  }
  // Sample code left out is said, so a missing part of the graph comes with its reason.
  const samples = [
    ...new Set(
      listed
        .filter(isSampleCode)
        .map((p) => {
          const segments = p.split('/');
          const at = segments.findIndex((s, i) => i < segments.length - 1 && isSampleCode(`${segments.slice(0, i + 1).join('/')}/x`));
          return segments.slice(0, at + 2).join('/');
        }),
    ),
  ].sort();
  if (samples.length > 0) {
    diagnostics.push(
      `note: left out ${samples.length} example or sample project${samples.length === 1 ? '' : 's'} ` +
        `(${samples.slice(0, 4).join(', ')}${samples.length > 4 ? ', ...' : ''}) — they show the product rather than being it.`,
    );
  }
  if (dropped > 0) {
    diagnostics.unshift(
      `Read the first ${LIFT_PATH_CAP} matching files; ${dropped} more were left out (the read cap). ` +
        'Code past the cap is not in this graph.',
    );
  }

  return {
    files: mapped.files,
    summary: mapped.summary,
    skeleton,
    diagnostics,
    note,
    filesListed: listed.length,
    filesRead: Object.keys(files).length,
    filesDropped: dropped,
    ...(analysis
      ? { analysis: { ...analysis.report, disbelieved: disbelieved.map((b) => `${b.key} (${[...b.refuters, ...b.issues].join('; ').slice(0, 160)})`) } }
      : {}),
  };
}

/** What the canvas needs to know about reading the repository, for one project. */
export interface LiftStatus {
  /** Why "Generate / Update graph from repo" would be refused here; null when it is offered. */
  refusal: { error: string; message: string } | null;
  /** True when civil/registry.yaml was written by a lift (it records lifted_from). */
  lifted: boolean;
  /**
   * Composition node id → what the lift recorded for it: the repository files that
   * implement it and the model's sentence, when there was one. Only lifted units (role
   * repo); the inspector shows these beside the node.
   */
  units: Record<
    string,
    {
      files: string[];
      description?: string;
      /** How sure Civil is (claims.ts), where in the code it rests, and who said so. */
      confidence?: 'high' | 'medium' | 'low';
      evidence?: string[];
      voices?: string[];
    }
  >;
}

/**
 * The lift's standing on a project, read from its documents through the same source
 * the canvas uses (pending edits included) — so the command is offered or explained,
 * never offered and then refused, and a lifted node can show what it stands for.
 */
export async function liftStatus(source: ProjectSource): Promise<LiftStatus> {
  await source.ensure?.(['civil/civil.yaml', 'civil.yaml', REGISTRY_PATH]);
  const existing: Record<string, string> = {};
  for (const path of ['civil/civil.yaml', REGISTRY_PATH]) {
    const content = source.exists(path) ? source.read(path) : undefined;
    if (content !== undefined) existing[path] = content;
  }
  const named = zProject.safeParse(parseYaml(existing['civil/civil.yaml']));
  if (named.success) {
    await source.ensure?.([named.data.spec.composition]);
    const composition = source.exists(named.data.spec.composition) ? source.read(named.data.spec.composition) : undefined;
    if (composition !== undefined) existing[named.data.spec.composition] = composition;
  }
  const rootCivil = source.exists('civil.yaml') ? source.read('civil.yaml') : undefined;
  const refusal = liftRefusal(existing, rootCivil);

  const units: LiftStatus['units'] = {};
  const registry = parseYaml(existing[REGISTRY_PATH]) as
    | {
        units?: Record<
          string,
          {
            description?: unknown;
            confidence?: unknown;
            evidence?: unknown;
            voices?: unknown;
            files?: Record<string, { role?: unknown } | null>;
          } | null
        >;
      }
    | undefined;
  for (const [unit, entry] of Object.entries(registry?.units ?? {})) {
    if (!unit.startsWith('app/') || !entry) continue;
    const files = Object.entries(entry.files ?? {})
      .filter(([, f]) => f?.role === 'repo')
      .map(([path]) => path)
      .sort();
    if (!files.length) continue;
    units[unit.slice('app/'.length)] = {
      files,
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(entry.confidence === 'high' || entry.confidence === 'medium' || entry.confidence === 'low'
        ? { confidence: entry.confidence }
        : {}),
      ...(Array.isArray(entry.evidence) ? { evidence: entry.evidence.filter((e): e is string => typeof e === 'string') } : {}),
      ...(Array.isArray(entry.voices) ? { voices: entry.voices.filter((v): v is string => typeof v === 'string') } : {}),
    };
  }
  return {
    refusal: refusal ? { error: refusal.code, message: refusal.message } : null,
    lifted: readLiftProvenance(existing[REGISTRY_PATH]) !== undefined,
    units,
  };
}
