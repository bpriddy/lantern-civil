import { parse } from 'yaml';
import { MemoryFiles, validateProject, zProject, type Diagnostic } from '@civil/schema';
import { applyOps } from '../manifest/apply.js';
import { readManifest, applySplices } from '../manifest/document.js';
import { deriveUnits, REGISTRY_PATH } from '../project/registry.js';
import { architectureMarkdown, infraFiles } from './documents-architecture.js';
import {
  matchNodes,
  planMerge,
  readCanvas,
  readPreviousRegistry,
  type DesiredNode,
  type ExistingCanvas,
  type MergePlan,
  type WantedNode,
} from './documents-merge.js';
import {
  buildModel,
  columnLayout,
  COMPOSITION_PATH,
  edgeIdFor,
  GRAPHS_DIR,
  idAllocator,
  sortedUnique,
  toId,
  type ModelEdge,
  type ModelGraph,
  type ModelNode,
} from './documents-model.js';
import { compositionYaml, graphYaml, projectYaml } from './documents-yaml.js';
import { LIFT_ROLE, liftRegistry, readLiftProvenance, type LiftProvenance } from './documents-registry.js';
import type { FileMap, Refinement, Skeleton } from './skeleton.js';

/**
 * The skeleton becomes Civil's own documents (docs/lift-repo.md): civil/civil.yaml,
 * the composition, a graph per agent-backed service, civil/registry.yaml recording the
 * repository's files as each unit's implementation, and civil/architecture.md.
 *
 * Pure: the skeleton, the refinement, and the civil/ files the project already has go
 * in; document text comes out. The caller lands it as pending changes the author
 * reviews in the diff panel — nothing here writes, and nothing is applied that the
 * author has not seen.
 *
 * First lift and Update are one call. With no existing documents they are written
 * fresh (documents-yaml.ts); with existing ones the lift is merged into them as ops,
 * keeping the author's ids, layout, and additions (documents-merge.ts has the rules).
 * Either way the output is byte-stable: the same inputs give the same bytes, so an
 * Update with nothing new in the repository is no diff at all.
 *
 * Every document must validate against @civil/schema with zero errors; the validator
 * runs here over the result and anything it says is returned in `diagnostics`, so a
 * mapping mistake is reported rather than landed silently.
 */

export const PROJECT_PATH = 'civil/civil.yaml';
export const ARCHITECTURE_PATH = 'civil/architecture.md';

/** Edge ids are their ends joined by a verb that says the relation. */
const COMPOSITION_VERBS: Record<string, string> = { 'routes-to': 'to', 'depends-on': 'needs' };
const GRAPH_VERBS: Record<string, string> = { flow: 'to', capability: 'uses' };

export interface DocumentsOptions {
  projectName: string;
  /** The project's current civil/ files, path → content. Empty on a first lift. */
  existing: FileMap;
  refinement: Refinement | null;
  /**
   * The repository files the reader read, when the caller has them (an additive
   * option: liftRepository holds exactly this map). With it, registry entries carry
   * content hashes and validation checks paths against the real files; without it,
   * entries carry the role alone and validation checks against the files the skeleton
   * names.
   */
  repo?: FileMap;
  /**
   * What this lift was read from, recorded in the registry so the next Update can tell
   * whether the code changed (an additive option; see LiftProvenance).
   */
  liftedFrom?: LiftProvenance;
  /**
   * Every path in the project (an additive option: liftRepository has the listing).
   * Validation checks the documents' paths against these, so a reference to a file the
   * lift did not load (a JSON schema, a Python module) is not reported as missing.
   */
  listed?: readonly string[];
}

export interface DocumentsResult {
  files: Record<string, string>;
  summary: string;
  diagnostics: string[];
}

type Node = Record<string, unknown>;

const parseSafely = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return parse(text);
  } catch {
    return undefined;
  }
};

