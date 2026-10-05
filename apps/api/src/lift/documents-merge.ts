import { parse } from 'yaml';
import type { ManifestOp } from '../manifest/apply.js';
import { edgeIdFor, freeSpot, idAllocator, type ModelEdge } from './documents-model.js';

/**
 * Update: merging a lift into the civil/ documents the project already has.
 *
 * The rules, so the author can predict what an Update will do:
 *
 * 1. **Nothing is removed.** A node or edge the lift no longer produces stays where it
 *    is. If the previous registry records it as lifted (its unit lists files with role
 *    `repo`), it is reported as "no longer found in the repository" and flagged in the
 *    diagnostics; otherwise it is the author's own addition and is reported as kept.
 *    Deciding what to delete is the author's call, made on the canvas.
 * 1b. **A deletion is the author's call too, and it sticks.** A node the previous lift
 *    wrote (the registry still lists its unit) that is gone from the document, with no
 *    node that could be it renamed, was removed by the author: it is not added back,
 *    nor are edges to it, and the summary says so once.
 * 2. **The author's ids win.** A lifted node is matched to an existing one by id; failing
 *    that, by the files that identify it — the previous registry's record of which files
 *    each unit was lifted from, then the node's own path (a client's directory, a
 *    service's entrypoint, a code node's entrypoint), then a rename the registry can
 *    see (its unit's node vanished, exactly one unexplained node took its place). A matched node keeps the author's
 *    id, so a rename on the canvas survives every later Update, and every reference the
 *    lift makes (edges, exposes, calls, layout) is mapped to it.
 * 3. **The author's layout wins.** A matched node's position is never touched; a new
 *    node is placed in its column, moved down until it sits on nothing already placed.
 * 4. **The lift owns only what it reads from code.** A client's directory and dev
 *    command, a boundary's surface, a service's implementation, a schedule, a code
 *    node's files. Everything else on a node — invocation overrides, display names the
 *    author set — is left alone. Lists the author can extend (exposes, calls) are
 *    unioned, never replaced.
 * 5. **Every change is an op** (manifest/apply.ts): the same addNode / updateNode /
 *    addEdge / setLayout a canvas gesture posts, spliced into the existing text so the
 *    author's comments and formatting survive. No change means no op, which means the
 *    bytes are untouched — re-running a lift over its own output is a no-op.
 */

export type Point = { x: number; y: number };
type Node = Record<string, unknown>;

export interface ExistingCanvas {
  nodes: Node[];
  edges: Node[];
  layout: Record<string, Point>;
  /**
   * The document's `layout.nodes` block: present (`nodes`), absent with no `layout`
   * key at all (`missing` — schema-valid, layout defaults to empty), or something the
   * layout op cannot append to (`other`).
   */
  layoutBlock: 'nodes' | 'missing' | 'other';
  metadataId: string | undefined;
}

/** The document as written, or undefined when it does not parse into a canvas. */
export function readCanvas(text: string | undefined, kind: 'Composition' | 'Graph'): ExistingCanvas | undefined {
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return undefined;
  }
  const doc = raw as { kind?: unknown; metadata?: { id?: unknown }; spec?: { nodes?: unknown; edges?: unknown }; layout?: { nodes?: unknown } } | null;
  if (!doc || typeof doc !== 'object' || doc.kind !== kind) return undefined;
  const list = (v: unknown): Node[] =>
    Array.isArray(v) ? v.filter((n): n is Node => !!n && typeof n === 'object' && typeof (n as Node)['id'] === 'string') : [];
  const layout: Record<string, Point> = {};
  const rawLayout = doc.layout?.nodes;
  const layoutBlock: ExistingCanvas['layoutBlock'] =
    doc.layout === undefined || doc.layout === null
      ? 'missing'
      : rawLayout && typeof rawLayout === 'object' && !Array.isArray(rawLayout)
        ? 'nodes'
        : 'other';
  if (rawLayout && typeof rawLayout === 'object') {
    for (const [id, p] of Object.entries(rawLayout as Record<string, unknown>)) {
      const point = p as { x?: unknown; y?: unknown } | null;
      if (point && typeof point.x === 'number' && typeof point.y === 'number') layout[id] = { x: point.x, y: point.y };
    }
  }
  return {
    nodes: list(doc.spec?.nodes),
    edges: list(doc.spec?.edges),
    layout,
    layoutBlock,
    metadataId: typeof doc.metadata?.id === 'string' ? doc.metadata.id : undefined,
  };
}

/**
 * The previous registry's record of lifted files, per unit: only files with role
 * `repo`, because those are the ones a lift wrote. A registry from a Civil transpile
 * (generated code) says nothing about what the repository's own code was lifted into.
 */
