import { ID_PATTERN } from '@civil/schema';
import { applyRefinement } from './refine.js';
import type { Refinement, Skeleton, SkeletonAgent, SkeletonServer, SkeletonService } from './skeleton.js';

/**
 * The lifted model: what the civil/ documents should say about the repository, before
 * it is written fresh or merged into what the project already has (to-documents.ts).
 * Pure over the skeleton and the refinement — the same inputs give the same model, in
 * the same order, which is what makes the written documents byte-stable.
 *
 * Every node carries the files that implement it (for civil/registry.yaml) and the
 * files that identify it (`anchors`, for matching it against an existing node on
 * Update when the author has since renamed it). Ids here are the lift's own; the merge
 * maps them to the author's where a node already exists.
 */

export const COMPOSITION_PATH = 'civil/app.yaml';
export const GRAPHS_DIR = 'civil/graphs';

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
export const sortedUnique = (items: Iterable<string>): string[] => [...new Set(items)].sort(byString);

/**
 * A Civil id from a name the code uses: "TasksService" → "tasks-service",
 * "search_docs" → "search_docs". Underscores survive (an id may match a module name,
 * docs/prd-deltas.md §1); everything else outside the pattern becomes a hyphen.
 */
export function toId(name: string, fallback = 'node'): string {
  const id = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
  const lettered = /^[a-z]/.test(id) ? id : `${fallback}-${id}`.replace(/-$/, '');
  return lettered.slice(0, 64).replace(/[-_]+$/, '');
}

/** "knowledge-base" → "Knowledge base": a readable label from an id. */
export const titleOf = (id: string): string => {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
};

/**
 * An edge id from its ends, so the same connection has the same id on every run and
 * an Update can recognise it. Over the 64-character limit the tail is cut and a short
 * deterministic hash keeps it unique.
 */
export function edgeIdFor(from: string, verb: string, to: string): string {
  const id = `${from}-${verb}-${to}`;
  if (id.length <= 64) return id;
  let h = 0;
  for (const ch of id) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return `${id.slice(0, 55).replace(/[-_]+$/, '')}-${h.toString(16).padStart(8, '0')}`;
}

/** Allocates ids unique within one canvas, suffixing on a clash rather than merging. */
export function idAllocator(taken: Iterable<string> = []) {
  const used = new Set(taken);
  return (wanted: string, suffix: string): string => {
    let id = wanted;
    if (used.has(id)) id = toId(`${wanted}-${suffix}`);
    for (let n = 2; used.has(id); n += 1) id = toId(`${wanted}-${suffix}-${n}`);
    used.add(id);
    return id;
  };
}

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

export type CompositionType = 'client' | 'boundary' | 'service' | 'process';

export interface ModelNode {
  /** The lift's id for it; the merge may map it to the author's. */
  id: string;
  type: CompositionType;
  /** The node as the composition says it, keys in the house order. */
  node: Record<string, unknown>;
  /** Layout column: clients, boundaries, services, processes. */
  column: number;
  /** Files that identify it across runs, primary first — what the registry is matched on. */
  anchors: string[];
  /** The repo files that implement the composition node (registry unit app/<id>). */
  files: string[];
  /** What the code calls it, for architecture.md: "TasksModule". */
  label: string;
  description?: string;
  /** Present for a service that uses agents: its dataflow canvas. */
  graph?: ModelGraph;
}

export interface ModelEdge {
  kind: string;
  from: string;
  to: string;
  /** A capability edge names the function the agent may call. */
  function?: string;
}

export interface ModelGraphNode {
  id: string;
  type: 'code' | 'agent';
  node: Record<string, unknown>;
  column: number;
  anchors: string[];
  /** For an agent: the registry unit graph/<graph>/<agent>'s files. */
  files: string[];
}

export interface ModelGraph {
  name: string;
  nodes: ModelGraphNode[];
  edges: ModelEdge[];
  /** The registry unit graph/<id>'s files: the service's orchestration code. */
  files: string[];
}

