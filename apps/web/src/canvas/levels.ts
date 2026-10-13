import type { Composition, CompositionEdge, CompositionNode, Domain, View } from '@civil/schema';

/**
 * One level of one view (docs/prd-deltas.md §21). The composition holds every part and
 * every edge once; a view groups and places the parts. A level is a projection of both,
 * so no level can disagree with another or with the file:
 *
 * - An edge between two things drawn here is drawn as it is.
 * - An edge from inside a domain drawn here rolls up to that domain: one line per pair
 *   and kind, counting what it stands for.
 * - An edge to something outside this domain ends at a stub that names it: the highest
 *   thing on its side that does not contain this level.
 * - An edge wholly inside one domain drawn here is that domain's business, not drawn.
 * - An edge to a part the view hides is not drawn.
 *
 * With no view, every part is at the top: the composition as written.
 */

/** A view as the bundle carries it. */
export interface LoadedView {
  path: string;
  view: View;
  domains: Record<string, { path: string; doc: Domain }>;
}

/** What the canvas draws for a domain: it is not a composition node, it is the view's. */
export interface DomainItem {
  id: string;
  type: 'domain';
  name: string;
  /** The domain's file, which holds its members and the layout of its inside. */
  path: string;
  /** The view it belongs to. */
  view: string;
  description?: string;
  foundation?: boolean;
  evidence?: string[];
  unsure?: string[];
}

export type LevelItem = { kind: 'part'; node: CompositionNode } | { kind: 'domain'; domain: DomainItem };

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
  /** The node id the canvas uses: "outside:" + what it stands for. */
  id: string;
  /** A part at the top, or the domain holding the far end. */
  target: string;
  /** Where it is, outermost first: domain names, then its own. */
  path: string[];
  /** Whether lines run into this level from it, out of this level to it, or both. */
  side: 'in' | 'out' | 'both';
}

export interface Level {
  items: LevelItem[];
  edges: LevelEdge[];
  outside: OutsideStub[];
  /** The file whose layout places this level: the composition, the view, or a domain. */
  layoutPath?: string;
  layout: Record<string, { x: number; y: number }>;
}

export const OUTSIDE = 'outside:';

/** Where every part and domain of a view sits: its domain, or the top; and what is hidden. */
export interface Containment {
  parentOf: Map<string, string | undefined>;
  domains: Map<string, DomainItem>;
  hidden: Set<string>;
}

export function containmentOf(loaded: LoadedView, parts: readonly string[]): Containment {
  const parentOf = new Map<string, string | undefined>();
  const domains = new Map<string, DomainItem>();
  for (const [id, { path, doc }] of Object.entries(loaded.domains)) {
    domains.set(id, {
      id,
      type: 'domain',
      name: doc.metadata.name ?? id,
      path,
      view: loaded.view.metadata.id,
      ...(doc.spec.description ? { description: doc.spec.description } : {}),
      ...(doc.spec.foundation ? { foundation: true } : {}),
      ...(doc.spec.evidence ? { evidence: doc.spec.evidence } : {}),
      ...(doc.spec.unsure?.length ? { unsure: doc.spec.unsure } : {}),
    });
    parentOf.set(id, doc.spec.parent !== undefined && loaded.domains[doc.spec.parent] ? doc.spec.parent : undefined);
    for (const m of doc.spec.members) if (!parentOf.has(m)) parentOf.set(m, id);
  }
  for (const m of loaded.view.spec.members) if (!parentOf.has(m)) parentOf.set(m, undefined);
  const hidden = new Set<string>();
  for (const p of parts) {
    if (parentOf.has(p)) continue;
    if (loaded.view.spec.unplaced === 'hide') hidden.add(p);
    else parentOf.set(p, undefined);
  }
  return { parentOf, domains, hidden };
}

/** A node's chain of domains, outermost first, ending with itself. */
export function chainOf(c: Containment | undefined, id: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  for (let at: string | undefined = id; at !== undefined && !seen.has(at); at = c?.parentOf.get(at)) {
    seen.add(at);
    chain.unshift(at);
  }
  return chain;
}

export function projectLevel(
  composition: Pick<Composition, 'spec' | 'layout'>,
  compositionPath: string,
  loaded?: LoadedView,
  scope?: string,
): Level {
  const view = loaded ? { loaded } : undefined;
  const { nodes, edges } = composition.spec;
  const c = view ? containmentOf(view.loaded, nodes.map((n) => n.id)) : undefined;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nameOf = (id: string) => c?.domains.get(id)?.name ?? id;
  const scopeChain = scope ? chainOf(c, scope) : [];
  const visible = (id: string) => !c?.hidden.has(id);

  const items: LevelItem[] = [];
  const here = (id: string) => {
    const chain = chainOf(c, id);
    return chain.length === scopeChain.length + 1 && scopeChain.every((d, i) => chain[i] === d);
  };
  for (const d of c?.domains.values() ?? []) if (here(d.id)) items.push({ kind: 'domain', domain: d });
  for (const n of nodes) if (visible(n.id) && here(n.id)) items.push({ kind: 'part', node: n });

  /** Where an end of an edge is drawn on this level: a node here, or a stub. */
  const placeOf = (id: string): { at: string; outside: boolean } => {
    const chain = chainOf(c, id);
    const inside = scopeChain.every((d, i) => chain[i] === d) && chain.length > scopeChain.length;
    if (inside) return { at: chain[scopeChain.length]!, outside: false };
    let k = 0;
    while (k < chain.length && k < scopeChain.length && chain[k] === scopeChain[k]) k += 1;
    return { at: chain[k] ?? id, outside: true };
  };

  const lines = new Map<string, LevelEdge>();
  const stubs = new Map<string, OutsideStub>();
  for (const edge of edges) {
    if (!visible(edge.from.node) || !visible(edge.to.node)) continue;
    if (!byId.has(edge.from.node) || !byId.has(edge.to.node)) continue;
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
        stubs.set(id, { id, target: place.at, path: chainOf(c, place.at).map(nameOf), side });
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

  // Positions: the composition's own layout with no view; the view's for its top; a
  // domain's file for its inside.
  const layoutPath = !view ? compositionPath : scope ? c?.domains.get(scope)?.path : view.loaded.path;
  const layout = !view
    ? composition.layout.nodes
    : scope
      ? (view.loaded.domains[scope]?.doc.layout.nodes ?? {})
      : view.loaded.view.layout.nodes;

  const byString = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return {
    items,
    edges: [...lines.values()],
    outside: [...stubs.values()].sort((x, y) => byString(x.id, y.id)),
    ...(layoutPath ? { layoutPath } : {}),
    layout,
  };
}

/** What a domain holds, for its face: "3 services · 1 process · 2 domains". */
export function domainSummary(composition: Pick<Composition, 'spec'>, loaded: LoadedView, domain: string): string {
  const counts = new Map<string, number>();
  const types = new Map(composition.spec.nodes.map((n) => [n.id, n.type]));
  for (const m of loaded.domains[domain]?.doc.spec.members ?? []) {
    const t = types.get(m);
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const inner = Object.values(loaded.domains).filter((d) => d.doc.spec.parent === domain).length;
  if (inner) counts.set('domain', inner);
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
