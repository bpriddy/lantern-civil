import { posix } from 'node:path';
import ts from 'typescript';
import { byString, isTestSupport, isUnder, RepoContext } from './read.js';
import type { Evidence } from './claims.js';
import type { FileMap, Skeleton, SkeletonService } from './skeleton.js';

/**
 * Containment: the levels a lifted graph is drawn at (docs/lift-repo.md, "Levels").
 * Owner's rules, 2026-10-13:
 *
 * 1. Containment is recursive and as deep as the codebase needs.
 * 2. The top is the whole system; the bottom is code.
 * 3. Every level is readable on its own: at most MAX_CHILDREN things.
 * 4. Edges roll up: a level shows one edge between two domains (the canvas's job).
 * 5. Domains come from evidence in the code, and Civil says when it is unsure.
 *
 * Units are found by what the code reaches, not by where it is filed. A product
 * surface — a frontend feature directory — and the backend service it talks to reach
 * the same shared files (a contract, a route table, a type); that shared reach is what
 * makes them one capability, wherever each is filed. A service no surface reaches is
 * used by capabilities: inside the one capability that uses it, or, when several do,
 * in the shared foundation. Folder layout is supporting evidence only: it names a
 * domain and splits an overfull foundation, never decides a capability.
 *
 * Deterministic and pure: the same skeleton and files give the same tree. The model
 * names, describes, and judges what is marked unsure (analysts.ts); it does not draw
 * the tree.
 */

/** Children one level may hold before it is split or flagged (owner's rule 3). */
export const MAX_CHILDREN = 12;

/** A capability or a part of the foundation: something you step into. */
export interface Domain {
  /** kebab-case, unique among the composition's ids: "billing-domain" beside a "billing" service. */
  id: string;
  /** What the canvas shows: from the surface, the service, or the directory; the model may rename it. */
  name: string;
  /** Skeleton entity ids directly inside: services, processes, datastores. */
  members: string[];
  domains: Domain[];
  /** True for the shared foundation and its parts. */
  foundation?: boolean;
  /** Frontend feature directories this capability is the backend of. */
  surfaces: string[];
  /** Why it exists: the files and lines a reader would check. */
  evidence: Evidence[];
  /** Members placed on weak evidence: the analysts are asked about these. */
  unsure: string[];
}

export interface Containment {
  /** The top level: entity ids drawn there, and the domains. */
  members: string[];
  domains: Domain[];
  /** Entity id → the domain it is directly inside; absent at the top. */
  parentOf: Record<string, string>;
  /** Domain id → its parent domain; absent at the top. */
  domainParentOf: Record<string, string>;
  /** What was decided on weak evidence or could not be decided, in words. */
  notes: string[];
}

/** Directories under a client that hold one directory per product area, by convention. */
const FEATURE_ROOTS = new Set(['features', 'pages', 'modules', 'views', 'screens', 'routes', 'areas', 'domains', 'apps']);
const CODE = /\.(m?[tj]sx?)$/;

/** Every file a file imports or re-exports from, resolved within the repository. */
function importsOf(ctx: RepoContext, file: string): string[] {
  const sf = ctx.sourceFile(file);
  if (!sf) return [];
  const out = new Set<string>();
  const add = (specifier: string) => {
    const hit = ctx.resolve(file, specifier);
    if (hit.kind === 'file') out.add(hit.path);
  };
  for (const stmt of sf.statements) {
    if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      add(stmt.moduleSpecifier.text);
    }
  }
  return [...out].sort(byString);
}

/**
 * What a set of files reaches: walking imports from it while `inside` holds, and
 * collecting every file reached outside it. The walk stops at the boundary, so a
 * feature's reach is what it uses from elsewhere, not the whole program.
 */
function reachOf(ctx: RepoContext, start: readonly string[], inside: (f: string) => boolean): Set<string> {
  const seen = new Set<string>(start);
  const outside = new Set<string>();
  const queue = [...start];
  while (queue.length) {
    const file = queue.pop()!;
    for (const next of importsOf(ctx, file)) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (inside(next)) queue.push(next);
      else outside.add(next);
    }
  }
  return outside;
}

