import { isSampleCode, isTestSupport } from './read.js';
import { claimKey, isEntity, READER, type Claim, type Evidence } from './claims.js';
import type { FileMap, Skeleton } from './skeleton.js';

/**
 * The agent stage of the repo lift (docs/lift-repo.md, "Claims"): the repository is
 * split into areas, an analyst reads each with read-only tools and proposes claims, a
 * verifier checks each analyst's claims, and every claim comes back here to be weighed
 * with the reader's by claims.ts — one set of rules for every voice. The runner does
 * the model work (runner/analyze.py); this side decides what it is asked and never
 * trusts what comes back: claims are re-validated, and a new entity's skeleton fields
 * are filled only from its own evidence and attributes, never invented.
 *
 * Optional, like the model pass: with no runner, or any failure, the reader's claims
 * stand alone and the lift is exactly what it was.
 */

export type AnalyzeAsk = (body: unknown) => Promise<Record<string, unknown>>;

export interface Area {
  id: string;
  title: string;
  /** Path prefixes ("apps/api/src/billing/") — an area may join small siblings. */
  prefixes: string[];
  hint?: string;
}

/** Files an area holds at most before it is split by its subdirectories. */
export const AREA_MAX_FILES = 80;
/** Siblings smaller than this are joined into one area rather than each getting an analyst. */
export const AREA_MIN_FILES = 12;
/** Analysts per lift at most; past it the smallest neighbours are joined. */
export const AREA_LIMIT = 12;

const SOURCE = /\.(ts|tsx|mts|js|jsx|mjs|py|go|rb|java|kt|rs|cs|php)$/;
const INFRA = /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|[^/]+\.tf|cloudbuild[^/]*\.ya?ml|Procfile|fly\.toml|app\.ya?ml|serverless\.ya?ml)$/;
const SKIP = /(^|\/)(node_modules|dist|build|\.git|vendor|coverage|\.next)(\/|$)|\.(spec|test)\.[^/]+$|\.d\.ts$/;

const kebab = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'root';

/**
 * Splits a repository into areas an analyst can read within its budget: by directory,
 * splitting any directory over AREA_MAX_FILES into its subdirectories and joining
 * small siblings, so each analyst gets a coherent slice. Infrastructure files
 * (Dockerfiles, Terraform, deploy manifests) are one area of their own, because they
 * say what is deployed and scheduled. Deterministic: the same files give the same areas.
 */