export function readPreviousRegistry(text: string | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (text === undefined) return out;
  let doc: { units?: Record<string, { files?: Record<string, { role?: unknown } | null> } | null> } | null;
  try {
    doc = parse(text) as typeof doc;
  } catch {
    return out;
  }
  for (const [unit, entry] of Object.entries(doc?.units ?? {})) {
    const files = Object.entries(entry?.files ?? {})
      .filter(([, f]) => f?.role === 'repo')
      .map(([path]) => path);
    if (files.length) out.set(unit, new Set(files));
  }
  return out;
}

/** The lift's view of a node, as the merge needs it. */
export interface WantedNode {
  id: string;
  type: string;
  anchors: string[];
}

export interface MatchRules {
  /** Whether an existing node could be this lifted one at all (type, surface kind). */
  compatible(existing: Node, wanted: WantedNode): boolean;
  /** The registry unit an existing node id would have: app/<id>, graph/<g>/<id>. */
  unitOf(id: string): string;
  /** A last match on the node's own fields: a client's path, an entrypoint. */
  sameCode(existing: Node, wanted: WantedNode): boolean;
  /**
   * Whether a node of this kind is a registry unit of its own — every composition
   * node, a graph's agents — and so can be known to have been removed. A tool's code
   * node shares its file with the agent's unit, which says nothing about the tool.
   */
  isUnit?(wanted: WantedNode): boolean;
}

/**
 * Lift id → the id the documents use: the author's where the node exists, else the
 * lift's. `deleted` collects the lift ids whose node the author removed (rule 1b), each
 * with the registry units that show it was lifted; they are in the map under an id but
 * must not be written back.
 */
export function matchNodes(
  existing: ExistingCanvas | undefined,
  wanted: readonly WantedNode[],
  previous: ReadonlyMap<string, ReadonlySet<string>>,
  rules: MatchRules,
  deleted: Map<string, string[]> = new Map(),
  /** Units an earlier Update already found removed by the author (lifted_from.removed). */
  removed: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const ids = new Map<string, string>();
  const nodes = existing?.nodes ?? [];
  const claimed = new Set<string>();
  const claim = (w: WantedNode, e: Node) => {
    ids.set(w.id, e['id'] as string);
    claimed.add(e['id'] as string);
  };
  const open = (e: Node, w: WantedNode) => !claimed.has(e['id'] as string) && rules.compatible(e, w);

  // Three passes, strongest evidence first, so a weaker match never takes a node a
  // stronger one would have claimed: the same id, then the registry, then the code.
  for (const w of wanted) {
    const e = nodes.find((n) => n['id'] === w.id);
    if (e && open(e, w)) claim(w, e);
  }
  for (const w of wanted) {
    if (ids.has(w.id)) continue;
    const e = nodes.find((n) => open(n, w) && w.anchors.some((a) => previous.get(rules.unitOf(n['id'] as string))?.has(a)));
    if (e) claim(w, e);
  }
  for (const w of wanted) {
    if (ids.has(w.id)) continue;
    const e = nodes.find((n) => open(n, w) && rules.sameCode(n, w));
    if (e) claim(w, e);
  }

  // Last, a rename on the canvas that left no other trace. The registry still names the
  // unit by its old id, and that id is gone from the document; if the lifted node's
  // files are that unit's, and exactly one compatible node in the document is neither
  // claimed nor known to the registry, that node is the renamed one. One candidate or
  // none: with two, guessing which is the author's new node would be inventing.
  const prefix = rules.unitOf('');
  const present = new Set(nodes.map((n) => rules.unitOf(n['id'] as string)));
  const vanished = [...previous.keys()].filter(
    (unit) => unit.startsWith(prefix) && !unit.slice(prefix.length).includes('/') && !present.has(unit),
  );
  for (const w of wanted) {
    if (ids.has(w.id)) continue;
    // Removed on an earlier Update and still absent: removed, with no second guess at a
    // rename — a node the author has added since is theirs, not this one.
    if (existing && (rules.isUnit?.(w) ?? true) && removed.has(rules.unitOf(w.id))) {
      deleted.set(w.id, [rules.unitOf(w.id)]);
      continue;
    }
    // Its own unit vanished (the same id, lifted before), or one sharing its files did.
    const evidence = vanished.filter((unit) => unit === rules.unitOf(w.id) || w.anchors.some((a) => previous.get(unit)!.has(a)));
    if (!evidence.length) continue;
    const candidates = nodes.filter((n) => open(n, w) && !previous.has(rules.unitOf(n['id'] as string)));
    if (candidates.length === 1) claim(w, candidates[0]!);
    // No node could be it — or several could, and choosing would be a guess: the
    // author removed it. Re-adding it would undo their edit on every Update.
    else if (existing && (rules.isUnit?.(w) ?? true)) deleted.set(w.id, evidence);
  }

  // New nodes keep the lift's id unless an unmatched existing node already has it.
  const take = idAllocator(nodes.map((n) => n['id'] as string));
  for (const w of wanted) if (!ids.has(w.id)) ids.set(w.id, take(w.id, w.type));
  return ids;
}