/** The files a service owns: its directory when it has one, else its listed files. */
function ownFiles(service: SkeletonService, all: readonly string[]): string[] {
  if (service.directory) return all.filter((f) => isUnder(f, service.directory!) && CODE.test(f));
  return [
    ...new Set([service.source.file, ...(service.files ?? []), ...service.controllers.map((c) => c.file), ...service.providers.map((p) => p.file)]),
  ];
}

interface Surface {
  /** The feature directory: "apps/web/src/features/billing". */
  dir: string;
  files: string[];
}

/**
 * A client's product surfaces: the child directories of its feature root — the
 * conventional directory (features/, pages/, …) with the most children, at least two.
 * None when the client keeps no such directory; the capabilities are then the
 * services a client-free reading can tell apart (see seedsWithoutSurfaces).
 */
function surfacesOf(clientPath: string, files: readonly string[]): Surface[] {
  const code = files.filter((f) => isUnder(f, clientPath) && CODE.test(f) && !isTestSupport(f) && !/\.(test|spec)\./.test(f));
  const children = new Map<string, Set<string>>();
  for (const f of code) {
    const segments = f.slice(clientPath ? clientPath.length + 1 : 0).split('/');
    for (let i = 0; i < segments.length - 2; i += 1) {
      if (!FEATURE_ROOTS.has(segments[i]!)) continue;
      const root = posix.join(clientPath, ...segments.slice(0, i + 1));
      children.set(root, (children.get(root) ?? new Set()).add(segments[i + 1]!));
    }
  }
  const [root] = [...children.entries()].filter(([, c]) => c.size >= 2).sort((a, b) => b[1].size - a[1].size || byString(a[0], b[0]));
  if (!root) return [];
  return [...root[1]].sort(byString).map((name) => {
    const dir = `${root[0]}/${name}`;
    return { dir, files: code.filter((f) => isUnder(f, dir)) };
  });
}

const titleCase = (id: string): string => {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
};

const kebab = (text: string): string =>
  text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'domain';

/**
 * The containment tree for a skeleton. `files` is what the reader read: imports are
 * walked through it, so reach is only as complete as the read.
 */