export function buildAreas(listed: readonly string[]): Area[] {
  const source = listed.filter((p) => SOURCE.test(p) && !SKIP.test(p) && !isTestSupport(p) && !isSampleCode(p)).sort();
  const areas: Area[] = [];

  const split = (prefix: string, paths: string[]): void => {
    if (paths.length <= AREA_MAX_FILES) {
      if (paths.length > 0) areas.push(area([prefix], paths.length));
      return;
    }
    const children = new Map<string, string[]>();
    const loose: string[] = [];
    for (const path of paths) {
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) loose.push(path);
      else {
        const child = `${prefix}${rest.slice(0, slash + 1)}`;
        children.set(child, [...(children.get(child) ?? []), path]);
      }
    }
    // A directory of only one child has nothing to split: descend.
    if (loose.length === 0 && children.size === 1) {
      const [only] = [...children.entries()];
      split(only![0], only![1]);
      return;
    }
    let batch: { prefixes: string[]; count: number } = { prefixes: [], count: 0 };
    const flush = () => {
      if (batch.count > 0) areas.push(area(batch.prefixes, batch.count));
      batch = { prefixes: [], count: 0 };
    };
    for (const [child, childPaths] of [...children.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (childPaths.length > AREA_MAX_FILES) {
        flush();
        split(child, childPaths);
      } else if (childPaths.length < AREA_MIN_FILES || batch.count + childPaths.length <= AREA_MIN_FILES * 2) {
        if (batch.count + childPaths.length > AREA_MAX_FILES) flush();
        batch.prefixes.push(child);
        batch.count += childPaths.length;
      } else {
        flush();
        areas.push(area([child], childPaths.length));
      }
    }
    flush();
    // Files directly in the directory (an app's main.ts, a package's index) travel
    // with the first area under it, where an analyst will look for an entry point.
    if (loose.length > 0) {
      const home = areas.find((a) => a.prefixes.some((p) => p.startsWith(prefix)));
      if (home) home.prefixes.push(...loose);
      else areas.push(area(loose, loose.length));
    }
  };

  const area = (prefixes: string[], count: number): Area => {
    const main = prefixes[0]!;
    const title = prefixes.length === 1 ? main : `${main} (+${prefixes.length - 1} more)`;
    return { id: '', title, prefixes, hint: `${count} source files.` };
  };

  split('', source);

  // Join the smallest neighbours until the limit holds.
  while (areas.length > AREA_LIMIT) {
    let best = 0;
    for (let i = 1; i < areas.length - 1; i += 1) {
      const size = (a: Area) => Number(/^(\d+)/.exec(a.hint ?? '')?.[1] ?? 0);
      if (size(areas[i]!) + size(areas[i + 1]!) < size(areas[best]!) + size(areas[best + 1]!)) best = i;
    }
    const [a, b] = [areas[best]!, areas[best + 1]!];
    const count = Number(/^(\d+)/.exec(a.hint ?? '')?.[1] ?? 0) + Number(/^(\d+)/.exec(b.hint ?? '')?.[1] ?? 0);
    areas.splice(best, 2, { id: '', title: `${a.title} + ${b.title}`, prefixes: [...a.prefixes, ...b.prefixes], hint: `${count} source files.` });
  }

  const infra = listed.filter((p) => INFRA.test(p) && !SKIP.test(p) && !isSampleCode(p)).sort();
  if (infra.length > 0) {
    areas.push({
      id: '',
      title: 'Infrastructure and deployment',
      prefixes: infra,
      hint: 'What is deployed as which process, and what runs on a schedule. Claim servers and processes from here; services live in the code areas.',
    });
  }

  const taken = new Set<string>();
  return areas.map((a) => {
    let id = kebab(a.title.replace(/\s*\(\+\d+ more\)$/, '').replace(/\/$/, '').split('/').slice(-2).join('-'));
    for (let n = 2; taken.has(id); n += 1) id = `${kebab(a.title).slice(0, 40)}-${n}`;
    taken.add(id);
    return { ...a, id };
  });
}

/**
 * Files analysts read beyond what the reader loaded: the reader reads only the
 * frameworks it knows (TypeScript today), but an analyst reads any language, so every
 * other source and infrastructure file is offered too — within the same overall cap,
 * the reader's own selection first.
 */
export function analysisPaths(listed: readonly string[], selected: readonly string[], cap: number): string[] {
  const have = new Set(selected);
  return listed
    .filter((p) => !have.has(p) && (SOURCE.test(p) || INFRA.test(p)) && !SKIP.test(p) && !isTestSupport(p) && !isSampleCode(p))
    .sort()
    .slice(0, Math.max(0, cap - selected.length));
}

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const KINDS = new Set(['server', 'client', 'service', 'agent', 'process', 'datastore', 'depends-on', 'exposes', 'calls', 'uses-agent']);

/**
 * What the runner answered, re-validated: never trusted, because a claim that enters
 * claims.ts is weighed as a voice. Shape only — evidence is checked against the code
 * by claims.ts itself. A voice may not speak as the reader.
 */
