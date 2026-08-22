import { createHash } from 'node:crypto';
import type pg from 'pg';
import { parse } from 'yaml';
import { zAgent, zComposition, zGraph } from '@civil/schema';
import { compositionPathFor } from './bundle.js';
import type { ProjectSource } from './source.js';

/**
 * What the transpiler is given, and how the memo knows it has seen it before.
 *
 * docs/emitted-code.md quarantines the LLM's nondeterminism in the analyzer: the
 * transpiler's inputs are versioned files — the civil documents and the pattern
 * prompt — plus the context code emission must import from. Gathering them here,
 * through the same overlay every canvas read uses, is what makes the input hash a
 * statement about the project rather than about one request.
 */

export const PATTERNS_PATH = 'civil/patterns.md';

/** The model does not benefit from a repo dump; sixty referenced files bound it. */
const CONTEXT_FILE_LIMIT = 60;
const CONTEXT_MAX_BYTES = 200 * 1024;

const isCodePath = (path: string): boolean => /\.(py|tsx?|js)$/.test(path);

export interface TranspileInputs {
  /** The civil documents: project config, composition, graphs, agents, prompts. */
  documents: Record<string, string>;
  /** The human-authored code the emitted files import from — real signatures. */
  context: Record<string, string>;
  /** civil/patterns.md as it currently reads, or null when no analysis exists yet. */
  patterns: string | null;
}

/**
 * GET /transpile/meta as the runner answers it: the two things that change the
 * emission without any input file changing. Folded into the hash so a model upgrade
 * or a prompt edit busts the memo instead of replaying stale bytes with confidence.
 */
export interface TranspileMeta {
  model: string;
  promptVersion: string;
}

const parseDoc = (source: ProjectSource, path: string): unknown => {
  const raw = source.read(path);
  if (raw === undefined) return undefined;
  try {
    return parse(raw);
  } catch {
    // A broken document contributes nothing to reference discovery; the validator
    // owns reporting it, and its raw text still travels in `documents`.
    return undefined;
  }
};

/** The static directory a glob starts in, or undefined for a rootless pattern. */
function globPrefix(glob: string): string | undefined {
  const wildcardAt = glob.search(/[*?[]/);
  const prefix = wildcardAt === -1 ? glob : glob.slice(0, wildcardAt);
  const dir = prefix.slice(0, prefix.lastIndexOf('/') + 1);
  return dir.length > 0 ? dir : undefined;
}

/** Reads paths under the caps; a file past the limit or over size contributes nothing. */
async function readCapped(
  source: ProjectSource,
  paths: readonly string[],
): Promise<Record<string, string>> {
  await source.ensure?.(paths);
  const files: Record<string, string> = {};
  for (const path of paths) {
    if (Object.keys(files).length >= CONTEXT_FILE_LIMIT) break;
    const content = source.read(path);
    if (content === undefined) continue;
    if (Buffer.byteLength(content, 'utf8') > CONTEXT_MAX_BYTES) continue;
    files[path] = content;
  }
  return files;
}

export async function gatherInputs(
  source: ProjectSource,
  maintained: ReadonlySet<string>,
): Promise<TranspileInputs> {
  const paths = source.list();

  // civil.yaml decides which file is the composition, so it must be readable
  // before anything else is chosen.
  await source.ensure?.(['civil.yaml', PATTERNS_PATH]);
  const compositionPath = compositionPathFor(source);

  const documentPaths = new Set<string>();
  if (source.exists('civil.yaml')) documentPaths.add('civil.yaml');
  if (source.exists(compositionPath)) documentPaths.add(compositionPath);
  for (const path of paths) {
    if (
      /^graphs\/[^/]+\.ya?ml$/.test(path) ||
      /^agents\/[^/]+\/agent\.ya?ml$/.test(path) ||
      /^agents\/[^/]+\/prompt\.md$/.test(path)
    ) {
      documentPaths.add(path);
    }
  }
  await source.ensure?.([...documentPaths]);

  // Walk the documents for what they reference: include globs and entrypoints name
  // the code the emission must import from, and refs may live outside the
  // conventional layout — the document, not the directory, is the authority. Graphs
  // reach graphs (a service impl names one, a subgraph node refs another), so this
  // is a worklist; the walked set is the cycle guard, and each document parses once
  // however many refs name it.
  const referencedDirs = new Set<string>(['src/']);
  const referencedFiles = new Set<string>();
  const walked = new Set<string>();
  const queue = [...documentPaths].filter((p) => /\.ya?ml$/.test(p));

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (walked.has(path)) continue;
    walked.add(path);
    documentPaths.add(path);
    await source.ensure?.([path]);
    const doc = parseDoc(source, path);
    if (doc === undefined) continue;

    const graph = zGraph.safeParse(doc);
    if (graph.success) {
      for (const node of graph.data.spec.nodes) {
        if (node.type === 'code') {
          if (node.entrypoint) referencedFiles.add(node.entrypoint);
          for (const pattern of node.include) {
            if (!/[*?[]/.test(pattern)) {
              referencedFiles.add(pattern);
              continue;
            }
            const dir = globPrefix(pattern);
            if (dir) referencedDirs.add(dir);
          }
        } else if (node.type === 'agent') {
          documentPaths.add(node.ref);
          await source.ensure?.([node.ref]);
          const agent = zAgent.safeParse(parseDoc(source, node.ref));
          if (agent.success) documentPaths.add(agent.data.spec.promptFile);
        } else if (node.type === 'subgraph') {
          queue.push(node.ref);
        }
      }
      continue;
    }

    const composition = zComposition.safeParse(doc);
    if (composition.success) {
      for (const node of composition.data.spec.nodes) {
        if (node.type !== 'service') continue;
        if ('entrypoint' in node.impl) referencedFiles.add(node.impl.entrypoint);
        else queue.push(node.impl.graph);
      }
    }
  }

  // Maintained paths are Civil's own previous output, not human context: offered as
  // context they would trip the collision validator and forbid re-emitting them.
  const contextPaths = paths
    .filter((p) => isCodePath(p) && !p.startsWith('civil/') && !maintained.has(p))
    .filter(
      (p) => referencedFiles.has(p) || [...referencedDirs].some((dir) => p.startsWith(dir)),
    )
    .sort();
  const context = await readCapped(source, contextPaths);

  await source.ensure?.([...documentPaths]);
  const documents: Record<string, string> = {};
  for (const path of [...documentPaths].sort()) {
    const content = source.read(path);
    if (content !== undefined) documents[path] = content;
  }

  return { documents, context, patterns: source.read(PATTERNS_PATH) ?? null };
}

/**
 * What the pattern analyzer reads: the repo's code, all of it, not the slice
 * emission imports from — conventions live in files no graph references. Civil
 * documents and Civil's own emissions are excluded because the analysis describes
 * the human's conventions, and emitted code would teach the analyzer its own output.
 */
export async function gatherAnalyzerFiles(
  source: ProjectSource,
  maintained: ReadonlySet<string>,
): Promise<Record<string, string>> {
  const paths = source
    .list()
    .filter((p) => isCodePath(p) && !p.startsWith('civil/') && !maintained.has(p))
    .sort();
  return readCapped(source, paths);
}

/**
 * The memo key: sorted path:content pairs of everything the model sees, the pattern
 * prompt, and the runner's fingerprint — the resolved model id and prompt version,
 * as GET /transpile/meta reports them. NUL separators keep "ab"+"c" and "a"+"bc"
 * distinct.
 */
export function inputHash(inputs: TranspileInputs, meta: TranspileMeta): string {
  const hash = createHash('sha256');
  const pairs = [...Object.entries(inputs.documents), ...Object.entries(inputs.context)].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const [path, content] of pairs) {
    hash.update(path).update('\0').update(content).update('\0');
  }
  hash.update(inputs.patterns ?? '').update('\0');
  hash.update(meta.model).update('\0').update(meta.promptVersion);
  return hash.digest('hex');
}