export interface LiftModel {
  nodes: ModelNode[];
  edges: ModelEdge[];
  /** Cross-cutting modules, off the canvas, listed in architecture.md and the registry's shared files. */
  infrastructure: SkeletonService[];
  /** The skeleton as mapped — renames applied, infrastructure marked. */
  skeleton: Skeleton;
  descriptions: Record<string, string>;
  summary: string | null;
  /** Lift id of the boundary each server became. */
  boundaryOf: Record<string, string>;
  /** What the mapping had to leave out or assume, in words. */
  notes: string[];
}

const allIds = (s: Skeleton): Set<string> =>
  new Set([...s.clients, ...s.servers, ...s.services, ...s.agents, ...s.processes].map((e) => e.id));

/**
 * The refinement applied exactly once. refineSkeleton already returns the skeleton
 * renamed (refine.ts applyRefinement), and the mapper is also called with a raw
 * skeleton plus a refinement — tests do, and so may a caller that refines elsewhere.
 * Applying twice would walk a rename chain (a→b, b→c turns a into c), so the renames
 * are applied only while the skeleton still has every old id. A refinement that is a
 * pure permutation of ids is indistinguishable either way and is taken as applied,
 * which is the shape the real pipeline hands over.
 */
function refined(skeleton: Skeleton, refinement: Refinement | null): Skeleton {
  if (!refinement) return skeleton;
  const ids = allIds(skeleton);
  const from = Object.keys(refinement.renames);
  const to = Object.values(refinement.renames);
  const permutation = from.length > 0 && sortedUnique(from).join() === sortedUnique(to).join();
  const unapplied = from.length > 0 && !permutation && from.every((id) => ids.has(id));
  if (unapplied) return applyRefinement(skeleton, refinement);
  // Infrastructure marking is idempotent, so it is safe to apply either way.
  const infra = new Set(refinement.infrastructure);
  return {
    ...skeleton,
    services: skeleton.services.map((s) => ({ ...s, infrastructure: s.infrastructure || infra.has(s.id) })),
  };
}

/**
 * The provider that stands for a module, when one does: `TasksModule` → the
 * `TasksService` it declares, or its only provider when that is the module's own
 * code. Otherwise the module file itself, which is still the honest entry into the
 * unit's code.
 */
function primaryOf(service: SkeletonService): { name: string; file: string } {
  const wanted = service.moduleClass.replace(/Module$/, 'Service');
  const named = service.providers.find((p) => p.name === wanted);
  if (named) return named;
  // Its only provider stands for it when that is the module's own code — not a binding
  // it imports from elsewhere (an agent provider in agents/index.ts).
  const only = service.providers.length === 1 ? service.providers[0]! : undefined;
  if (only && (!service.files || service.files.includes(only.file))) return only;
  return { name: service.moduleClass, file: service.source.file };
}

/** How a package manager runs a package script, as the repository itself would. */
export function devCommand(manager: 'npm' | 'pnpm' | 'yarn' | 'bun', script: string): string {
  if (manager === 'yarn') return `yarn ${script}`;
  if (manager === 'bun') return `bun run ${script}`;
  return `${manager} run ${script}`;
}

/**
 * A service's surface: its module file and the controllers it owns. A controller two
 * roots both declare (health, version) belongs to the module that owns its file, so a
 * file and its routes are attributed to one unit, not two.
 */
function surfaceOf(service: SkeletonService): string[] {
  const owned = (file: string) => !service.files || service.files.includes(file);
  return [service.source.file, ...service.controllers.map((c) => c.file).filter(owned)];
}

/** A description long enough to be a paragraph reads badly on a node face. */
const MAX_NAME_CHARS = 80;
const nameFrom = (description: string | undefined, fallback: string): string =>
  description && description.length <= MAX_NAME_CHARS ? description : fallback;

/**
 * The dataflow canvas of a service that uses agents. The lift can see which agents a
 * service's code uses and which tools each is given; it cannot see the order things
 * happen in, so the flow is the one thing the code does show — the service's own code
 * hands work to each agent — and nothing is invented beyond it. No io nodes: the
 * validator does not require them, and a schema the reader did not find would be a
 * guess.
 */