export function validateAnswer(answer: Record<string, unknown>, listed: ReadonlySet<string>): { claims: Claim[]; issues: string[] } {
  const claims: Claim[] = [];
  const issues: string[] = [];
  const raw = Array.isArray(answer['claims']) ? answer['claims'] : [];
  for (const item of raw as Record<string, unknown>[]) {
    const kind = item?.['kind'];
    const subject = item?.['subject'];
    const object = item?.['object'];
    const by = item?.['by'];
    if (typeof kind !== 'string' || !KINDS.has(kind) || typeof subject !== 'string' || !ID.test(subject)) {
      issues.push(`malformed claim: ${JSON.stringify(item).slice(0, 100)}`);
      continue;
    }
    if (typeof by !== 'string' || by === READER || !/^(analyst|verifier):/.test(by)) {
      issues.push(`${kind}:${subject}: voice ${String(by)} is not an analyst or verifier`);
      continue;
    }
    const relation = !isEntity(kind as Claim['kind']);
    if (relation && (typeof object !== 'string' || !ID.test(object))) {
      issues.push(`${kind}:${subject}: a relation needs an object`);
      continue;
    }
    const evidence = (Array.isArray(item['evidence']) ? item['evidence'] : [])
      .filter((ev): ev is Evidence => typeof ev?.file === 'string' && listed.has(ev.file))
      .map((ev) => ({
        file: ev.file,
        ...(Number.isInteger(ev.line) && ev.line! > 0 ? { line: ev.line } : {}),
        ...(typeof ev.quote === 'string' && ev.quote ? { quote: ev.quote.slice(0, 200) } : {}),
      }));
    if (evidence.length === 0) {
      issues.push(`${kind}:${subject}: no evidence in the repository`);
      continue;
    }
    const attrs = item['attrs'];
    claims.push({
      kind: kind as Claim['kind'],
      subject,
      ...(relation ? { object: object as string } : {}),
      ...(attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !relation ? { attrs: attrs as Record<string, unknown> } : {}),
      evidence,
      by,
      stance: item['stance'] === 'refute' ? 'refute' : 'assert',
      ...(typeof item['note'] === 'string' && item['note'] ? { note: item['note'].slice(0, 300) } : {}),
    });
  }
  return { claims, issues };
}

const pascal = (id: string): string => id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

/**
 * Fills a new entity's skeleton fields from what its own claim carries — the files it
 * names, its first piece of evidence as its source — so claims.ts can assemble it.
 * Only for entities the reader did not find: for those it did, the reader's exact
 * fields win and an analyst's attributes only add. Nothing is invented: a process
 * whose schedule no voice gave says so ("@unknown") rather than guessing a cron.
 */
export function normalizeClaims(claims: readonly Claim[], reader: Skeleton): Claim[] {
  const known = new Set([
    ...reader.servers.map((e) => `server:${e.id}`),
    ...reader.clients.map((e) => `client:${e.id}`),
    ...reader.services.map((e) => `service:${e.id}`),
    ...reader.agents.map((e) => `agent:${e.id}`),
    ...reader.processes.map((e) => `process:${e.id}`),
    ...(reader.datastores ?? []).map((e) => `datastore:${e.id}`),
  ]);
  const onlyServer = reader.servers.length === 1 ? reader.servers[0]!.id : undefined;
  return claims.map((claim) => {
    if (!isEntity(claim.kind) || claim.stance !== 'assert' || known.has(claimKey(claim))) return claim;
    const attrs = claim.attrs ?? {};
    const first = claim.evidence[0]!;
    const source = { file: first.file, ...(first.line ? { line: first.line } : {}) };
    const files = strings(attrs['files']);
    const directory = files.find((f) => f.endsWith('/**'))?.slice(0, -3);
    const plainFiles = files.filter((f) => !f.endsWith('/**'));
    const filled: Record<string, unknown> = (() => {
      switch (claim.kind) {
        case 'server':
          return { path: typeof attrs['path'] === 'string' ? attrs['path'] : first.file.split('/').slice(0, -1).join('/'), framework: attrs['framework'] ?? 'unknown', globalPrefix: null, routes: [], source };
        case 'client':
          return { path: typeof attrs['path'] === 'string' ? attrs['path'] : first.file.split('/').slice(0, -1).join('/'), framework: attrs['framework'] ?? 'unknown', devScript: null, source };
        case 'service':
          return {
            server: typeof attrs['server'] === 'string' ? attrs['server'] : (onlyServer ?? 'server'),
            moduleClass: typeof attrs['label'] === 'string' ? attrs['label'] : pascal(claim.subject),
            source,
            controllers: [],
            providers: [],
            infrastructure: false,
            files: plainFiles.length > 0 ? plainFiles : [first.file],
            ...(directory ? { directory } : {}),
          };
        case 'agent':
          return {
            files: plainFiles.length > 0 ? plainFiles : [first.file],
            tools: Array.isArray(attrs['tools'])
              ? (attrs['tools'] as { name?: unknown; file?: unknown }[])
                  .filter((t) => typeof t?.name === 'string' && typeof t?.file === 'string')
                  .map((t) => ({ name: t.name as string, file: t.file as string }))
              : [],
            source,
          };
        case 'datastore':
          return { engine: typeof attrs['engine'] === 'string' && attrs['engine'] ? attrs['engine'].toLowerCase() : null, source };
        default:
          return { schedule: typeof attrs['schedule'] === 'string' && attrs['schedule'] ? attrs['schedule'] : '@unknown', source };
      }
    })();
    return { ...claim, attrs: { ...attrs, ...filled } };
  });
}