/** The runner's answer, stored whole so a memo hit replays it byte for byte. */
export interface TranspileOutput {
  files: Record<string, string>;
  attempts: number;
}

export async function findMemo(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  hash: string,
): Promise<TranspileOutput | undefined> {
  const { rows } = await pool.query<{ output: TranspileOutput }>(
    `SELECT output FROM transpilations
      WHERE owner_id = $1 AND project_id = $2 AND input_hash = $3`,
    [ownerId, projectId, hash],
  );
  return rows[0]?.output;
}

/**
 * Every path Civil has ever emitted for this project: the union of file keys across
 * its memo rows. This is the interim ownership record until the civil documents
 * carry it (docs/transpilation.md: the civil docs are the record of which files
 * Civil maintains) — excluded from context and from the analyzer's reading so that
 * re-emission is idempotent instead of a collision with "human-owned" files. Silent
 * regeneration over a hand-edited maintained file is accepted for now;
 * mine-or-theirs arrives with commit integration.
 */
export async function maintainedPaths(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
): Promise<Set<string>> {
  const { rows } = await pool.query<{ output: TranspileOutput }>(
    `SELECT output FROM transpilations WHERE owner_id = $1 AND project_id = $2`,
    [ownerId, projectId],
  );
  const paths = new Set<string>();
  for (const { output } of rows) {
    for (const path of Object.keys(output.files)) paths.add(path);
  }
  return paths;
}

export async function storeMemo(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  hash: string,
  output: TranspileOutput,
): Promise<void> {
  await pool.query(
    // Equal hashes mean equal inputs, so a concurrent write is the same answer.
    `INSERT INTO transpilations (owner_id, project_id, input_hash, output)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, input_hash) DO NOTHING`,
    [ownerId, projectId, hash, JSON.stringify(output)],
  );
}

export interface PatternsState {
  /** A handwritten code save happened since the last analysis. */
  stale: boolean;
  /** The commit civil/patterns.md described, or null before the first analysis. */
  head: string | null;
  /** The commit the project is editing against right now. */
  headSha: string | null;
}

export async function patternsState(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
): Promise<PatternsState | undefined> {
  const { rows } = await pool.query<PatternsState>(
    `SELECT patterns_stale AS stale,
            patterns_head  AS head,
            head_sha       AS "headSha"
       FROM projects
      WHERE id = $1 AND owner_id = $2`,
    [projectId, ownerId],
  );
  return rows[0];
}

export async function setPatternsFresh(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  head: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE projects SET patterns_stale = false, patterns_head = $3, updated_at = now()
      WHERE id = $1 AND owner_id = $2`,
    [projectId, ownerId, head],
  );
}

/** One of the analyzer's two triggers: a human wrote code (docs/emitted-code.md). */
export async function markPatternsStale(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
): Promise<void> {
  await pool.query(
    `UPDATE projects SET patterns_stale = true, updated_at = now()
      WHERE id = $1 AND owner_id = $2`,
    [projectId, ownerId],
  );
}