const list = (ids: readonly string[]): string => ids.join(', ');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Every file the skeleton names — what validation checks against without the repo map. */
function namedFiles(skeleton: Skeleton): string[] {
  const out: string[] = [];
  for (const c of skeleton.clients) out.push(c.source.file);
  for (const s of skeleton.servers) out.push(s.source.file, ...s.routes.map((r) => r.source.file));
  for (const s of skeleton.services) {
    out.push(s.source.file, ...s.controllers.map((c) => c.file), ...s.providers.map((p) => p.file));
  }
  for (const a of skeleton.agents) out.push(a.source.file, ...a.files, ...a.tools.map((t) => t.file));
  for (const p of skeleton.processes) out.push(p.source.file);
  return out;
}

/**
 * civil.yaml: written fresh, or — when the project has one — kept byte for byte except
 * `spec.language`, which the lift owns: the repository's TypeScript is the
 * implementation, and that is what tells Apply not to generate Python beside it. Only
 * a server makes that so — a repository whose only app is a Vite client has nothing
 * Apply would generate beside it, so the language is left as it was. And when the
 * composition it names is not one the project has, it is pointed at the one written.
 */
function projectDocument(
  existing: string | undefined,
  id: string,
  name: string,
  compositionPath: string,
  typescript: boolean,
): string {
  if (existing === undefined || !zProject.safeParse(parseSafely(existing)).success) {
    return projectYaml(id, name, compositionPath, typescript);
  }
  let text = existing;
  const named = readManifest(text).doc.getIn(['spec', 'composition'], true) as { value?: unknown; range?: [number, number, number] } | undefined;
  if (named?.range && named.value !== compositionPath) {
    text = applySplices(text, [{ start: named.range[0], end: named.range[1], text: compositionPath }]);
  }
  if (!typescript) return text;
  return withTypescript(text);
}

function withTypescript(existing: string): string {
  const manifest = readManifest(existing);
  const language = manifest.doc.getIn(['spec', 'language'], true) as { value?: unknown; range?: [number, number, number] } | undefined;
  if (language?.value === 'typescript') return existing;
  if (language?.range) {
    return applySplices(existing, [{ start: language.range[0], end: language.range[1], text: 'typescript' }]);
  }
  // No language line at all (it defaults to python): add one under spec, in the
  // column of the key before it.
  const composition = manifest.doc.getIn(['spec', 'composition'], true) as { range?: [number, number, number] } | undefined;
  if (composition?.range) {
    const lineEnd = existing.indexOf('\n', composition.range[1]);
    const at = lineEnd === -1 ? existing.length : lineEnd;
    const lineStart = existing.lastIndexOf('\n', composition.range[0]) + 1;
    const indent = /^\s*/.exec(existing.slice(lineStart))?.[0] ?? '  ';
    return applySplices(existing, [{ start: at, end: at, text: `\n${indent}language: typescript` }]);
  }
  manifest.doc.setIn(['spec', 'language'], 'typescript');
  return manifest.doc.toString();
}

interface CanvasOutcome {
  text: string;
  ids: Map<string, string>;
  plan: MergePlan | null;
}

/**
 * One canvas — the composition or a graph — written fresh or merged. The shared part
 * of both: match the lift's nodes to the existing ones, map every id the lift says to
 * the documents' ids, then either render or plan ops.
 */