export function buildContainment(skeleton: Skeleton, files: FileMap): Containment {
  const notes: string[] = [];
  const services = skeleton.services.filter((s) => !s.infrastructure).sort((a, b) => byString(a.id, b.id));
  // Levels only where the codebase needs them: a system that fits on one readable
  // level is drawn on one (rule 1 — as deep as needed, and no deeper).
  const flat = [
    ...skeleton.clients.map((c) => c.id),
    ...skeleton.servers.map((s) => s.id),
    ...services.map((s) => s.id),
    ...skeleton.processes.map((p) => p.id),
    ...(skeleton.datastores ?? []).map((d) => d.id),
  ];
  if (flat.length <= MAX_CHILDREN) return { members: flat.sort(byString), domains: [], parentOf: {}, domainParentOf: {}, notes };
  const ctx = new RepoContext(files);
  const all = Object.keys(files).sort(byString);
  const ids = new Set(services.map((s) => s.id));
  const own = new Map(services.map((s) => [s.id, ownFiles(s, all)]));
  const ownerOf = new Map<string, string>();
  for (const [id, list] of own) for (const f of list) if (!ownerOf.has(f)) ownerOf.set(f, id);

  // --- 1. Reach: what each service and each surface uses from outside itself. ---
  // A service's walk stays in its own files; a surface's walk stays in its client, so
  // both collect what they share with the rest of the repository.
  const serviceReach = new Map<string, Set<string>>();
  for (const s of services) {
    const mine = new Set(own.get(s.id));
    serviceReach.set(s.id, reachOf(ctx, [...mine], (f) => mine.has(f)));
  }
  const surfaces = skeleton.clients.flatMap((c) => surfacesOf(c.path, all).map((s) => ({ ...s, client: c.path })));
  const surfaceReach = new Map(
    surfaces.map((s) => [s.dir, reachOf(ctx, s.files, (f) => isUnder(f, s.client) && !surfaces.some((o) => o.dir !== s.dir && isUnder(f, o.dir)))]),
  );

  // How many units reach each file: a file everything reaches (a base contract, a
  // client helper) says nothing about which belong together.
  const reachers = new Map<string, number>();
  for (const set of [...serviceReach.values(), ...surfaceReach.values()]) for (const f of set) reachers.set(f, (reachers.get(f) ?? 0) + 1);
  const units = serviceReach.size + surfaceReach.size;
  const weight = (f: string) => Math.log((units + 1) / (reachers.get(f) ?? 1));
  // A file a service owns counts as that service: a surface importing it reaches it.
  const serviceTouches = (id: string) => new Set([...serviceReach.get(id)!, ...own.get(id)!]);

  // --- 2. Link each surface to the services it is the frontend of. ---
  const surfaceOf = new Map<string, string[]>(); // service id → surface dirs
  const linkEvidence = new Map<string, Evidence[]>(); // service id → evidence
  const surfaceUses = new Map<string, string[]>(); // service id → surfaces that use it without being its frontend
  for (const surface of surfaces) {
    const reach = surfaceReach.get(surface.dir)!;
    const name = kebab(posix.basename(surface.dir));
    const scored = services
      .map((s) => {
        const touches = serviceTouches(s.id);
        const shared = [...reach].filter((f) => touches.has(f) && reachers.get(f)! <= Math.max(3, Math.ceil(units / 5)));
        const named = s.id === name || (s.directory && kebab(posix.basename(s.directory)) === name);
        return { id: s.id, shared, score: shared.reduce((n, f) => n + weight(f), 0) + (named ? 2 : 0), named: !!named };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || byString(a.id, b.id));
    if (!scored.length) continue;
    // The surface's backend: the service named like it, when one is linked; otherwise
    // the best match and any near tie (a screen over two services is one capability
    // spanning both).
    const named = scored.filter((x) => x.named);
    const hits = named.length ? named : scored.filter((x) => x.score >= scored[0]!.score * 0.9);
    // The rest it reaches are services it uses, the way one service uses another.
    for (const other of scored.filter((x) => !hits.includes(x) && x.shared.length > 0)) {
      surfaceUses.set(other.id, [...(surfaceUses.get(other.id) ?? []), surface.dir]);
    }
    for (const hit of hits) {
      surfaceOf.set(hit.id, [...(surfaceOf.get(hit.id) ?? []), surface.dir]);
      const evidence = hit.shared.slice(0, 2).map((f) => ({ file: f }));
      linkEvidence.set(hit.id, [...(linkEvidence.get(hit.id) ?? []), { file: surface.files[0]! }, ...evidence]);
    }
  }

  // --- 3. Capabilities: services that are a surface's backend, joined when one
  //        surface spans several. Without surfaces, the tops of the dependency graph.
  const seeds = surfaces.length ? services.filter((s) => surfaceOf.has(s.id)).map((s) => s.id) : seedsWithoutSurfaces(skeleton, services);
  if (!surfaces.length) notes.push('no frontend feature directories found: capabilities are the services the API serves that nothing else depends on');
  const groupOf = new Map(seeds.map((id) => [id, id]));
  const find = (id: string): string => (groupOf.get(id) === id ? id : find(groupOf.get(id)!));
  for (const surface of surfaces) {
    const backends = seeds.filter((id) => surfaceOf.get(id)?.includes(surface.dir));
    for (const other of backends.slice(1)) groupOf.set(find(other), find(backends[0]!));
  }
  const capabilityOfSeed = new Map(seeds.map((id) => [id, find(id)]));

  // --- 4. Every other service: inside the one capability that uses it, else foundation. ---
  const dependents = new Map<string, Set<string>>();
  for (const s of services) for (const d of s.dependsOn) if (ids.has(d) && d !== s.id) dependents.set(d, (dependents.get(d) ?? new Set()).add(s.id));
  /** The capabilities that reach a service, through services that are not capabilities. */
  const capabilityOfSurface = (dir: string) => seeds.find((id) => surfaceOf.get(id)?.includes(dir));
  const usersOf = (id: string): Set<string> => {
    const found = new Set<string>();
    for (const dir of surfaceUses.get(id) ?? []) {
      const seed = capabilityOfSurface(dir);
      if (seed) found.add(capabilityOfSeed.get(seed)!);
    }
    const seen = new Set<string>([id]);
    const queue = [id];
    while (queue.length) {
      for (const d of dependents.get(queue.pop()!) ?? []) {
        if (seen.has(d)) continue;
        seen.add(d);
        if (capabilityOfSeed.has(d)) found.add(capabilityOfSeed.get(d)!);
        else queue.push(d);
      }
    }
    return found;
  };
  const capabilityOf = new Map<string, string>(capabilityOfSeed); // service id → capability key
  const foundation: string[] = [];
  const unsureFoundation: string[] = [];
  for (const s of services) {
    if (capabilityOfSeed.has(s.id)) continue;
    const users = usersOf(s.id);
    if (users.size === 1) capabilityOf.set(s.id, [...users][0]!);
    else {
      foundation.push(s.id);
      if (users.size === 0) unsureFoundation.push(s.id);
    }
  }
  if (unsureFoundation.length) notes.push(`no capability was seen using ${unsureFoundation.join(', ')}: put in the foundation, unsure`);

  // --- 5. One domain per capability: its services, its work, and its stores. ---
  const domains: Domain[] = [];
  const domainIds = new Set<string>();
  /** A domain id never takes an entity's: both live in one composition. */
  const takeId = (wanted: string) => {
    let id = ids.has(wanted) || skeleton.processes.some((p) => p.id === wanted) ? `${wanted}-domain` : wanted;
    for (let n = 2; domainIds.has(id); n += 1) id = `${wanted}-domain-${n}`;
    domainIds.add(id);
    return id;
  };
  for (const key of [...new Set(capabilityOfSeed.values())].sort(byString)) {
    const backends = seeds.filter((id) => capabilityOfSeed.get(id) === key);
    const inside = services.filter((s) => capabilityOf.get(s.id) === key).map((s) => s.id);
    const surfaceDirs = [...new Set(backends.flatMap((id) => surfaceOf.get(id) ?? []))].sort(byString);
    // Named for its surface when it spans several services; for its service otherwise.
    const spanning = backends.length > 1 && surfaceDirs.length ? kebab(posix.basename(surfaceDirs[0]!)) : key;
    domains.push({
      id: takeId(spanning),
      name: titleCase(spanning),
      members: inside,
      domains: [],
      surfaces: surfaceDirs,
      evidence: dedupe(backends.flatMap((id) => linkEvidence.get(id) ?? sourceOf(skeleton, id))),
      unsure: inside.filter((m) => !capabilityOfSeed.has(m) && usersOf(m).size === 0),
    });
  }

  // Background work goes with what it runs, when that is one capability.
  for (const p of skeleton.processes) {
    const homes = new Set(p.calls.filter((c) => ids.has(c)).map((c) => domains.find((d) => d.members.includes(c))?.id ?? 'foundation'));
    if (homes.size === 1 && !homes.has('foundation')) {
      domains.find((d) => d.id === [...homes][0])!.members.push(p.id);
    } else if (homes.size === 1) foundation.push(p.id);
  }
  // A store only one capability uses is part of it; a shared store stays at the top.
  for (const store of skeleton.datastores ?? []) {
    const users = new Set(services.filter((s) => s.dependsOn.includes(store.id)).map((s) => domains.find((d) => d.members.includes(s.id))?.id ?? 'foundation'));
    if (users.size === 1 && !users.has('foundation')) domains.find((d) => d.id === [...users][0])!.members.push(store.id);
  }

  // --- 6. The foundation, split by where it is filed when it is too big to read. ---
  if (foundation.length) {
    const found: Domain = {
      id: takeId('foundation'),
      name: 'Foundation',
      members: [],
      domains: [],
      foundation: true,
      surfaces: [],
      evidence: dedupe(foundation.flatMap((id) => sourceOf(skeleton, id))).slice(0, 4),
      unsure: unsureFoundation,
    };
    if (foundation.length > MAX_CHILDREN) {
      // Work is filed where its code is, not where its schedule is declared.
      const fileOf = (id: string): string => {
        const p = skeleton.processes.find((x) => x.id === id);
        const target = p?.calls.find((c) => ids.has(c));
        return sourceOf(skeleton, target ?? id)[0]?.file ?? '';
      };
      const parts = splitByDirectory(foundation, fileOf);
      // A split helps only when it gives at least two real groups; one group and some
      // loose ends is the same foundation one level deeper.
      const groups = parts.filter((p) => p.members.length >= 2);
      if (groups.length < 2) {
        found.members.push(...foundation);
        notes.push(`the foundation holds ${foundation.length} things and its files do not divide it: it is drawn on one level`);
      } else for (const part of parts) {
        if (part.members.length < 2) found.members.push(...part.members);
        else
          found.domains.push({
            id: takeId(part.name),
            name: titleCase(part.name),
            members: part.members,
            domains: [],
            foundation: true,
            surfaces: [],
            evidence: dedupe(part.members.flatMap((id) => sourceOf(skeleton, id))).slice(0, 3),
            unsure: [],
          });
      }
    } else found.members.push(...foundation);
    domains.push(found);
  }

  // --- 7. Collapse: a domain of one thing is that thing (nothing to step into). ---
  const collapse = (list: Domain[]): { domains: Domain[]; loose: string[] } => {
    const kept: Domain[] = [];
    const loose: string[] = [];
    for (const d of list) {
      const inner = collapse(d.domains);
      d.domains = inner.domains;
      d.members.push(...inner.loose);
      if (d.domains.length === 0 && d.members.length === 1) loose.push(d.members[0]!);
      else if (d.domains.length === 0 && d.members.length === 0) continue;
      else kept.push(d);
    }
    return { domains: kept, loose };
  };
  const top = collapse(domains);

  const parentOf: Record<string, string> = {};
  const domainParentOf: Record<string, string> = {};
  const walk = (list: Domain[], parent: string | undefined) => {
    for (const d of list) {
      d.members.sort(byString);
      if (parent) domainParentOf[d.id] = parent;
      for (const m of d.members) parentOf[m] = d.id;
      walk(d.domains, d.id);
    }
  };
  walk(top.domains, undefined);

  const topMembers = [
    ...skeleton.clients.map((c) => c.id),
    ...skeleton.servers.map((s) => s.id),
    ...services.map((s) => s.id),
    ...skeleton.processes.map((p) => p.id),
    ...(skeleton.datastores ?? []).map((d) => d.id),
  ].filter((id) => !parentOf[id]);
  const count = top.domains.length + topMembers.length;
  if (count > MAX_CHILDREN) notes.push(`the top level holds ${count} things, more than ${MAX_CHILDREN}: some capabilities may belong together`);
  return { members: topMembers.sort(byString), domains: top.domains, parentOf, domainParentOf, notes };
}

/**
 * Capabilities when no client says what the product's surfaces are: the services a
 * server serves routes for that no other service depends on — the tops of the
 * dependency graph. Everything else is used by them.
 */
function seedsWithoutSurfaces(skeleton: Skeleton, services: SkeletonService[]): string[] {
  const exposed = new Set(skeleton.servers.flatMap((s) => s.exposes));
  const used = new Set(services.flatMap((s) => s.dependsOn));
  const tops = services.filter((s) => exposed.has(s.id) && !used.has(s.id)).map((s) => s.id);
  return tops.length ? tops : services.filter((s) => exposed.has(s.id)).map((s) => s.id);
}

/**
 * Splits ids by the directory their code is filed in, at the first depth where the
 * files part ways: "src/modules/x" and "src/platform/y" split into modules and
 * platform. Names are the directory's; the model renames what reads badly.
 */
function splitByDirectory(ids: string[], fileOf: (id: string) => string): { name: string; members: string[] }[] {
  const dirs = ids.map((id) => ({ id, parts: fileOf(id).split('/').slice(0, -1) }));
  let depth = 0;
  while (dirs.every((d) => d.parts.length > depth && d.parts[depth] === dirs[0]!.parts[depth])) depth += 1;
  const groups = new Map<string, string[]>();
  for (const d of dirs) {
    const key = d.parts[depth] ?? 'other';
    groups.set(key, [...(groups.get(key) ?? []), d.id]);
  }
  return [...groups.entries()].sort((a, b) => byString(a[0], b[0])).map(([name, members]) => ({ name: kebab(name), members }));
}

function sourceOf(skeleton: Skeleton, id: string): Evidence[] {
  const hit =
    skeleton.services.find((s) => s.id === id) ??
    skeleton.processes.find((p) => p.id === id) ??
    (skeleton.datastores ?? []).find((d) => d.id === id);
  return hit ? [{ file: hit.source.file, ...(hit.source.line ? { line: hit.source.line } : {}) }] : [];
}

function dedupe(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return evidence.filter((e) => {
    const key = `${e.file}:${e.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
