import type { Composition, CompositionEdge, CompositionNode } from '@civil/schema';

/**
 * One level of a composition (docs/prd-deltas.md §21): the nodes drawn inside one
 * domain, or at the top, and the edges between them. The composition stores every
 * edge once, between the units it connects; a level is a projection of that, so the
 * levels can never disagree with each other or with the file.
 *
 * - An edge between two things drawn here is drawn as it is.
 * - An edge from inside a domain drawn here rolls up to that domain: one line per
 *   pair and kind, counting what it stands for.
 * - An edge to something outside this domain ends at a stub that names it: the
 *   highest thing on its side that does not contain this level.
 * - An edge wholly inside one domain drawn here is that domain's business, not drawn.
 */

export interface LevelEdge {
  id: string;
  kind: CompositionEdge['kind'];
  from: string;
  to: string;
  /** The stored edges this line stands for; one for an edge drawn as it is. */
  count: number;
  /** False for a rolled-up line or one to a stub: it is not in the file, so it cannot be edited. */
  stored: boolean;
}

export interface OutsideStub {
  /** The node id the canvas uses: "outside:" + the node it stands for. */
  id: string;
  /** The node it stands for: a leaf at the top, or the domain holding the far end. */
  target: string;
  /** Where it is, outermost first: domain names, then its own. */
  path: string[];
  /** Whether lines run into this level from it, out of this level to it, or both. */
  side: 'in' | 'out' | 'both';
}

export interface Level {
  nodes: CompositionNode[];
  edges: LevelEdge[];
  outside: OutsideStub[];
}

export const OUTSIDE = 'outside:';

/** A node's chain of domains, outermost first, ending with the node itself. */
export function chainOf(byId: ReadonlyMap<string, CompositionNode>, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  // A parent that is not a node is ignored (validation reports it): the node is drawn
  // as if at the level above, never lost.
  for (let at: string | undefined = id; at !== undefined && !seen.has(at) && (at === id || byId.has(at)); at = byId.get(at)?.parent) {
    seen.add(at);
    chain.unshift(at);
  }
  return chain;
}

export const nameOf = (node: CompositionNode | undefined, id: string): string =>
  node?.type === 'domain' && node.name ? node.name : id;

export function projectLevel(composition: Pick<Composition, 'spec'>, scope?: string): Level {
  const { nodes, edges } = composition.spec;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const scopeChain = scope ? chainOf(byId, scope) : [];
  const visible = nodes.filter((n) => {
    const chain = chainOf(byId, n.id);
    return chain.length === scopeChain.length + 1 && scopeChain.every((d, i) => chain[i] === d);
  });

  /** Where an end of an edge is drawn on this level: a node here, a stub, or nowhere (inside a sibling's interior). */
  const placeOf = (id: string): { at: string; outside: boolean } => {
    const chain = chainOf(byId, id);
    // Inside this level: the chain passes through every domain of scope's chain.
    const inside = scopeChain.every((d, i) => chain[i] === d) && chain.length > scopeChain.length;
    if (inside) return { at: chain[scopeChain.length]!, outside: false };
    // Outside: the first thing on its chain that is not one of this level's ancestors.
    let k = 0;
    while (k < chain.length && k < scopeChain.length && chain[k] === scopeChain[k]) k += 1;
    return { at: chain[k] ?? id, outside: true };
  };

  const lines = new Map<string, LevelEdge>();
  const stubs = new Map<string, OutsideStub>();
  for (const edge of edges) {
    const from = placeOf(edge.from.node);
    const to = placeOf(edge.to.node);
    if (from.outside && to.outside) continue;
    if (!from.outside && !to.outside && from.at === to.at) continue;
    const exact = !from.outside && !to.outside && from.at === edge.from.node && to.at === edge.to.node;
    if (exact) {
      lines.set(edge.id, { id: edge.id, kind: edge.kind, from: from.at, to: to.at, count: 1, stored: true });
      continue;
    }
    const end = (place: { at: string; outside: boolean }, side: 'in' | 'out') => {
      if (!place.outside) return place.at;
      const id = `${OUTSIDE}${place.at}`;
      const known = stubs.get(id);
      if (known) {
        if (known.side !== side) known.side = 'both';
      } else {
        stubs.set(id, {
          id,
          target: place.at,
          path: chainOf(byId, place.at).map((d) => nameOf(byId.get(d), d)),
          side,
        });
      }
      return id;
    };
    const a = end(from, 'in');
    const b = end(to, 'out');
    const key = `rollup:${a}->${b}:${edge.kind}`;
    const line = lines.get(key);
    if (line) line.count += 1;
    else lines.set(key, { id: key, kind: edge.kind, from: a, to: b, count: 1, stored: false });
  }

  const byString = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return {
    nodes: visible,
    edges: [...lines.values()],
    outside: [...stubs.values()].sort((x, y) => byString(x.id, y.id)),
  };
}

/** What a domain holds, for its face: "3 services · 1 process · 2 domains". */
export function domainSummary(composition: Pick<Composition, 'spec'>, domain: string): string {
  const counts = new Map<string, number>();
  for (const n of composition.spec.nodes) {
    if (n.parent !== domain) continue;
    counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
  }
  const order = ['domain', 'service', 'process', 'datastore', 'boundary', 'client'];
  const words: Record<string, [string, string]> = {
    domain: ['domain', 'domains'],
    service: ['service', 'services'],
    process: ['process', 'processes'],
    datastore: ['store', 'stores'],
    boundary: ['boundary', 'boundaries'],
    client: ['client', 'clients'],
  };
  const parts = order.filter((t) => counts.has(t)).map((t) => `${counts.get(t)} ${words[t]![counts.get(t) === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(' · ') : 'empty';
}