function graphFor(
  service: SkeletonService,
  agents: Map<string, SkeletonAgent>,
  descriptions: Record<string, string>,
  notes: string[],
): ModelGraph {
  const primary = primaryOf(service);
  const ext = /\.tsx$/.test(service.source.file) ? 'tsx' : 'ts';
  const dir = dirOf(service.source.file);
  const take = idAllocator();

  // The code node covers the module's own code: its whole directory when the module
  // owns it, otherwise exactly its files — a module beside the bootstrap in src/ would
  // otherwise claim every module, agent and helper under src/.
  const include = service.directory
    ? [`${service.directory}/**/*.${ext}`]
    : service.files?.length
      ? service.files
      : [dir ? `${dir}/**/*.${ext}` : `*.${ext}`];

  const codeId = take(toId(primary.name, 'code'), 'code');
  const nodes: ModelGraphNode[] = [
    {
      id: codeId,
      type: 'code',
      node: {
        id: codeId,
        type: 'code',
        name: primary.name,
        include,
        entrypoint: primary.file,
      },
      column: 0,
      anchors: [primary.file],
      files: [],
    },
  ];
  const edges: ModelEdge[] = [];
  const toolIds = new Map<string, string>();
  const agentNode = new Map<string, string>();
  const via = service.agentsVia ?? {};

  /** How many agents deep an agent sits: 0 when the service's code calls it. */
  const depth = (id: string, seen = new Set<string>()): number => {
    const callers = (via[id] ?? []).filter((c) => service.agents.includes(c) && !seen.has(c));
    if (!callers.length) return 0;
    seen.add(id);
    return 1 + Math.max(...callers.map((c) => depth(c, seen)));
  };

  // Agents and tools in id order, so the canvas reads the same on every run.
  for (const agentId of sortedUnique(service.agents)) {
    const agent = agents.get(agentId);
    if (!agent) {
      notes.push(`service "${service.id}" uses agent "${agentId}", which the reader did not find; left out`);
      continue;
    }
    const id = take(toId(agent.id, 'agent'), 'agent');
    agentNode.set(agentId, id);
    const column = 1 + depth(agentId);
    nodes.push({
      id,
      type: 'agent',
      node: { id, type: 'agent', name: nameFrom(descriptions[agent.id], titleOf(agent.id)) },
      column,
      anchors: [agent.source.file],
      files: sortedUnique([...agent.files, agent.source.file, ...agent.tools.map((t) => t.file)]),
    });

    const tools = [...agent.tools].sort((a, b) => byString(a.name, b.name) || byString(a.file, b.file));
    for (const tool of tools) {
      // One node per tool, shared by every agent in this graph that is given it.
      const key = `${tool.file}#${tool.name}`;
      let toolId = toolIds.get(key);
      if (!toolId) {
        toolId = take(toId(tool.name, 'tool'), 'tool');
        toolIds.set(key, toolId);
        nodes.push({
          id: toolId,
          type: 'code',
          node: { id: toolId, type: 'code', name: tool.name, include: [tool.file], entrypoint: tool.file },
          column: column + 1,
          anchors: [tool.file],
          files: [],
        });
      }
      edges.push({ kind: 'capability', from: id, to: toolId, function: tool.name });
    }
  }

  // The flow the code shows: the service's own code hands work to the agents it calls,
  // and an agent reached only through another (an analyzer's scorer) is handed work
  // by that agent, not by the service.
  for (const agentId of sortedUnique(service.agents)) {
    const id = agentNode.get(agentId);
    if (!id) continue;
    const callers = (via[agentId] ?? []).map((c) => agentNode.get(c)).filter((c): c is string => !!c);
    if (callers.length) for (const caller of sortedUnique(callers)) edges.push({ kind: 'flow', from: caller, to: id });
    else edges.push({ kind: 'flow', from: codeId, to: id });
  }
  const rank = (kind: string) => (kind === 'flow' ? 0 : 1);
  edges.sort((a, b) => rank(a.kind) - rank(b.kind) || byString(a.from, b.from) || byString(a.to, b.to) || byString(a.function ?? '', b.function ?? ''));

  // The orchestration code is the module's code beyond its surface: its controllers
  // and module file are the composition node's, and the agents' files are the
  // agents' own units.
  const surface = new Set(surfaceOf(service));
  const orchestration = service.files
    ? service.files.filter((f) => !surface.has(f))
    : service.providers.map((p) => p.file);
  return {
    name: titleOf(service.id),
    nodes,
    edges,
    files: sortedUnique(orchestration),
  };
}