function canvas(opts: {
  kind: 'Composition' | 'Graph';
  existingText: string | undefined;
  wanted: readonly (WantedNode & { node: Node; column: number })[];
  edges: readonly ModelEdge[];
  previous: ReadonlyMap<string, ReadonlySet<string>>;
  unitOf: (id: string) => string;
  sameCode: (existing: Node, wanted: WantedNode & { node: Node }) => boolean;
  /** Builds the desired node, given the final id map. */
  desire: (wanted: WantedNode & { node: Node }, ids: ReadonlyMap<string, string>, existing: Node | undefined) => Omit<DesiredNode, 'at'>;
  wasLifted: (node: Node) => boolean;
  render: (nodes: Node[], edges: Node[], layout: Map<string, { x: number; y: number }>) => string;
  verbs: Record<string, string>;
  diagnostics: string[];
  path: string;
  /** Units an earlier Update found removed by the author (lifted_from.removed). */
  removed: ReadonlySet<string>;
}): CanvasOutcome & { existing: ExistingCanvas | undefined; removed: string[] } {
  const existing = readCanvas(opts.existingText, opts.kind);
  if (opts.existingText !== undefined && !existing) {
    opts.diagnostics.push(`warning: ${opts.path} could not be read as a ${opts.kind}; it is rewritten from the repository — review its diff`);
  }
  const byLiftId = new Map(opts.wanted.map((w) => [w.id, w]));
  const deleted = new Map<string, string[]>();
  const ids = matchNodes(
    existing,
    opts.wanted,
    opts.previous,
    {
      compatible: (e, w) => e['type'] === w.type && compatibleSurface(e, byLiftId.get(w.id)!.node),
      unitOf: opts.unitOf,
      sameCode: (e, w) => opts.sameCode(e, byLiftId.get(w.id)!),
      isUnit: (w) => opts.kind === 'Composition' || w.type === 'agent',
    },
    deleted,
    opts.removed,
  );

  // What the author removed stays removed: not written, not an edge end, not in any
  // boundary's exposes or process's calls.
  const gone = new Set([...deleted.keys()].map((id) => ids.get(id)!));
  const wanted = opts.wanted.filter((w) => !deleted.has(w.id));
  const fresh = columnLayout(wanted.map((w) => ({ id: ids.get(w.id)!, column: w.column })));
  const existingById = new Map((existing?.nodes ?? []).map((n) => [n['id'] as string, n]));
  const desired: DesiredNode[] = wanted.map((w) => {
    const id = ids.get(w.id)!;
    const want = opts.desire(w, ids, existingById.get(id));
    for (const key of ['exposes', 'calls']) {
      const listed = want.node[key];
      if (Array.isArray(listed)) want.node[key] = listed.filter((v) => !gone.has(v as string));
    }
    return { ...want, at: fresh.get(id)! };
  });
  const edges: ModelEdge[] = opts.edges
    .map((e) => ({ ...e, from: ids.get(e.from) ?? e.from, to: ids.get(e.to) ?? e.to }))
    .filter((e) => !gone.has(e.from) && !gone.has(e.to));
  const removed = sortedUnique([...deleted.values()].flat());

  if (!existing) {
    const take = idAllocator();
    const edgeDocs = edges.map((e) => ({
      id: take(edgeIdFor(e.from, opts.verbs[e.kind] ?? 'to', e.to), 'edge'),
      kind: e.kind,
      from: { node: e.from },
      to: e.function ? { node: e.to, function: e.function } : { node: e.to },
    }));
    return { text: opts.render(desired.map((d) => d.node), edgeDocs, fresh), ids, plan: null, existing, removed };
  }

  let plan = planMerge(existing, desired, edges, opts.verbs, opts.wasLifted);
  let base = opts.existingText!;
  if (plan.ops.some((op) => op.op === 'setLayout')) {
    if (existing.layoutBlock === 'missing') {
      // Schema-valid without one (layout defaults to empty), but the layout op appends
      // to a block: give the document the block the house style writes, then place.
      base = `${base}${base.endsWith('\n') ? '' : '\n'}\nlayout:\n  nodes: {}\n`;
    } else if (existing.layoutBlock === 'other') {
      // A layout written in a shape the op cannot extend: leave it, and let the canvas
      // place the new nodes itself — said, so the author knows why they are stacked.
      plan = { ...plan, ops: plan.ops.filter((op) => op.op !== 'setLayout') };
      opts.diagnostics.push(`warning: ${opts.path}: its layout block is not a map of nodes, so new nodes are left for the canvas to place`);
    }
  }
  const text = plan.ops.length ? applyOps(base, plan.ops).source : opts.existingText!;
  return { text, ids, plan, existing, removed };
}

/** A boundary only matches a boundary of the same surface; a client of the same platform. */
function compatibleSurface(existing: Node, wanted: Node): boolean {
  if (wanted['type'] === 'boundary') return existing['boundary'] === wanted['boundary'];
  if (wanted['type'] === 'client') return existing['client'] === wanted['client'];
  return true;
}

const implOf = (node: Node | undefined): { graph?: string; entrypoint?: string } =>
  (node?.['impl'] as { graph?: string; entrypoint?: string } | undefined) ?? {};