/**
 * Entity resolution: the same thing named twice is one thing. Independent voices name
 * what they find independently — one analyst's "runner" is another's "civil-runner" —
 * and left alone that draws a duplicate and drops every relation that used the other
 * name (found on a real repository, 2026-10-11). So before weighing, each entity a
 * voice proposes is anchored in the code — the path, files, and first piece of evidence
 * it names — and a new name whose anchors fall within an earlier entity's of the same
 * kind becomes an alias of it. The reader's names win, then the earliest voice's; an
 * entity matching two others equally is ambiguous and left as it is, never guessed.
 * Location alone decides only for deployables (servers, clients): two cannot live at
 * one path. Services, agents, and processes can share a file — two agents defined side
 * by side are two agents — so for them the names must also be related, one containing
 * the other as a whole word ("runner" and "civil-runner"), before they are merged.
 *
 * A relation may name an end nobody claimed ("web calls api" where the server is
 * "civil-api"): it is matched by name only when exactly one entity contains it as a
 * whole word; otherwise it stays unknown and claims.ts drops the line.
 */
export function resolveEntities(claims: readonly Claim[], reader: Skeleton): { claims: Claim[]; aliases: Record<string, string> } {
  interface Canon { kind: string; id: string; anchors: string[] }
  const canon: Canon[] = [];
  const dirOf = (file: string) => file.split('/').slice(0, -1).join('/');
  const norm = (paths: readonly unknown[]) =>
    paths.filter((p): p is string => typeof p === 'string' && p.length > 0).map((p) => p.replace(/\/\*\*$/, '').replace(/\/$/, ''));
  const add = (kind: string, id: string, anchors: string[]) => canon.push({ kind, id, anchors: [...new Set(anchors)] });

  for (const s of reader.servers) add('server', s.id, norm([s.path, s.source.file]));
  for (const c of reader.clients) add('client', c.id, norm([c.path, c.source.file]));
  for (const s of reader.services) add('service', s.id, norm([s.source.file, ...(s.files ?? []), ...s.controllers.map((x) => x.file), ...s.providers.map((x) => x.file), ...(s.directory ? [s.directory] : [])]));
  for (const a of reader.agents) add('agent', a.id, norm([a.source.file, ...a.files]));
  for (const p of reader.processes) add('process', p.id, norm([p.source.file]));
  for (const d of reader.datastores ?? []) add('datastore', d.id, norm([d.source.file]));

  /** a lies within b: the same path, or under one of b's directories. */
  const within = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || (b.includes('.') && dirOf(b) === a);
  const score = (anchors: string[], target: Canon) => anchors.filter((a) => target.anchors.some((b) => within(a, b) || within(b, a))).length;

  const aliases: Record<string, string> = {};
  for (const claim of claims) {
    if (!isEntity(claim.kind) || claim.stance !== 'assert') continue;
    if (aliases[claim.subject] || canon.some((c) => c.kind === claim.kind && c.id === claim.subject)) continue;
    const attrs = claim.attrs ?? {};
    const anchors = norm([attrs['path'], ...strings(attrs['files']), claim.evidence[0]?.file]);
    const deployable = claim.kind === 'server' || claim.kind === 'client';
    const related = (a: string, b: string) => {
      const words = (id: string) => new Set(id.split(/[-_]/));
      const [wa, wb] = [words(a), words(b)];
      return [...wa].every((w) => wb.has(w)) || [...wb].every((w) => wa.has(w));
    };
    const ranked = canon
      .filter((c) => c.kind === claim.kind && (deployable || related(c.id, claim.subject)))
      .map((c) => ({ c, n: score(anchors, c) }))
      .filter((r) => r.n > 0)
      .sort((x, y) => y.n - x.n);
    if (ranked.length > 0 && (ranked.length === 1 || ranked[0]!.n > ranked[1]!.n)) {
      aliases[claim.subject] = ranked[0]!.c.id;
    } else if (ranked.length === 0) {
      add(claim.kind, claim.subject, anchors);
    }
  }

  const ids = new Set([...canon.map((c) => c.id)]);
  const byName = (name: string): string | undefined => {
    if (ids.has(name)) return name;
    const word = new RegExp(`(^|-)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-|$)`);
    const hits = [...ids].filter((id) => word.test(id));
    return hits.length === 1 ? hits[0] : undefined;
  };
  const resolve = (id: string, relationEnd: boolean): string => aliases[id] ?? (relationEnd ? byName(id) ?? id : id);

  return {
    aliases,
    claims: claims.map((claim) => {
      const relation = !isEntity(claim.kind);
      const subject = resolve(claim.subject, relation);
      const object = claim.object === undefined ? undefined : resolve(claim.object, true);
      if (subject === claim.subject && object === claim.object) return claim;
      return { ...claim, subject, ...(object !== undefined ? { object } : {}) };
    }),
  };
}