/**
 * The mapping, decided in docs/lift-repo.md and summarised here:
 *
 * - a client node per frontend app;
 * - an api boundary per backend app — "api" when there is one, "<server>-api"
 *   otherwise — exposing the product services that serve its routes;
 * - a service node per non-infrastructure module: a graph when its code uses agents,
 *   otherwise an entrypoint at its primary provider;
 * - a process per scheduled job, calling the services whose code it runs.
 *
 * Edges are the ones the canvas would draw: client → boundary and boundary → service
 * routes-to (consistent with `exposes`), service → service depends-on, and process →
 * service depends-on (consistent with `calls`).
 * Infrastructure modules are left off the canvas: they serve every service, and
 * drawing them would bury the product shape under plumbing.
 */
export function buildModel(input: Skeleton, refinement: Refinement | null): LiftModel {
  const skeleton = refined(input, refinement);
  const descriptions = refinement?.descriptions ?? {};
  const notes: string[] = [];
  const agents = new Map(skeleton.agents.map((a) => [a.id, a]));

  const sortById = <T extends { id: string }>(items: readonly T[]): T[] =>
    [...items].sort((a, b) => byString(a.id, b.id));
  const clients = sortById(skeleton.clients);
  const servers = sortById(skeleton.servers);
  const services = sortById(skeleton.services);
  const processes = sortById(skeleton.processes);
  const product = services.filter((s) => !s.infrastructure);
  const infrastructure = services.filter((s) => s.infrastructure);

  // One namespace per canvas: allocate in column order so a clash (a service called
  // "api" beside the "api" boundary) suffixes the later node by its type.
  const take = idAllocator();
  const clientId = new Map(clients.map((c) => [c.id, take(toId(c.id, 'client'), 'client')]));
  // A boundary per deployment: "api" for the one clients call, "<root>-api" for an
  // internal one (a worker the scheduler posts to), "<server>-api" when several
  // packages each serve their own.
  const publicServers = servers.filter((s) => !s.internal);
  const boundaryName = (s: SkeletonServer): string => {
    if (servers.length === 1 || (publicServers.length === 1 && publicServers[0] === s)) return 'api';
    if (s.rootModule) return toId(`${s.rootModule.replace(/Module$/, '') || s.rootModule}-api`, 'server');
    return toId(`${s.id}-api`, 'server');
  };
  const boundaryId = new Map(servers.map((s) => [s.id, take(boundaryName(s), 'boundary')]));
  const serviceId = new Map(product.map((s) => [s.id, take(toId(s.id, 'service'), 'service')]));
  const processId = new Map(processes.map((p) => [p.id, take(toId(p.id, 'process'), 'process')]));

  const nodes: ModelNode[] = [];
  const edges: ModelEdge[] = [];

  for (const client of clients) {
    const id = clientId.get(client.id)!;
    const node: Record<string, unknown> = { id, type: 'client', client: 'web', path: client.path };
    // The session runs a client's dev command in its directory; the reader found the
    // script by its role and names it, so the node runs that script through the
    // repository's own package manager — npm cannot resolve a pnpm `workspace:*`
    // dependency (a skeleton from before the name was recorded means "dev").
    if (client.devScript) node['dev'] = devCommand(client.packageManager ?? 'npm', client.devScriptName ?? 'dev');
    nodes.push({
      id,
      type: 'client',
      node,
      column: 0,
      anchors: [client.source.file],
      // A client is authored code in a directory; its manifest stands for it. Listing
      // every file under the directory would make the registry a file index.
      files: [client.source.file],
      label: client.path,
      ...(descriptions[client.id] ? { description: descriptions[client.id]! } : {}),
    });

    let reaches = client.calls.filter((s) => boundaryId.has(s));
    for (const missing of client.calls.filter((s) => !boundaryId.has(s))) {
      notes.push(`client "${client.id}" calls server "${missing}", which the reader did not find`);
    }
    if (reaches.length === 0 && servers.length === 1) {
      // With one backend there is nothing else a frontend could be talking to; the
      // assumption is said aloud rather than left for the author to discover.
      reaches = [servers[0]!.id];
      notes.push(`client "${id}" was not seen calling a server; connected to the only one, "${boundaryId.get(servers[0]!.id)}"`);
    }
    for (const server of sortedUnique(reaches)) {
      edges.push({ kind: 'routes-to', from: id, to: boundaryId.get(server)! });
    }
  }

  for (const server of servers) {
    const id = boundaryId.get(server.id)!;
    const exposes = sortedUnique(server.exposes.filter((s) => serviceId.has(s)).map((s) => serviceId.get(s)!));
    nodes.push({
      id,
      type: 'boundary',
      node: { id, type: 'boundary', boundary: 'api', exposes },
      column: 1,
      anchors: [server.source.file],
      files: [server.source.file],
      label: server.path,
      ...(descriptions[server.id] ? { description: descriptions[server.id]! } : {}),
    });
    for (const target of exposes) edges.push({ kind: 'routes-to', from: id, to: target });
  }

  for (const service of product) {
    const id = serviceId.get(service.id)!;
    const usesAgents = service.agents.length > 0;
    const graph = usesAgents ? graphFor(service, agents, descriptions, notes) : undefined;
    const primary = primaryOf(service);
    // A graph-backed node's own files are its surface (module and controllers); the
    // rest is the graph's orchestration. Otherwise the node owns everything the module
    // does — its whole directory, not just the classes it lists.
    const surface = surfaceOf(service);
    const own = graph ? surface : [...surface, ...(service.files ?? service.providers.map((p) => p.file))];
    nodes.push({
      id,
      type: 'service',
      // The graph path is decided by the merge (an existing graph keeps its path); the
      // placeholder here is the fresh default.
      node: { id, type: 'service', impl: graph ? { graph: `${GRAPHS_DIR}/${id}.graph.yaml` } : { entrypoint: primary.file } },
      column: 2,
      anchors: sortedUnique([service.source.file, primary.file]),
      files: sortedUnique(own),
      label: service.moduleClass,
      ...(descriptions[service.id] ? { description: descriptions[service.id]! } : {}),
      ...(graph ? { graph } : {}),
    });
    // Work it starts on another deployment (a queued task aimed at a worker route) is
    // a dependency too: the schema has two relations, and this is not routing.
    for (const dep of sortedUnique([...service.dependsOn, ...(service.dispatchesTo ?? [])])) {
      if (dep === service.id || !serviceId.has(dep)) continue;
      edges.push({ kind: 'depends-on', from: id, to: serviceId.get(dep)! });
    }
  }

  for (const process of processes) {
    const id = processId.get(process.id)!;
    const calls = sortedUnique(process.calls.filter((s) => serviceId.has(s)).map((s) => serviceId.get(s)!));
    const dropped = process.calls.filter((s) => !serviceId.has(s));
    if (dropped.length) {
      notes.push(`process "${id}" also calls ${dropped.map((s) => `"${s}"`).join(', ')}, which ${dropped.length === 1 ? 'is' : 'are'} not on the canvas (infrastructure or not found)`);
    }
    nodes.push({
      id,
      type: 'process',
      node: { id, type: 'process', trigger: { kind: 'schedule', cron: process.schedule }, calls },
      // An entry point like a boundary, so it sits in the boundaries' column.
      column: 1,
      // Several scheduler jobs share one .tf file, so a file cannot tell them apart;
      // such a process is matched on Update by its id alone.
      anchors: process.route ? [] : [process.source.file],
      files: [process.source.file],
      label: process.route ? `${process.route}` : process.id,
      ...(descriptions[process.id] ? { description: descriptions[process.id]! } : {}),
    });
    // What it calls, drawn: `calls` alone leaves a schedule floating unconnected on the
    // canvas, and depends-on is the relation the schema gives a process → service.
    for (const target of calls) edges.push({ kind: 'depends-on', from: id, to: target });
  }

  // Services in layers by dependency: a service sits one column right of everything
  // that depends on it, so dependents read left of what they need and the edges run
  // one way. Cycles are cut where the walk meets them; the depth is capped so a long
  // chain wraps into a few columns rather than a frieze.
  const dependents = new Map<string, string[]>();
  const onCanvas = new Set(serviceId.values());
  for (const e of edges)
    if (e.kind === 'depends-on' && onCanvas.has(e.from)) dependents.set(e.to, [...(dependents.get(e.to) ?? []), e.from]);
  const level = new Map<string, number>();
  const levelOf = (id: string, walking: Set<string>): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    walking.add(id);
    const up = (dependents.get(id) ?? []).filter((d) => !walking.has(d)).sort(byString);
    const value = up.length ? 1 + Math.max(...up.map((d) => levelOf(d, walking))) : 0;
    walking.delete(id);
    level.set(id, value);
    return value;
  };
  for (const node of nodes) {
    if (node.type !== 'service') continue;
    node.column = 2 + Math.min(MAX_SERVICE_LAYERS - 1, levelOf(node.id, new Set()));
  }

  for (const id of [...clientId.values(), ...boundaryId.values(), ...serviceId.values(), ...processId.values()]) {
    if (!ID_PATTERN.test(id)) notes.push(`"${id}" is not a valid Civil id`);
  }

  return {
    nodes,
    edges,
    infrastructure,
    skeleton,
    descriptions,
    summary: refinement?.summary ?? null,
    boundaryOf: Object.fromEntries(boundaryId),
    notes,
  };
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

