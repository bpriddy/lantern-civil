import { buildContainment, MAX_CHILDREN, toSkeletonDomains } from './containment.js';
import type { FileMap, Skeleton, SkeletonDomain } from './skeleton.js';

/**
 * The views a lift writes beside the composition (docs/prd-deltas.md §21). The
 * composition holds every part once; a view only groups and places them.
 *
 * - **concept**: what the application is — its capabilities (a product feature and
 *   the services behind it) and the foundation they share, found by what the code
 *   reaches and weighed as claims (containment.ts, claims.ts). Deployables are how it
 *   is run, not what it is: clients and boundaries are not placed here.
 * - **architecture**: how the codebase is built — packages and source directories,
 *   holding the parts whose code is filed there. Read mechanically from where the
 *   code lives; folder layout is exactly the evidence this view is about.
 *
 * Both obey the readability rules: a domain holding one thing is that thing, a domain
 * holding nothing is not drawn, and a level over MAX_CHILDREN is noted.
 */

/** What the views need to know about a drawn part. */
export interface ViewPart {
  /** The lift's id for the composition node. */
  id: string;
  type: 'client' | 'boundary' | 'service' | 'process' | 'datastore';
  /** The skeleton entity it was drawn from. */
  entity?: string;
  /** Where its code is filed: a directory or a file, repo-relative. */
  home: string;
}

export interface ModelDomain {
  id: string;
  name: string;
  parent?: string;
  /** Lift ids of the parts directly inside. */
  members: string[];
  description?: string;
  foundation?: boolean;
  /** Where the reading rests, as "path" or "path:line". */
  evidence: string[];
  /** Lift ids of members placed on weak evidence. */
  unsure: string[];
}

export interface ModelView {
  id: string;
  name: string;
  description: string;
  unplaced: 'hide' | 'top';
  /** Lift ids of the parts drawn at the top level beside the top-level domains. */
  top: string[];
  domains: ModelDomain[];
  notes: string[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const kebab = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '') || 'domain';

/**
 * The readability pass shared by every view: a domain holding one thing gives it to
 * the level above, an empty domain goes, repeated until nothing changes; then the top
 * is counted. Pure over its input.
 */
export function tidy(view: ModelView): ModelView {
  const domains = new Map(view.domains.map((d) => [d.id, { ...d, members: [...d.members] }]));
  let top = [...view.top];
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of [...domains.values()]) {
      const children = [...domains.values()].filter((c) => c.parent === d.id);
      if (d.members.length + children.length > 1) continue;
      const up = d.parent !== undefined ? domains.get(d.parent) : undefined;
      if (up) up.members.push(...d.members);
      else top.push(...d.members);
      for (const c of children) {
        if (up) c.parent = up.id;
        else delete c.parent;
      }
      domains.delete(d.id);
      changed = true;
    }
  }
  top = [...new Set(top)].sort(byString);
  const kept = [...domains.values()].map((d) => ({ ...d, members: [...new Set(d.members)].sort(byString), unsure: d.unsure.filter((u) => d.members.includes(u)) }));
  const notes = [...view.notes];
  const count = top.length + kept.filter((d) => d.parent === undefined).length;
  if (count > MAX_CHILDREN) notes.push(`the ${view.id} view's top level holds ${count} things, more than ${MAX_CHILDREN}`);
  for (const d of kept) {
    const n = d.members.length + kept.filter((c) => c.parent === d.id).length;
    if (n > MAX_CHILDREN) notes.push(`the ${view.id} view's domain "${d.name}" holds ${n} things, more than ${MAX_CHILDREN}`);
  }
  return { ...view, top, domains: kept, notes };
}