/** What the lift says about one node, with ids already mapped to the documents'. */
export interface DesiredNode {
  id: string;
  node: Node;
  /** Fields the lift reads from code and therefore sets. */
  owned: readonly string[];
  /** Lists the author may extend: the lift's entries are added, the author's kept. */
  union?: readonly string[];
  /** Fields set only when the author has not set them (display names). */
  fill?: readonly string[];
  /** Where it goes on a fresh canvas. */
  at: Point;
}

/** Order-insensitive for object keys, so `{ cron, kind }` equals `{ kind, cron }`. */
export function sameValue(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v as Node).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, canon(x)]))
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

export const edgeKey = (e: { kind: string; from: string; to: string; function?: string | undefined }): string =>
  `${e.kind}|${e.from}|${e.to}|${e.function ?? ''}`;

const keyOfExisting = (e: Node): string => {
  const from = (e['from'] as { node?: string } | undefined)?.node ?? '';
  const to = e['to'] as { node?: string; function?: string } | undefined;
  return edgeKey({ kind: String(e['kind']), from, to: to?.node ?? '', function: to?.function });
};

export interface MergePlan {
  ops: ManifestOp[];
  added: string[];
  updated: string[];
  /** Existing nodes the lift did not produce, split by who put them there. */
  authors: string[];
  stale: string[];
  /** Existing edges between lifted nodes that the code does not show. */
  staleEdges: string[];
}

/**
 * The ops that bring an existing canvas up to date with the lift, under the rules at
 * the top of this file. `wasLifted` decides, for a node the lift no longer produces,
 * whether a previous lift put it there (stale) or the author did (theirs).
 */
export function planMerge(
  existing: ExistingCanvas,
  desired: readonly DesiredNode[],
  edges: readonly ModelEdge[],
  verbs: Record<string, string>,
  wasLifted: (node: Node) => boolean,
): MergePlan {
  const plan: MergePlan = { ops: [], added: [], updated: [], authors: [], stale: [], staleEdges: [] };
  const byId = new Map(existing.nodes.map((n) => [n['id'] as string, n]));
  const occupied = Object.values(existing.layout);

  for (const want of desired) {
    const have = byId.get(want.id);
    if (!have) {
      plan.ops.push({ op: 'addNode', node: want.node });
      const at = freeSpot(want.at, occupied);
      occupied.push(at);
      plan.ops.push({ op: 'setLayout', id: want.id, ...at });
      plan.added.push(want.id);
      continue;
    }
    const patch: Node = {};
    for (const key of want.owned) {
      const value = want.node[key];
      // The lift has nothing to say (no dev script found): the author's value stands.
      if (value === undefined) continue;
      if (!sameValue(have[key], value)) patch[key] = value;
    }
    for (const key of want.union ?? []) {
      const mine = Array.isArray(have[key]) ? (have[key] as unknown[]) : [];
      const theirs = (want.node[key] as unknown[] | undefined) ?? [];
      const merged = [...mine, ...theirs.filter((v) => !mine.includes(v))];
      if (!sameValue(mine, merged) || have[key] === undefined) patch[key] = merged;
    }
    for (const key of want.fill ?? []) {
      if (have[key] === undefined && want.node[key] !== undefined) patch[key] = want.node[key];
    }
    if (Object.keys(patch).length) {
      plan.ops.push({ op: 'updateNode', id: want.id, patch });
      plan.updated.push(want.id);
    }
  }

  const wantedIds = new Set(desired.map((d) => d.id));
  for (const node of existing.nodes) {
    const id = node['id'] as string;
    if (wantedIds.has(id)) continue;
    (wasLifted(node) ? plan.stale : plan.authors).push(id);
  }

  const have = new Set(existing.edges.map(keyOfExisting));
  const wantedKeys = new Set(edges.map(edgeKey));
  const takeEdge = idAllocator(existing.edges.map((e) => e['id'] as string));
  for (const edge of edges) {
    if (have.has(edgeKey(edge))) continue;
    have.add(edgeKey(edge));
    const id = takeEdge(edgeIdFor(edge.from, verbs[edge.kind] ?? 'to', edge.to), 'edge');
    plan.ops.push({
      op: 'addEdge',
      edge: {
        id,
        kind: edge.kind,
        from: { node: edge.from },
        to: edge.function ? { node: edge.to, function: edge.function } : { node: edge.to },
      },
    });
  }
  // An edge between two nodes the lift produced that the code does not show (any
  // more): kept, and said. It may be one a previous lift drew or one the author drew
  // between lifted nodes — either way the repository does not back it, which is what
  // the author needs to know; whether it stays is theirs to decide.
  for (const edge of existing.edges) {
    const from = (edge['from'] as { node?: string } | undefined)?.node ?? '';
    const to = (edge['to'] as { node?: string } | undefined)?.node ?? '';
    if (wantedIds.has(from) && wantedIds.has(to) && !wantedKeys.has(keyOfExisting(edge))) {
      plan.staleEdges.push(String(edge['id']));
    }
  }
  return plan;
}