export interface AnalysisReport {
  areas: number;
  claims: number;
  /** By voice kind: how many claims analysts and verifiers made. */
  analystClaims: number;
  verifierClaims: number;
  issues: string[];
  note: string | null;
  /** Names a voice used for something already named: proposed → canonical. */
  aliases?: Record<string, string>;
}

/**
 * Asks the runner's analysts and verifiers about the repository and returns their
 * claims, validated and normalised, ready to be weighed with the reader's. Any failure
 * returns no claims and a note — the lift continues on the reader's word alone.
 */
export async function analyzeRepository(
  ask: AnalyzeAsk | undefined,
  files: FileMap,
  listed: readonly string[],
  readerClaims: readonly Claim[],
  reader: Skeleton,
): Promise<{ claims: Claim[]; report: AnalysisReport }> {
  const empty = (note: string): { claims: Claim[]; report: AnalysisReport } => ({
    claims: [],
    report: { areas: 0, claims: 0, analystClaims: 0, verifierClaims: 0, issues: [], note },
  });
  if (!ask) return empty('Agent analysis was skipped: no runner is configured.');
  // Sample code is another project: analysts neither read it nor may cite it.
  const product = listed.filter((p) => !isSampleCode(p));
  const areas = buildAreas(product);
  if (areas.length === 0) return empty('Agent analysis was skipped: no source files to read.');
  let answer: Record<string, unknown>;
  try {
    answer = await ask({
      files: Object.fromEntries(Object.entries(files).filter(([p]) => !isSampleCode(p))),
      index: product,
      claims: readerClaims,
      areas,
    });
  } catch (error) {
    return empty(`Agent analysis failed (${(error as Error).message}); the reader's findings stand alone.`);
  }
  const { claims, issues } = validateAnswer(answer, new Set(product));
  const { claims: resolved, aliases } = resolveEntities(claims, reader);
  const normalized = normalizeClaims(resolved, reader);
  return {
    claims: normalized,
    report: {
      areas: areas.length,
      claims: normalized.length,
      analystClaims: normalized.filter((c) => c.by.startsWith('analyst:')).length,
      verifierClaims: normalized.filter((c) => c.by.startsWith('verifier:')).length,
      issues,
      note: null,
      aliases,
    },
  };
}