/** The concept view from the skeleton's domains, or — without them — from the files. */
export function conceptView(
  parts: readonly ViewPart[],
  skeleton: Skeleton,
  files: FileMap | undefined,
  taken: Iterable<string>,
): ModelView | undefined {
  const containment = !skeleton.domains && files ? buildContainment(skeleton, files) : undefined;
  const found: SkeletonDomain[] = skeleton.domains ?? (containment ? toSkeletonDomains(containment) : []);
  if (found.length === 0) return undefined;
  const byEntity = new Map(parts.filter((p) => p.entity).map((p) => [p.entity!, p.id]));
  const used = new Set(taken);
  const idOf = new Map<string, string>();
  for (const d of found) {
    let id = kebab(d.id);
    for (let n = 2; used.has(id); n += 1) id = kebab(`${d.id}-${n}`);
    used.add(id);
    idOf.set(d.id, id);
  }
  const placed = new Set<string>();
  const domains: ModelDomain[] = found.map((d) => {
    const members = d.members.map((m) => byEntity.get(m)).filter((m): m is string => m !== undefined);
    for (const m of members) placed.add(m);
    return {
      id: idOf.get(d.id)!,
      name: d.name,
      ...(d.parent && idOf.has(d.parent) ? { parent: idOf.get(d.parent)! } : {}),
      members,
      ...(d.description ? { description: d.description } : {}),
      ...(d.foundation ? { foundation: true } : {}),
      evidence: [...new Set([...d.surfaces, d.source.file].filter(Boolean))],
      unsure: d.unsure.map((m) => byEntity.get(m)).filter((m): m is string => m !== undefined),
    };
  });
  // What the application is, not how it runs: services, the work that runs them, and
  // data. Clients, boundaries, and schedules that run no product code (a migration, a
  // scaling toggle) are left to the architecture view.
  const runsProduct = new Set(
    skeleton.processes.filter((p) => p.calls.some((c) => skeleton.services.some((s) => s.id === c && !s.infrastructure))).map((p) => p.id),
  );
  const top = parts
    .filter((p) => !placed.has(p.id))
    .filter((p) => p.type === 'service' || p.type === 'datastore' || (p.type === 'process' && p.entity !== undefined && runsProduct.has(p.entity)))
    .map((p) => p.id);
  return tidy({
    id: 'concept',
    name: 'Concept',
    description: 'What the application is: its capabilities and the foundation they share.',
    unplaced: 'hide',
    top,
    domains,
    notes: containment?.notes.filter((n) => !n.startsWith('the top level holds')) ?? [],
  });
}

/**
 * The architecture view: a domain per directory that holds more than one part beneath
 * it, nested as the directories are — so a chain of single-child directories is one
 * step, and the levels are the places the codebase actually branches.
 */
export function architectureView(parts: readonly ViewPart[], taken: Iterable<string>): ModelView | undefined {
  // As deep as needed and no deeper: a system that fits on one level needs no view.
  if (parts.length <= MAX_CHILDREN) return undefined;
  const dirOf = (home: string) => (/\.[a-z0-9]+$/i.test(home.split('/').pop() ?? '') ? home.split('/').slice(0, -1).join('/') : home);
  // Every directory on some part's path, with the parts directly beneath it.
  const under = new Map<string, Set<string>>(); // dir → part ids anywhere beneath
  for (const p of parts) {
    const segments = dirOf(p.home).split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i += 1) {
      const dir = segments.slice(0, i).join('/');
      under.set(dir, (under.get(dir) ?? new Set()).add(p.id));
    }
  }
  // A directory is a domain when it branches: two or more children, counting parts
  // filed directly in it and subdirectories that hold parts.
  const childrenOf = (dir: string) => {
    const subdirs = [...under.keys()].filter((d) => d.startsWith(`${dir}/`) && !d.slice(dir.length + 1).includes('/'));
    const direct = parts.filter((p) => dirOf(p.home) === dir).map((p) => p.id);
    return { subdirs, direct };
  };
  const roots = [...under.keys()].filter((d) => !d.includes('/'));
  const used = new Set(taken);
  const domains: ModelDomain[] = [];
  const top: string[] = parts.filter((p) => dirOf(p.home) === '').map((p) => p.id);
  const visit = (dir: string, parent: string | undefined, prefix: string) => {
    const { subdirs, direct } = childrenOf(dir);
    const branches = subdirs.length + direct.length >= 2;
    let here = parent;
    if (branches) {
      let id = kebab(dir.replace(/\//g, '-'));
      for (let n = 2; used.has(id); n += 1) id = kebab(`${dir.replace(/\//g, '-')}-${n}`);
      used.add(id);
      domains.push({
        id,
        name: prefix ? `${prefix}/${dir.split('/').pop()}` : dir.split('/').pop()!,
        ...(parent ? { parent } : {}),
        members: direct,
        evidence: [dir],
        unsure: [],
      });
      here = id;
    } else if (parent) {
      const holder = domains.find((d) => d.id === parent)!;
      holder.members.push(...direct);
    } else top.push(...direct);
    // A directory that does not branch is folded into the name of the next one that does.
    for (const sub of subdirs.sort(byString)) visit(sub, here, branches ? '' : prefix ? `${prefix}/${dir.split('/').pop()}` : dir.split('/').pop()!);
  };
  for (const root of roots.sort(byString)) visit(root, undefined, '');
  return tidy({
    id: 'architecture',
    name: 'Architecture',
    description: 'How the codebase is built: its packages and source directories, and the parts filed in each.',
    unplaced: 'top',
    top,
    domains,
    notes: [],
  });
}