export function skeletonToDocuments(skeleton: Skeleton, opts: DocumentsOptions): DocumentsResult {
  const diagnostics: string[] = [];
  const model = buildModel(skeleton, opts.refinement);
  const projectId = toId(opts.projectName, 'project');
  const existing = opts.existing;
  const previous = readPreviousRegistry(existing[REGISTRY_PATH]);

  // The composition the project already names, when the project has it (index.ts reads
  // it wherever civil.yaml points); otherwise the house location — and civil.yaml is
  // pointed there, or the canvas would keep opening a file that does not exist.
  const named = zProject.safeParse(parseSafely(existing[PROJECT_PATH]));
  const compositionPath =
    named.success && existing[named.data.spec.composition] !== undefined ? named.data.spec.composition : COMPOSITION_PATH;
  if (named.success && named.data.spec.composition !== compositionPath) {
    diagnostics.push(
      `warning: civil.yaml named the composition "${named.data.spec.composition}", which the project does not have; ` +
        `the lift writes ${compositionPath} and points civil.yaml at it`,
    );
  }
  const provenance = readLiftProvenance(existing[REGISTRY_PATH]);
  const removedBefore = new Set(provenance?.removed ?? []);
  const removedNow: string[] = [];

  /** Repo files a previous lift attributed to any unit under these prefixes. */
  const liftedFiles = (...units: string[]): Set<string> => {
    const out = new Set<string>();
    for (const [unit, files] of previous) {
      if (units.some((u) => unit === u || unit.startsWith(`${u}/`))) for (const f of files) out.add(f);
    }
    return out;
  };

  // ---- composition -------------------------------------------------------------

  const notes: string[] = [];
  // Decided per service once ids are known: which graph document it is drawn in.
  const graphPaths = new Map<string, string>();
  const isGraph = (path: string | undefined) => !!path && readCanvas(existing[path], 'Graph') !== undefined;

  const composition = canvas({
    kind: 'Composition',
    path: compositionPath,
    removed: removedBefore,
    existingText: existing[compositionPath],
    wanted: model.nodes,
    edges: model.edges,
    previous,
    unitOf: (id) => `app/${id}`,
    sameCode: (e, w) => {
      if (w.type === 'client') return e['path'] === w.node['path'];
      if (w.type === 'service') {
        const mine = implOf(e);
        const theirs = implOf(w.node);
        return (!!mine.entrypoint && mine.entrypoint === theirs.entrypoint) || (!!mine.graph && mine.graph === theirs.graph);
      }
      return false;
    },
    desire: (w, ids, have) => {
      const m = w as ModelNode;
      const id = ids.get(m.id)!;
      const node: Node = { ...m.node, id };
      if (m.type === 'boundary') node['exposes'] = (m.node['exposes'] as string[]).map((s) => ids.get(s) ?? s);
      if (m.type === 'process') node['calls'] = (m.node['calls'] as string[]).map((s) => ids.get(s) ?? s);
      if (m.type === 'service') {
        const theirs = implOf(have);
        if (m.graph) {
          // An existing graph keeps its path; otherwise the house location by final id.
          const path = isGraph(theirs.graph) ? theirs.graph! : `${GRAPHS_DIR}/${id}.graph.yaml`;
          graphPaths.set(m.id, path);
          node['impl'] = { graph: path };
        } else if (theirs.graph) {
          // The author drew this service at a higher resolution than the code shows
          // (no agents found): their graph stands, and the lift says so.
          notes.push(`service "${id}" is a graph in the documents but the repository shows no agents in it; the graph is kept`);
          return { id, node, owned: [] };
        }
      }
      const owned = { client: ['client', 'path', 'dev'], boundary: ['boundary'], service: ['impl'], process: ['trigger'] }[m.type];
      const union = { client: [], boundary: ['exposes'], service: [], process: ['calls'] }[m.type];
      return { id, node, owned, union };
    },
    wasLifted: (n) => previous.has(`app/${n['id'] as string}`),
    render: (nodes, edges, layout) => compositionYaml(projectId, opts.projectName, nodes, edges, layout),
    verbs: COMPOSITION_VERBS,
    diagnostics,
  });
  const ids = composition.ids;
  removedNow.push(...composition.removed);

  const files: Record<string, string> = {};
  files[PROJECT_PATH] = projectDocument(
    existing[PROJECT_PATH],
    projectId,
    opts.projectName,
    compositionPath,
    skeleton.servers.length > 0,
  );
  files[compositionPath] = composition.text;

  // ---- graphs ------------------------------------------------------------------

  const graphIds = new Map<string, string>(); // lift service id → graph metadata.id
  const graphNodeIds = new Map<string, Map<string, string>>(); // lift service id → (lift node id → final)
  const graphPlans: { path: string; plan: MergePlan }[] = [];
  for (const service of model.nodes) {
    if (!service.graph) continue;
    const path = graphPaths.get(service.id);
    if (!path) continue; // kept as the author's graph above
    const serviceId = ids.get(service.id)!;
    const current = readCanvas(existing[path], 'Graph');
    const graphId = current?.metadataId ?? toId(serviceId, 'graph');
    const graph: ModelGraph = service.graph;
    const unitPrefix = `graph/${graphId}`;
    const lifted = liftedFiles(unitPrefix, `app/${serviceId}`);

    const result = canvas({
      kind: 'Graph',
      path,
      removed: removedBefore,
      existingText: existing[path],
      wanted: graph.nodes,
      edges: graph.edges,
      previous,
      unitOf: (id) => `${unitPrefix}/${id}`,
      sameCode: (e, w) => w.type === 'code' && typeof e['entrypoint'] === 'string' && e['entrypoint'] === w.node['entrypoint'] && e['name'] === w.node['name'],
      desire: (w, map) => {
        const id = map.get(w.id)!;
        const node: Node = { ...w.node, id };
        return w.type === 'code'
          ? { id, node, owned: ['include', 'entrypoint'], fill: ['name'] }
          : { id, node, owned: [], fill: ['name'] };
      },
      wasLifted: (n) =>
        n['type'] === 'agent'
          ? previous.has(`${unitPrefix}/${n['id'] as string}`)
          : typeof n['entrypoint'] === 'string' && lifted.has(n['entrypoint']),
      render: (nodes, edges, layout) => graphYaml(graphId, graph.name, nodes, edges, layout),
      verbs: GRAPH_VERBS,
      diagnostics,
    });
    files[path] = result.text;
    removedNow.push(...result.removed);
    graphIds.set(service.id, graphId);
    graphNodeIds.set(service.id, result.ids);
    if (result.plan) graphPlans.push({ path, plan: result.plan });
  }

  // ---- registry ----------------------------------------------------------------

  // The documents as they will stand: what the project has, with this lift on top.
  const finalDocs: Record<string, string> = {};
  for (const [path, text] of Object.entries(existing)) {
    if (path.endsWith('.yaml') && path !== REGISTRY_PATH && path !== PROJECT_PATH) finalDocs[path] = text;
  }
  for (const [path, text] of Object.entries(files)) if (path !== PROJECT_PATH) finalDocs[path] = text;
  // deriveUnits reads one composition: hand it only ours and the graphs.
  const unitDocs = Object.fromEntries(
    Object.entries(finalDocs).filter(([path]) => path === compositionPath || readCanvas(finalDocs[path], 'Graph')),
  );
  const units = deriveUnits(unitDocs);

  const filesOf = new Map<string, string[]>();
  const descriptionOf = new Map<string, string>();
  const attribute = (unit: string, paths: readonly string[]) =>
    filesOf.set(unit, sortedUnique([...(filesOf.get(unit) ?? []), ...paths]));
  const removedUnits = new Set([...removedBefore, ...removedNow]);
  for (const node of model.nodes) {
    const unit = `app/${ids.get(node.id)!}`;
    if (removedUnits.has(unit)) continue;
    attribute(unit, node.files);
    if (node.description) descriptionOf.set(unit, node.description);
    const graphId = graphIds.get(node.id);
    if (!node.graph || !graphId) continue;
    attribute(`graph/${graphId}`, node.graph.files);
    const nodeIds = graphNodeIds.get(node.id)!;
    for (const g of node.graph.nodes) {
      if (g.type !== 'agent') continue;
      const agentUnit = `graph/${graphId}/${nodeIds.get(g.id)!}`;
      if (removedUnits.has(agentUnit)) continue;
      attribute(agentUnit, g.files);
      const agent = model.skeleton.agents.find((a) => g.anchors.includes(a.source.file));
      const said = agent ? model.descriptions[agent.id] : undefined;
      if (said) descriptionOf.set(agentUnit, said);
    }
  }
  const unitIds = new Set(units.map((u) => u.id));
  for (const unit of filesOf.keys()) {
    if (!unitIds.has(unit)) diagnostics.push(`warning: registry files for "${unit}" have no unit in the documents`);
  }
  // Shared: the infrastructure modules' files and the code no module owns — less any
  // file a unit already lists, so every file is attributed once.
  const inUnits = new Set([...filesOf.values()].flat());
  const shared = sortedUnique([
    ...model.infrastructure.flatMap(infraFiles),
    ...model.skeleton.servers.flatMap((s) => s.sharedFiles ?? []),
  ]).filter((f) => !inUnits.has(f));
  // A removal stays remembered only while the node stays away: one the author put back
  // (by the same id) is theirs again.
  const present = new Set(units.map((u) => u.id));
  const removed = sortedUnique([...removedUnits].filter((u) => !present.has(u)));
  const liftedFrom = opts.liftedFrom ? { ...opts.liftedFrom, ...(removed.length ? { removed } : {}) } : undefined;
  files[REGISTRY_PATH] = liftRegistry(units, filesOf, shared, opts.repo, liftedFrom, descriptionOf);

  // ---- architecture.md ---------------------------------------------------------

  model.notes.push(...notes);
  files[ARCHITECTURE_PATH] = architectureMarkdown({ projectName: opts.projectName, model, ids, graphPaths, graphNodeIds });

  // ---- validation --------------------------------------------------------------

  const known: Record<string, string> = {};
  for (const path of opts.listed ?? []) known[path] = '';
  for (const path of opts.repo ? Object.keys(opts.repo) : namedFiles(model.skeleton)) known[path] = opts.repo?.[path] ?? '';
  const view = MemoryFiles.from({ ...known, ...existing, ...files });
  const all: Diagnostic[] = [];
  const project = zProject.safeParse(parseSafely(files[PROJECT_PATH]));
  if (!project.success) {
    for (const issue of project.error.issues) {
      all.push({ file: PROJECT_PATH, jsonPointer: `/${issue.path.join('/')}`, code: 'invalid-manifest', message: issue.message, severity: 'error' });
    }
  }
  const docs = { ...existing, ...files };
  all.push(...validateProject(compositionPath, { files: view, loadDoc: (p) => parseSafely(docs[p]) }).diagnostics);
  for (const d of all) {
    diagnostics.push(`${d.severity === 'error' ? 'error' : 'warning'}: ${d.file}${d.jsonPointer ? ` ${d.jsonPointer}` : ''}: ${d.message}`);
  }

  // ---- what happened, in words -------------------------------------------------

  for (const note of model.notes) diagnostics.push(`note: ${note}`);
  // An agent the canvas draws nowhere — its only user is infrastructure, or the
  // reader found no module that runs it — is said, not dropped silently.
  const drawn = new Set(model.nodes.flatMap((n) => n.graph?.nodes.filter((g) => g.type === 'agent').flatMap((g) => g.anchors) ?? []));
  const undrawn = model.skeleton.agents.filter((a) => !drawn.has(a.source.file)).map((a) => a.id).sort();
  if (undrawn.length) {
    diagnostics.push(
      `note: ${plural(undrawn.length, 'agent')} ${undrawn.length === 1 ? 'is' : 'are'} used by no service on the canvas (${list(undrawn)}); listed in civil/architecture.md`,
    );
  }
  const plans = [
    ...(composition.plan ? [{ path: compositionPath, plan: composition.plan }] : []),
    ...graphPlans,
  ];
  // A service still in the code but now read as infrastructure (the model's call, or
  // the reader's) is not "gone": say what changed, so the author is not told to delete
  // something the repository plainly still has.
  const nowInfrastructure = new Set(model.infrastructure.map((s) => s.id));
  for (const { path, plan } of plans) {
    for (const id of plan.stale) {
      diagnostics.push(
        nowInfrastructure.has(id)
          ? `warning: ${path}: "${id}" is now read as infrastructure (described in civil/architecture.md, not drawn); kept — remove it on the canvas if you agree`
          : `warning: ${path}: "${id}" was lifted before and is no longer found in the repository; kept — remove it on the canvas if it is gone`,
      );
    }
    for (const id of plan.staleEdges) {
      diagnostics.push(`warning: ${path}: edge "${id}" connects lifted nodes but is not shown by the code; kept`);
    }
  }

  const summary = composition.plan
    ? updateSummary(plans, files, existing, nowInfrastructure, removedNow.map((u) => u.slice(u.lastIndexOf('/') + 1)))
    : firstSummary(model);
  return { files, summary, diagnostics };
}

