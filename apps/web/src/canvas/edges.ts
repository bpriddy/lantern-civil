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

/** PRD 4: routes-to originates at a client; depends-on terminates at a service. */
export function proposeCompositionEdge(
  nodes: readonly CompositionNode[],
  connection: Connection,
): EdgeProposal {
  const index = byId(nodes);
  const from = index.get(connection.source);
  const to = index.get(connection.target);
  if (!from || !to) return { kind: '', refusal: 'One end of that connection is not a node.' };

  if (from.type === 'service' && to.type === 'client') {
    return { kind: '', refusal: 'Traffic flows client → service. Clients are never edge targets of services.' };
  }
  if (from.type === 'client') {
    if (to.type === 'process') {
      return { kind: '', refusal: 'A process has a trigger, not a caller.' };
    }
    return { kind: 'routes-to' };
  }
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
