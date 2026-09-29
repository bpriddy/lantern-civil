import type { CompositionNode, GraphNode } from '@civil/schema';

/**
 * What kind of edge a connection is, decided by what it connects.
 *
 * PRD 7: "edge kind inferred from endpoint types". The two altitudes have entirely
 * separate vocabularies — PRD 1 calls keeping them apart load-bearing, because an
 * edge meaning "this route calls that handler" and one meaning "this output feeds
 * that input" look identical and mean unrelated things.
 *
 * Inference happens here, on the client, but the result is sent explicitly in the op.
 * An op that says what it did is one an agent can read back; an op that relies on the
 * server re-deriving intent is not.
 */

export type Connection = { source: string; target: string };

export interface EdgeProposal {
  kind: string;
  /** Why it is not allowed, when it is not. */
  refusal?: string;
}

const byId = <T extends { id: string }>(nodes: readonly T[]) =>
  new Map(nodes.map((n) => [n.id, n]));

/**
 * Traffic is client → boundary → service (the owner's revision of PRD 4); a
 * dependency terminates at a service. Everything else is refused in words at the
 * moment of the gesture.
 */
export function proposeCompositionEdge(
  nodes: readonly CompositionNode[],
  connection: Connection,
): EdgeProposal {
  const index = byId(nodes);
  const from = index.get(connection.source);
  const to = index.get(connection.target);
  if (!from || !to) return { kind: '', refusal: 'One end of that connection is not a node.' };

  if (to.type === 'client') {
    return { kind: '', refusal: 'A client consumes; nothing routes to it.' };
  }
  if (to.type === 'process') {
    return { kind: '', refusal: 'A process has a trigger, not a caller.' };
  }
  if (from.type === 'client') {
    if (to.type === 'boundary') return { kind: 'routes-to' };
    return { kind: '', refusal: 'A client reaches services through a boundary, not directly.' };
  }
  if (from.type === 'boundary') {
    if (to.type === 'service') return { kind: 'routes-to' };
    return { kind: '', refusal: 'A boundary exposes services, not other boundaries.' };
  }
  // service or process → …
  if (to.type !== 'service') {
    return { kind: '', refusal: 'Only a service can be depended on.' };
  }
  return { kind: 'depends-on' };
}

/**
 * PRD 5: capability edges originate at an agent and terminate at a code node; flow
 * edges are everything else, and io nodes are directional so inputs are sources and
 * outputs are sinks.
 */
export function proposeGraphEdge(
  nodes: readonly GraphNode[],
  connection: Connection,
): EdgeProposal {
  const index = byId(nodes);
  const from = index.get(connection.source);
  const to = index.get(connection.target);
  if (!from || !to) return { kind: '', refusal: 'One end of that connection is not a node.' };

  if (from.type === 'agent' && to.type === 'code') return { kind: 'capability' };

  if (from.type === 'io' && from.direction === 'out') {
    return { kind: '', refusal: 'An output is a sink; nothing flows out of it.' };
  }
  if (to.type === 'io' && to.direction === 'in') {
    return { kind: '', refusal: 'An input is a source; nothing flows into it.' };
  }
  return { kind: 'flow' };
}

/** A short id that does not collide, in the style the manifests already use. */
export function nextEdgeId(existing: readonly string[], prefix: string): string {
  const taken = new Set(existing);
  for (let n = 1; ; n += 1) {
    const candidate = `${prefix}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The slice of a composition exposesSync reads — its nodes and edges, nothing else. */
export interface CompositionShape {
  spec: {
    nodes: readonly CompositionNode[];
    edges: readonly { id: string; kind: string; from: { node: string }; to: { node: string } }[];
  };
}

export type ExposesPatch = { op: 'updateNode'; id: string; patch: Record<string, unknown> };

/**
 * A boundary serves what its `exposes` list names — the transpiler and the typed web
 * client read the list, not the edges. So the gesture that draws boundary → service
 * is the gesture that exposes it, and deleting the last such edge withdraws it. This
 * returns the updateNode ops that keep the list in step with an edge change, sent in
 * the same batch so the pair lands, previews and undoes as one.
 *
 * Only what the edges account for moves: a service listed with no edge (typed into the
 * inspector) is left alone, and an invocation override for a withdrawn service goes
 * with it, because an override naming an unexposed service fails validation.
 */
export function exposesSync(
  composition: CompositionShape | undefined,
  change: {
    added?: readonly { kind?: unknown; from?: { node?: string }; to?: { node?: string } }[];
    removedIds?: readonly string[];
  },
): ExposesPatch[] {
  if (!composition) return [];
  const index = byId(composition.spec.nodes);
  const removed = new Set(change.removedIds ?? []);

  // A routes-to edge from a boundary to a service is a statement about exposure.
  const exposure = (edge: { kind?: unknown; from?: { node?: string }; to?: { node?: string } }) => {
    const from = index.get(edge.from?.node ?? '');
    const to = index.get(edge.to?.node ?? '');
    if (edge.kind !== 'routes-to' || from?.type !== 'boundary' || to?.type !== 'service') return null;
    return { boundary: from, service: to.id };
  };

  const additions = new Map<string, string[]>();
  for (const edge of change.added ?? []) {
    const hit = exposure(edge);
    if (hit) additions.set(hit.boundary.id, [...(additions.get(hit.boundary.id) ?? []), hit.service]);
  }

  // Withdrawn only when no surviving or newly drawn edge still routes there.
  const surviving = new Set<string>();
  const withdrawals = new Map<string, Set<string>>();
  for (const edge of composition.spec.edges) {
    const hit = exposure(edge);
    if (!hit) continue;
    const key = `${hit.boundary.id}\u0000${hit.service}`;
    if (!removed.has(edge.id)) surviving.add(key);
    else withdrawals.set(hit.boundary.id, (withdrawals.get(hit.boundary.id) ?? new Set()).add(hit.service));
  }

  const ops: ExposesPatch[] = [];
  for (const id of new Set([...additions.keys(), ...withdrawals.keys()])) {
    const boundary = index.get(id);
    if (boundary?.type !== 'boundary') continue;
    const added = additions.get(id) ?? [];
    const gone = [...(withdrawals.get(id) ?? [])].filter(
      (service) => !surviving.has(`${id}\u0000${service}`) && !added.includes(service),
    );
    const exposes = [
      ...boundary.exposes.filter((service) => !gone.includes(service)),
      ...added.filter((service, i) => !boundary.exposes.includes(service) && added.indexOf(service) === i),
    ];
    if (exposes.length === boundary.exposes.length && exposes.every((s, i) => s === boundary.exposes[i])) {
      continue;
    }
    const patch: Record<string, unknown> = { exposes };
    const invocation = boundary.invocation;
    if (invocation && gone.some((service) => service in invocation)) {
      const kept = Object.fromEntries(Object.entries(invocation).filter(([service]) => !gone.includes(service)));
      patch['invocation'] = Object.keys(kept).length > 0 ? kept : null;
    }
    ops.push({ op: 'updateNode', id, patch });
  }
  return ops;
}