/** Service columns at most; deeper dependency chains share the last one. */
const MAX_SERVICE_LAYERS = 4;

/** Column pitch and row pitch: wider than a node face, so nothing overlaps. */
export const COLUMN_X = 260;
export const ROW_Y = 120;
const ORIGIN = { x: 40, y: 40 };

/**
 * Deterministic columns, left to right in the direction traffic flows; each column
 * stacked in the order given (sorted by the model) and centred on the tallest, so a
 * lone boundary sits level with the middle of the services it fronts.
 */
export function columnLayout(items: readonly { id: string; column: number }[]): Map<string, { x: number; y: number }> {
  const columns = new Map<number, string[]>();
  for (const item of items) columns.set(item.column, [...(columns.get(item.column) ?? []), item.id]);
  const tallest = Math.max(0, ...[...columns.values()].map((c) => c.length));
  const used = [...columns.keys()].sort((a, b) => a - b);
  const out = new Map<string, { x: number; y: number }>();
  used.forEach((column, index) => {
    const ids = columns.get(column)!;
    const offset = ((tallest - ids.length) * ROW_Y) / 2;
    ids.forEach((id, row) => out.set(id, { x: ORIGIN.x + index * COLUMN_X, y: ORIGIN.y + offset + row * ROW_Y }));
  });
  return out;
}

/**
 * Where a node added on Update goes: its fresh-layout spot, moved down a row at a
 * time until it no longer sits on a node the author has already placed.
 */
export function freeSpot(
  wanted: { x: number; y: number },
  occupied: readonly { x: number; y: number }[],
): { x: number; y: number } {
  const clash = (p: { x: number; y: number }) =>
    occupied.some((o) => Math.abs(o.x - p.x) < COLUMN_X * 0.8 && Math.abs(o.y - p.y) < ROW_Y * 0.8);
  const spot = { ...wanted };
  while (clash(spot)) spot.y += ROW_Y;
  return spot;
}