function firstSummary(model: ReturnType<typeof buildModel>): string {
  const count = (type: ModelNode['type']) => model.nodes.filter((n) => n.type === type).length;
  const graphs = model.nodes.filter((n) => n.graph).length;
  const parts = [
    plural(count('client'), 'client'),
    plural(count('boundary'), 'api boundary', 'api boundaries'),
    `${plural(count('service'), 'service')}${graphs ? ` (${graphs} drawn as ${graphs === 1 ? 'an agent graph' : 'agent graphs'})` : ''}`,
    plural(count('process'), 'scheduled process', 'scheduled processes'),
    plural(model.edges.length, 'connection'),
  ];
  const infra = model.infrastructure.length
    ? ` ${plural(model.infrastructure.length, 'infrastructure module')} ${model.infrastructure.length === 1 ? 'is' : 'are'} described in civil/architecture.md rather than drawn.`
    : '';
  return (
    `Read the repository into civil/: ${parts.join(', ')}.${infra} ` +
    `The repository's own code is recorded as the implementation (role ${LIFT_ROLE}). Review the pending changes and commit to keep them.`
  );
}

function updateSummary(
  plans: readonly { path: string; plan: MergePlan }[],
  files: Record<string, string>,
  existing: FileMap,
  nowInfrastructure: ReadonlySet<string>,
  removed: readonly string[],
): string {
  const gather = (pick: (p: MergePlan) => string[]) => plans.flatMap(({ plan }) => pick(plan));
  const added = gather((p) => p.added);
  const updated = gather((p) => p.updated);
  const authors = gather((p) => p.authors);
  const flagged = gather((p) => p.stale);
  const reclassified = flagged.filter((id) => nowInfrastructure.has(id));
  const stale = flagged.filter((id) => !nowInfrastructure.has(id));
  const changed = Object.keys(files).filter((path) => files[path] !== existing[path]).sort();
  if (changed.length === 0) return 'civil/ already matches the repository — nothing to change.';

  const parts: string[] = [];
  if (added.length) parts.push(`added ${list(added)}`);
  if (updated.length) parts.push(`updated ${list(updated)} from the code`);
  // Connections the code now shows between nodes that were already there.
  const edges = plans.reduce((n, { plan }) => n + plan.ops.filter((op) => op.op === 'addEdge').length, 0);
  if (edges && !added.length) parts.push(`drew ${plural(edges, 'new connection')}`);
  const sentence = parts.length ? parts.join('; ') : `refreshed ${list(changed)}`;
  const kept = authors.length ? ` Kept ${plural(authors.length, 'node')} you added (${list(authors)}).` : '';
  const gone = stale.length
    ? ` ${plural(stale.length, 'node')} the repository no longer shows ${stale.length === 1 ? 'is' : 'are'} kept and flagged (${list(stale)}).`
    : '';
  const infra = reclassified.length
    ? ` ${plural(reclassified.length, 'node')} now read as infrastructure ${reclassified.length === 1 ? 'is' : 'are'} kept and flagged (${list(reclassified)}).`
    : '';
  const deleted = removed.length
    ? ` Not added back, because you removed ${removed.length === 1 ? 'it' : 'them'}: ${list(removed)}.`
    : '';
  return `Updated civil/ from the repository: ${sentence}.${kept}${gone}${infra}${deleted} Layout and ids you set are unchanged; review the pending changes.`;
}
