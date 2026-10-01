import { createHash } from 'node:crypto';
import { Document, parse } from 'yaml';
import { zComposition, zGraph, type Composition, type Graph } from '@civil/schema';
import type { ProjectSource } from './source.js';
import type { TranspileOutput } from './transpile.js';

/**
 * civil/registry.yaml: Civil's record of what the application is — its units, the
 * files each one became, and what each depends on. Maintained by Civil, never
 * authored: it is rebuilt deterministically on every transpile from the documents
 * and the emission, and committed beside the code it describes, so the repo stays
 * self-describing (the repo is the truth) and a human or an agent can read the app's
 * architecture from one file.
 *
 * The unit is the grain every later step works at: which files an edit touches
 * (partial regeneration), whether a file was hand-edited (its hash), and how the
 * app is exercised end to end.
 */

export const REGISTRY_PATH = 'civil/registry.yaml';

/** The one label outside the derived list, for plumbing that serves several units. */
export const SHARED_UNIT = 'shared';

export type UnitKind = 'client' | 'boundary' | 'service' | 'process' | 'graph' | 'agent';

export interface Unit {
  /**
   * Namespaced so ids from the two altitudes never collide: app/<node> for a
   * composition node, graph/<graph id> for a graph's orchestration, and
   * graph/<graph id>/<node> for an agent inside it.
   */
  id: string;
  kind: UnitKind;
  /** The civil document that defines it. */
  source: string;
  /** Units whose interfaces this one uses, sorted. */
  dependsOn: string[];
  /** A boundary's surface; only an api boundary emits a server and a client. */
  boundary?: 'api' | 'mcp';
  /** A function-backed service's human-authored handler. */
  entrypoint?: string;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const parseSafely = (text: string): unknown => {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
};

/**
 * The units the documents define. Pure over the same document map the transpiler
 * sees, so the list the model is asked to label against and the list the registry is
 * written from can never disagree. A document that does not parse contributes
 * nothing — validation reports it elsewhere; the registry records what exists.
 */
export function deriveUnits(documents: Record<string, string>): Unit[] {
  const graphs = new Map<string, Graph>();
  let composition: { path: string; doc: Composition } | undefined;
  for (const path of Object.keys(documents).sort(byString)) {
    const raw = parseSafely(documents[path]!);
    const graph = zGraph.safeParse(raw);
    if (graph.success) {
      graphs.set(path, graph.data);
      continue;
    }
    const comp = zComposition.safeParse(raw);
    if (comp.success && !composition) composition = { path, doc: comp.data };
  }

  const graphUnitFor = (path: string): string | undefined => {
    const graph = graphs.get(path);
    return graph ? `graph/${graph.metadata.id}` : undefined;
  };

  const units: Unit[] = [];

  if (composition) {
    const { path, doc } = composition;
    const routesFrom = (id: string) =>
      doc.spec.edges
        .filter((e) => e.kind === 'routes-to' && e.from.node === id)
        .map((e) => `app/${e.to.node}`);
    for (const node of doc.spec.nodes) {
      const unit: Unit = { id: `app/${node.id}`, kind: node.type, source: path, dependsOn: [] };
      switch (node.type) {
        case 'client':
          unit.dependsOn = routesFrom(node.id);
          break;
        case 'boundary':
          unit.boundary = node.boundary;
          unit.dependsOn = node.exposes.map((s) => `app/${s}`);
          break;
        case 'service':
          if ('graph' in node.impl) {
            const graphUnit = graphUnitFor(node.impl.graph);
            if (graphUnit) unit.dependsOn = [graphUnit];
          } else {
            unit.entrypoint = node.impl.entrypoint;
          }
          break;
        case 'process':
          unit.dependsOn = node.calls.map((s) => `app/${s}`);
          break;
      }
      units.push(unit);
    }
  }

  for (const [path, graph] of graphs) {
    const id = `graph/${graph.metadata.id}`;
    const dependsOn: string[] = [];
    for (const node of graph.spec.nodes) {
      if (node.type === 'agent') {
        dependsOn.push(`${id}/${node.id}`);
        units.push({ id: `${id}/${node.id}`, kind: 'agent', source: path, dependsOn: [] });
      } else if (node.type === 'subgraph') {
        const sub = graphUnitFor(node.ref);
        if (sub) dependsOn.push(sub);
      }
    }
    units.push({ id, kind: 'graph', source: path, dependsOn });
  }

  for (const unit of units) unit.dependsOn = [...new Set(unit.dependsOn)].sort(byString);
  return units.sort((a, b) => byString(a.id, b.id));
}

/** Enough to notice a file changed under Civil; not a security property. */
const contentHash = (content: string): string =>
  `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 16)}`;

/**
 * The registry document, byte-stable for the same inputs: units and files sorted,
 * no timestamps, so it changes in a diff only when the application did. The
 * registry never lists itself.
 */
export function buildRegistry(
  units: readonly Unit[],
  output: TranspileOutput,
  generatedFrom: string,
): string {
  const filesOf = (unitId: string) => {
    const entries: Record<string, { role: string; hash: string }> = {};
    for (const path of Object.keys(output.files).sort(byString)) {
      if (path === REGISTRY_PATH || output.units[path] !== unitId) continue;
      entries[path] = { role: output.roles[path] ?? 'other', hash: contentHash(output.files[path]!) };
    }
    return entries;
  };

  const body: Record<string, unknown> = {
    apiVersion: 'civil/v1',
    kind: 'Registry',
    // The sketch this code was generated from (sketchFingerprint). When the project's
    // current fingerprint differs, the sketch has changes not yet applied.
    generated_from: generatedFrom,
    units: Object.fromEntries(
      units.map((unit) => {
        const files = filesOf(unit.id);
        const entry: Record<string, unknown> = { kind: unit.kind, source: unit.source };
        if (unit.boundary) entry['boundary'] = unit.boundary;
        if (unit.entrypoint) entry['entrypoint'] = unit.entrypoint;
        if (unit.dependsOn.length > 0) entry['depends_on'] = unit.dependsOn;
        if (Object.keys(files).length > 0) entry['files'] = files;
        return [unit.id, entry];
      }),
    ),
  };
  const shared = filesOf(SHARED_UNIT);
  if (Object.keys(shared).length > 0) body['shared'] = { files: shared };

  const doc = new Document(body);
  doc.commentBefore =
    ' Maintained by Civil — rebuilt on every transpile from the civil documents and\n' +
    ' the emitted code. Edits here are overwritten; change the canvas instead.';
  return doc.toString({ lineWidth: 0 });
}

/**
 * Writes the registry into an emission: files first labelled (the generated web
 * client belongs to the api boundary when there is exactly one — it spans them all
 * otherwise), then the document itself, as a maintained file like any other.
 */
export function attachRegistry(
  output: TranspileOutput,
  units: readonly Unit[],
  generatedFrom: string,
): void {
  const apiBoundaries = units.filter((u) => u.boundary === 'api');
  for (const path of Object.keys(output.roles)) {
    if (output.roles[path] === 'boundary-client') {
      output.units[path] = apiBoundaries.length === 1 ? apiBoundaries[0]!.id : SHARED_UNIT;
    }
  }
  delete output.files[REGISTRY_PATH];
  output.files[REGISTRY_PATH] = buildRegistry(units, output, generatedFrom);
  output.roles[REGISTRY_PATH] = 'registry';
  output.units[REGISTRY_PATH] = SHARED_UNIT;
}

/**
 * Whether the sketch has changes the generated code does not reflect yet — what the
 * Apply changes button shows. `never`: nothing has been generated (no registry, or
 * one from before generated_from existed); `stale`: the sketch moved since; `current`.
 */
export type ApplyState = 'never' | 'stale' | 'current';

export function applyState(source: ProjectSource, fingerprint: string): ApplyState {
  const raw = source.read(REGISTRY_PATH);
  const doc = raw === undefined ? undefined : (parseSafely(raw) as { generated_from?: unknown } | undefined);
  if (!doc || typeof doc.generated_from !== 'string') return 'never';
  return doc.generated_from === fingerprint ? 'current' : 'stale';
}

/** A file Civil generated before, as the registry records it — what a revision edits. */
export interface CurrentFile {
  path: string;
  unit: string;
  role: string;
  content: string;
}

/** Generated API-side, never by the model, so never offered to it for revision. */
const NOT_REVISABLE = new Set(['boundary-client', 'registry']);

/** The same ceiling context files have: a revision prompt stays proportionate. */
const CURRENT_MAX_BYTES = 200 * 1024;

/**
 * The current generated code, located through the registry and read from the
 * project as it stands (HEAD plus pending) — so a hand edit made outside Civil is
 * what gets revised, not what Civil last wrote. No registry yet (a project's first
 * transpile, or one last transpiled before the registry existed) means no current
 * code: the transpiler writes fresh, exactly as before.
 */
export async function currentEmission(source: ProjectSource): Promise<CurrentFile[]> {
  await source.ensure?.([REGISTRY_PATH]);
  const raw = source.read(REGISTRY_PATH);
  if (raw === undefined) return [];
  const doc = parseSafely(raw) as
    | { units?: Record<string, { files?: Record<string, { role?: unknown }> }>; shared?: { files?: Record<string, { role?: unknown }> } }
    | undefined;
  if (!doc || typeof doc !== 'object') return [];

  const listed: { path: string; unit: string; role: string }[] = [];
  const collect = (unit: string, files: unknown) => {
    if (!files || typeof files !== 'object') return;
    for (const [path, entry] of Object.entries(files as Record<string, { role?: unknown }>)) {
      const role = typeof entry?.role === 'string' ? entry.role : 'other';
      if (!NOT_REVISABLE.has(role)) listed.push({ path, unit, role });
    }
  };
  for (const [unit, entry] of Object.entries(doc.units ?? {})) collect(unit, entry?.files);
  collect(SHARED_UNIT, doc.shared?.files);

  await source.ensure?.(listed.map((f) => f.path));
  const current: CurrentFile[] = [];
  for (const file of listed.sort((a, b) => byString(a.path, b.path))) {
    const content = source.read(file.path);
    // Gone from the project (deleted by hand): nothing to revise; the unit writes anew.
    if (content === undefined || Buffer.byteLength(content, 'utf8') > CURRENT_MAX_BYTES) continue;
    current.push({ ...file, content });
  }
  return current;
}
