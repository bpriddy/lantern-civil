import { posix } from 'node:path';
import ts from 'typescript';
import type {
  SkeletonAgent,
  SkeletonProcess,
  SkeletonRoute,
  SkeletonServer,
  SkeletonService,
} from './skeleton.js';
import {
  byString,
  civilId,
  decoratorsOf,
  isUnder,
  propName,
  unwrap,
  type Decl,
  type Pkg,
  type RepoContext,
} from './read.js';

/**
 * The NestJS reader: one server package in, its routes, services, agents and
 * scheduled processes out. It reads what Nest itself reads — the bootstrap's root
 * module, the @Module graph from there, @Controller and the HTTP method decorators,
 * constructor injection — so a module that exists on disk but is never imported is
 * not served, and is reported rather than drawn.
 *
 * Everything here is syntax plus name resolution (RepoContext). Where a value is
 * computed at runtime — a route path built by a function, providers returned from a
 * call — the reader says so in `unresolved` and leaves it out; it never guesses.
 */

type Unresolved = { file: string; line?: number; reason: string };

export interface NestRead {
  /** One per deployment: the server, or one per root when the bootstrap picks a root. */
  servers: SkeletonServer[];
  services: SkeletonService[];
  agents: SkeletonAgent[];
  processes: SkeletonProcess[];
  unresolved: Unresolved[];
}

const HTTP_METHODS: Record<string, SkeletonRoute['method']> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  All: 'ALL',
  Options: 'OPTIONS',
  Head: 'HEAD',
};

/**
 * Model SDKs: importing one of these is what makes code an LLM caller. Prefix
 * entries (ending in "/") match a whole scope.
 */
const MODEL_SDKS = [
  '@google/genai',
  '@google/generative-ai',
  '@google/adk',
  '@google-cloud/vertexai',
  '@google-cloud/aiplatform',
  '@anthropic-ai/',
  'openai',
  '@openai/',
  '@ai-sdk/',
  'ai',
  'langchain',
  '@langchain/',
  '@mistralai/mistralai',
  'cohere-ai',
  'groq-sdk',
  'ollama',
];

const isModelSdk = (pkg: string): boolean =>
  MODEL_SDKS.some((s) => (s.endsWith('/') ? pkg.startsWith(s) : pkg === s));

/**
 * A call that asks a model for an answer, as opposed to an embedding or a client
 * construction. Used only outside agents/ directories, where a file must both import
 * a model SDK and do this to count as an agent.
 */
const GENERATION_CALL =
  /\b(generateContent|generateContentStream|generateText|streamText|generateObject|streamObject|LlmAgent)\b|\.(messages|completions|responses)\.(create|stream)\b/;

/**
 * Cross-cutting plumbing, by the module's own name. Deliberately a short explicit
 * list: a false "infrastructure" hides product functionality from the graph, which
 * is worse than a plumbing module drawn as a service.
 */
const INFRA_ID =
  /^(config|configuration|env|database|db|prisma|typeorm|drizzle|mikro-orm|mongo|mongoose|redis|cache|logger|logging|log|telemetry|tracing|metrics|monitoring|otel|health|healthcheck|terminus|shared|common)$/;

/** Class names that are plumbing however the module is named (the root AppModule). */
const INFRA_CLASS = /(Health|Version|Config|Lifecycle|Logger|Logging|Telemetry|Tracing|Metrics|Database|Prisma)/;

interface ProviderRec {
  /** Class name, or the token / variable a provider object is bound under. */
  name: string;
  file: string;
  /** DI keys this provider satisfies: a class's own key, or its `provide` token's. */
  keys: string[];
  /** Nodes to start the reach walk from (the class, or the provider object). */
  roots: { file: string; node: ts.Node }[];
  /** The class decl, when the provider is a class: for constructor injection. */
  cls?: Decl;
}

interface ModuleRec {
  key: string;
  name: string;
  file: string;
  node: ts.ClassDeclaration;
  global: boolean;
  imports: string[];
  controllers: Decl[];
  providers: ProviderRec[];
}

type Entry =
  | { kind: 'class'; decl: Decl }
  | { kind: 'provider'; rec: ProviderRec }
  | { kind: 'external' }
  | { kind: 'unresolved'; file: string; node: ts.Node; reason: string };

const declKey = (d: { file: string; name: string }) => `${d.file}#${d.name}`;

export function readNestServer(ctx: RepoContext, pkg: Pkg): NestRead {
  const unresolved: Unresolved[] = [];
  const files = ctx.codeFilesOf(pkg);
  const serverId = civilId(posix.basename(pkg.dir) || (pkg.name ?? 'server').replace(/^@[^/]+\//, ''));

  // --- one walk over every file: bootstraps, prefixes, and decorated classes ---
  const bootstraps: { file: string; call: ts.CallExpression }[] = [];
  const prefixCalls: { file: string; call: ts.CallExpression }[] = [];
  const moduleClasses: { file: string; node: ts.ClassDeclaration }[] = [];
  const controllerClasses = new Map<string, { file: string; node: ts.ClassDeclaration }>();
  const scheduled: { file: string; cls: ts.ClassDeclaration; method: ts.MethodDeclaration }[] = [];

  for (const file of files) {
    const sf = ctx.sourceFile(file);
    if (!sf) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const { expression: target, name } = node.expression;
        if (ts.isIdentifier(target) && target.text === 'NestFactory' && /^create/.test(name.text)) bootstraps.push({ file, call: node });
        if (name.text === 'setGlobalPrefix') prefixCalls.push({ file, call: node });
      }
      if (ts.isClassDeclaration(node) && node.name) {
        const decorators = decoratorsOf(node).map((d) => d.name);
        if (decorators.includes('Module')) moduleClasses.push({ file, node });
        if (decorators.includes('Controller')) controllerClasses.set(`${file}#${node.name.text}`, { file, node });
        for (const member of node.members)
          if (ts.isMethodDeclaration(member) && decoratorsOf(member).some((d) => ['Cron', 'Interval', 'Timeout'].includes(d.name)))
            scheduled.push({ file, cls: node, method: member });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // --- the @Module graph ---
  const modules = new Map<string, ModuleRec>();
  for (const { file, node } of moduleClasses) {
    const rec = readModule(ctx, file, node, unresolved);
    modules.set(rec.key, rec);
  }

  // Roots: whatever the bootstrap hands NestFactory.create. Both arms of a
  // `mode === 'worker' ? WorkerModule : AppModule` are served — but not by the same
  // process: each arm is its own deployment of this package, with its own routes and
  // its own ingress, so each is read as its own server below.
  const roots: string[] = [];
  for (const { file, call } of bootstraps) {
    const arg = call.arguments[0];
    if (!arg) continue;
    for (const e of collect(ctx, file, arg, 0)) {
      if (e.kind === 'class' && modules.has(declKey(e.decl))) {
        if (!roots.includes(declKey(e.decl))) roots.push(declKey(e.decl));
      } else if (e.kind === 'unresolved') unresolved.push({ file, line: ctx.line(file, call), reason: `bootstrap module: ${e.reason}` });
    }
  }
  const bootstrap = bootstraps[0];
  if (!bootstrap)
    unresolved.push({
      file: pkg.manifest,
      reason: `server "${serverId}": no NestFactory.create(...) bootstrap found; every @Module is read as if served`,
    });

  const modulesFrom = (starts: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length) {
      const key = queue.shift()!;
      if (seen.has(key) || !modules.has(key)) continue;
      seen.add(key);
      queue.push(...modules.get(key)!.imports);
    }
    return seen;
  };
  const reachable = modulesFrom(roots.length ? roots : [...modules.keys()]);
  for (const m of [...modules.values()].sort((a, b) => byString(a.key, b.key)))
    if (!reachable.has(m.key))
      unresolved.push({ file: m.file, line: ctx.line(m.file, m.node), reason: `${m.name} is not imported from the bootstrap's root module, so Nest never loads it; not read` });

  // --- services: one per reachable module that declares something ---
  const rootDirs = new Set([pkg.dir, posix.join(pkg.dir, 'src')]);
  for (const key of roots) rootDirs.add(posix.dirname(modules.get(key)!.file));
  if (bootstrap) rootDirs.add(posix.dirname(bootstrap.file));

  const serviceMods = [...reachable]
    .map((k) => modules.get(k)!)
    .filter((m) => m.controllers.length || m.providers.length)
    .sort((a, b) => byString(a.key, b.key));
  const idOf = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const m of serviceMods) {
    let id = civilId(m.name.replace(/Module$/, '') || m.name);
    if (usedIds.has(id)) id = civilId(`${posix.basename(posix.dirname(m.file))}-${id}`);
    for (let n = 2; usedIds.has(id); n++) id = civilId(`${m.name}-${n}`);
    usedIds.add(id);
    idOf.set(m.key, id);
  }

  // Which service a file belongs to: a module's directory is its own when it is the
  // only module there and is not the app's root; otherwise only the files of the
  // classes it declares. Deepest directory wins, so a nested feature keeps its files.
  const moduleDirs = new Map<string, string[]>();
  for (const m of serviceMods) moduleDirs.set(posix.dirname(m.file), [...(moduleDirs.get(posix.dirname(m.file)) ?? []), m.key]);
  const dirOwner = new Map<string, string>();
  for (const [dir, keys] of moduleDirs) if (keys.length === 1 && !rootDirs.has(dir)) dirOwner.set(dir, idOf.get(keys[0]!)!);
  const classFileOwner = new Map<string, string>();
  for (const m of serviceMods)
    for (const d of [...m.controllers, ...m.providers.flatMap((p) => (p.cls ? [p.cls] : []))])
      if (!classFileOwner.has(d.file)) classFileOwner.set(d.file, idOf.get(m.key)!);
  const serviceOfFile = (file: string): string | undefined => {
    let best: string | undefined;
    let bestLen = -1;
    for (const [dir, id] of dirOwner) if (isUnder(file, dir) && dir.length > bestLen) [best, bestLen] = [id, dir.length];
    return best ?? classFileOwner.get(file);
  };

  // --- agents ---
  const { agents, agentOfFile } = readAgents(ctx, files, unresolved);
  const agentUses = agentsUsedByAgents(ctx, agents, agentOfFile);
  /** An agent and every agent its code calls in turn: a service that runs one runs them all. */
  const withCalledAgents = (ids: Iterable<string>): string[] => {
    const out = new Set<string>();
    const queue = [...ids];
    while (queue.length) {
      const id = queue.shift()!;
      if (out.has(id)) continue;
      out.add(id);
      queue.push(...(agentUses.get(id) ?? []));
    }
    return [...out];
  };

  // --- ownership: every code file of the package, to a service, an agent, or shared ---
  // The registry records the repository's files as each unit's implementation, so a
  // service owns all of its directory's code, not only the classes its module lists.
  // A module in a shared directory (src/, beside the bootstrap) owns its own file, its
  // declared classes' files, and the same-directory helpers those import that nothing
  // else claims. What is left is shared code, recorded and counted as such.
  const ownerOf = new Map<string, string>();
  for (const f of files) {
    if (agentOfFile.has(f)) continue;
    const owner = serviceOfFile(f);
    if (owner) ownerOf.set(f, owner);
  }
  for (const m of serviceMods) if (!ownerOf.has(m.file) && !agentOfFile.has(m.file)) ownerOf.set(m.file, idOf.get(m.key)!);
  const codeFiles = new Set(files);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [f, id] of [...ownerOf].sort((a, b) => byString(a[0], b[0])))
      for (const b of ctx.imports(f).values()) {
        if (b.typeOnly || b.target.kind !== 'file') continue;
        const t = b.target.path;
        if (ownerOf.has(t) || agentOfFile.has(t) || !codeFiles.has(t) || posix.dirname(t) !== posix.dirname(f)) continue;
        ownerOf.set(t, id);
        grew = true;
      }
  }
  const filesOfService = new Map<string, string[]>();
  for (const [f, id] of ownerOf) filesOfService.set(id, [...(filesOfService.get(id) ?? []), f]);
  const directoryOf = new Map([...dirOwner].map(([dir, id]) => [id, dir]));

  // --- dependencies: module imports, constructor injection, and code reach ---
  const providedBy = new Map<string, Set<string>>();
  for (const m of serviceMods)
    for (const p of m.providers)
      for (const k of p.keys) providedBy.set(k, (providedBy.get(k) ?? new Set()).add(idOf.get(m.key)!));

  /** Service ids a module's imports reach, looking through modules that declare nothing. */
  const importedServices = (m: ModuleRec, seen = new Set<string>()): string[] =>
    m.imports.flatMap((k) => {
      if (seen.has(k) || !modules.has(k)) return [];
      seen.add(k);
      return idOf.has(k) ? [idOf.get(k)!] : importedServices(modules.get(k)!, seen);
    });

  const rootKeys = new Set(roots);
  const services: SkeletonService[] = serviceMods.map((m) => {
    const id = idOf.get(m.key)!;
    const imported = importedServices(m);
    const deps = new Set(imported);
    const injected = [...m.controllers, ...m.providers.flatMap((p) => (p.cls ? [p.cls] : []))];
    for (const cls of injected)
      for (const key of injectedKeys(ctx, cls)) {
        const owners = [...(providedBy.get(key) ?? [])];
        if (owners.includes(id) || !owners.length) continue;
        const chosen = owners.length === 1 ? owners : owners.filter((o) => imported.includes(o));
        for (const o of chosen) deps.add(o);
      }

    const reach = reachFrom(ctx, m, id, files, serviceOfFile, agentOfFile);
    for (const s of reach.services) deps.add(s);
    deps.delete(id);

    // An agent reached only through another agent's code is that agent's helper, not
    // a second thing the service runs: recorded with the agents that call it.
    const allAgents = withCalledAgents(reach.agents).sort(byString);
    const agentsVia: Record<string, string[]> = {};
    for (const a of allAgents) {
      if (reach.agents.has(a)) continue;
      const callers = allAgents.filter((c) => c !== a && agentUses.get(c)?.has(a));
      if (callers.length) agentsVia[a] = callers;
    }

    const controllers = m.controllers.map((c) => ({ name: c.name, file: c.file }));
    const providers = m.providers.map((p) => ({ name: p.name, file: p.file }));
    const names = [...controllers, ...providers].map((c) => c.name);
    const isRoot = rootKeys.has(m.key);
    const service: SkeletonService = {
      id,
      server: serverId,
      moduleClass: m.name,
      source: { file: m.file, line: ctx.line(m.file, m.node) },
      controllers,
      providers,
      dependsOn: [...deps].sort(byString),
      agents: allAgents,
      // A root is the app itself, never plumbing by its name ("app", "main"); it is
      // plumbing only when everything it declares is (health, version, lifecycle) —
      // and then the server it boots stands for it on the canvas.
      infrastructure: (!isRoot && INFRA_ID.test(id)) || (names.length > 0 && names.every((n) => INFRA_CLASS.test(n))),
      files: (filesOfService.get(id) ?? []).sort(byString),
    };
    const directory = directoryOf.get(id);
    if (directory) service.directory = directory;
    if (isRoot) service.root = true;
    if (Object.keys(agentsVia).length) service.agentsVia = agentsVia;
    return service;
  });

  // --- routes, per deployment ---
  const prefix = readGlobalPrefix(ctx, prefixCalls, unresolved);
  const controllerRoutes = new Map<string, SkeletonRoute[]>();
  const routesOf = (c: Decl): SkeletonRoute[] => {
    if (!controllerRoutes.has(declKey(c))) controllerRoutes.set(declKey(c), readController(ctx, c, prefix, unresolved));
    return controllerRoutes.get(declKey(c))!;
  };
  const registered = new Set<string>();
  for (const m of serviceMods) for (const c of m.controllers) registered.add(declKey(c));
  for (const [key, c] of [...controllerClasses].sort((a, b) => byString(a[0], b[0])))
    if (!registered.has(key) && ![...modules.values()].some((m) => !reachable.has(m.key) && m.controllers.some((d) => declKey(d) === key)))
      unresolved.push({ file: c.file, line: ctx.line(c.file, c.node), reason: `${c.node.name!.text} is a @Controller no served module declares; its routes are not read` });
  const underPrefix = (r: SkeletonRoute): boolean =>
    !prefix || r.path === `/${prefix.value}` || r.path.startsWith(`/${prefix.value}/`);

  /** The routes and exposed services of the modules one root reaches. */
  const surface = (reach: ReadonlySet<string>) => {
    const routes: SkeletonRoute[] = [];
    const exposes = new Set<string>();
    for (const m of serviceMods) {
      if (!reach.has(m.key)) continue;
      for (const c of m.controllers) {
        const found = routesOf(c);
        if (found.length) exposes.add(idOf.get(m.key)!);
        // A controller two modules both declare is one set of routes, not two.
        for (const r of found)
          if (!routes.some((x) => x.method === r.method && x.path === r.path && x.controller === r.controller && x.handler === r.handler))
            routes.push(r);
      }
    }
    routes.sort((a, b) => byString(a.path, b.path) || byString(a.method, b.method));
    return { routes, exposes: [...exposes].sort(byString) };
  };

  // One deployment per root when the bootstrap chooses between several, the public
  // one (serving under the global prefix) first; otherwise the one server it always was.
  const deployments = (roots.length > 1 ? roots : [roots[0] ?? null]).map((root) => {
    const reach = root ? modulesFrom([root]) : reachable;
    const s = surface(reach);
    return { root, reach, ...s, public: s.routes.some(underPrefix) };
  });
  const anyPublic = deployments.some((d) => d.public);
  if (deployments.length > 1)
    deployments.sort((a, b) => Number(b.public) - Number(a.public) || byString(modules.get(a.root!)!.name, modules.get(b.root!)!.name));

  const servers: SkeletonServer[] = deployments.map((d, i) => {
    const rootMod = d.root ? modules.get(d.root)! : undefined;
    const many = deployments.length > 1;
    const id = many && i > 0 ? civilId(`${serverId}-${rootMod!.name.replace(/Module$/, '') || rootMod!.name}`) : serverId;
    const server: SkeletonServer = {
      id,
      path: pkg.dir,
      framework: 'nestjs',
      globalPrefix: prefix?.value ?? null,
      routes: d.routes,
      exposes: d.exposes,
      // One package, several deployments: each is anchored on its own root module, so
      // an Update can tell them apart; the one-root server keeps its bootstrap.
      source: many
        ? { file: rootMod!.file, line: ctx.line(rootMod!.file, rootMod!.node) }
        : bootstrap
          ? { file: bootstrap.file, line: ctx.line(bootstrap.file, bootstrap.call) }
          : { file: pkg.manifest },
    };
    if (many) {
      server.rootModule = rootMod!.name;
      if (anyPublic && !d.public) server.internal = true;
    }
    return server;
  });
  // A service belongs to the first deployment that loads it (the public one, when a
  // module is shared by both).
  for (const s of services) {
    const m = serviceMods.find((x) => idOf.get(x.key) === s.id)!;
    const at = deployments.findIndex((d) => d.reach.has(m.key));
    if (at >= 0) s.server = servers[at]!.id;
  }
  const shared = files.filter((f) => !ownerOf.has(f) && !agentOfFile.has(f));
  if (shared.length) servers[0]!.sharedFiles = shared;

  // --- dispatch across deployments: a service naming another deployment's route ---
  // A task queue or a direct call carries the target path as a constant
  // (`FIRE_PATH = '/internal/fire'`); the code that names it is what
  // starts that work, so the edge is drawn from it to the service that serves it.
  // Only paths no public deployment also serves: /healthz answered by both the app and
  // the worker says nothing about who starts whose work.
  const publicPaths = new Set(servers.filter((s) => !s.internal).flatMap((s) => s.routes.map((r) => r.path)));
  const internalRoutes: { test: RegExp; server: string; service: string }[] = [];
  servers.forEach((server, i) => {
    if (!server.internal) return;
    for (const m of serviceMods) {
      if (!deployments[i]!.reach.has(m.key)) continue;
      for (const c of m.controllers)
        for (const r of routesOf(c))
          if (!underPrefix(r) && !publicPaths.has(r.path))
            internalRoutes.push({ test: routeMatcher(r.path), server: server.id, service: idOf.get(m.key)! });
    }
  });
  if (internalRoutes.length)
    for (const s of services) {
      const targets = new Set<string>();
      for (const f of s.files ?? []) {
        for (const value of pathsNamedIn(ctx, f)) {
          for (const r of internalRoutes)
            if (r.server !== s.server && r.service !== s.id && r.test.test(value)) targets.add(r.service);
        }
      }
      if (targets.size) s.dispatchesTo = [...targets].sort(byString);
    }

  // --- scheduled processes ---
  const processes: SkeletonProcess[] = [];
  const processIds = new Set<string>();
  for (const { file, cls, method } of scheduled) {
    const read = readSchedule(ctx, file, method);
    const line = ctx.line(file, method);
    if (read.problem) unresolved.push({ file, line, reason: read.problem });
    const owner = serviceOfFile(file) ?? ownerOf.get(file);
    if (!owner) unresolved.push({ file, line, reason: `scheduled ${cls.name!.text}.${method.name.getText()} is in no served module's code; its process calls nothing` });
    let id = civilId(read.name ?? method.name.getText());
    if (processIds.has(id)) id = civilId(`${cls.name!.text}-${id}`);
    processIds.add(id);
    processes.push({ id, schedule: read.schedule, calls: owner ? [owner] : [], source: { file, line } });
  }

  return { servers, services, agents, processes, unresolved };
}

/** A route path as a matcher for the values code names it by: `:id` matches a segment. */
function routeMatcher(path: string): RegExp {
  const body = path
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body}/?$`);
}

/**
 * Every path-shaped string a file names: its own string literals, and the string
 * constants it imports (from anywhere in the repo, a shared package included). Only
 * values starting with "/" — a route is what is being looked for.
 */
function pathsNamedIn(ctx: RepoContext, file: string): Set<string> {
  const out = new Set<string>();
  const sf = ctx.sourceFile(file);
  if (!sf) return out;
  const visit = (n: ts.Node): void => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text.startsWith('/')) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const [local, b] of ctx.imports(file)) {
    if (b.typeOnly || b.target.kind !== 'file' || b.imported === '*' || !/^[A-Z][A-Z0-9_]*$/.test(local)) continue;
    const d = ctx.resolveExport(b.target.path, b.imported, new Set());
    if (!d || 'external' in d || !ts.isVariableDeclaration(d.node) || !d.node.initializer) continue;
    const value = ctx.evalString(d.file, d.node.initializer);
    if (value?.startsWith('/')) out.add(value);
  }
  return out;
}

// ---------------------------------------------------------------------------------
// @Module
// ---------------------------------------------------------------------------------

function readModule(ctx: RepoContext, file: string, node: ts.ClassDeclaration, unresolved: Unresolved[]): ModuleRec {
  const name = node.name!.text;
  const rec: ModuleRec = {
    key: `${file}#${name}`,
    name,
    file,
    node,
    global: decoratorsOf(node).some((d) => d.name === 'Global'),
    imports: [],
    controllers: [],
    providers: [],
  };
  const deco = decoratorsOf(node).find((d) => d.name === 'Module')!;
  const meta = deco.args[0] ? objectLiteralOf(ctx, file, deco.args[0]) : undefined;
  if (deco.args[0] && !meta) {
    unresolved.push({ file, line: ctx.line(file, node), reason: `${name}: @Module metadata is not an object literal; module not read` });
    return rec;
  }
  for (const prop of meta?.node.properties ?? []) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const field = propName(prop.name);
    if (field !== 'imports' && field !== 'controllers' && field !== 'providers') continue;
    for (const e of collect(ctx, meta!.file, prop.initializer, 0)) {
      if (e.kind === 'external') continue;
      if (e.kind === 'unresolved') {
        unresolved.push({ file: e.file, line: ctx.line(e.file, e.node), reason: `${name}.${field}: ${e.reason}` });
        continue;
      }
      if (field === 'imports') {
        if (e.kind === 'class') rec.imports.push(declKey(e.decl));
      } else if (field === 'controllers') {
        if (e.kind === 'class') rec.controllers.push(e.decl);
      } else if (e.kind === 'class') {
        rec.providers.push({ name: e.decl.name, file: e.decl.file, keys: [declKey(e.decl)], roots: [{ file: e.decl.file, node: e.decl.node }], cls: e.decl });
      } else rec.providers.push(e.rec);
    }
  }
  return rec;
}

function objectLiteralOf(ctx: RepoContext, file: string, expr: ts.Expression): { file: string; node: ts.ObjectLiteralExpression } | undefined {
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) return { file, node: e };
  if (ts.isIdentifier(e)) {
    const d = ctx.resolveName(file, e.text);
    if (d && !('external' in d) && ts.isVariableDeclaration(d.node) && d.node.initializer)
      return objectLiteralOf(ctx, d.file, d.node.initializer);
  }
  return undefined;
}

/**
 * The entries of a module metadata array, as Nest would see them: arrays and spreads
 * flattened, both arms of a conditional, `forwardRef(() => X)` unwrapped, dynamic
 * modules (`X.forRoot(...)`, `.forFeature`, `.register...`) read as X, and provider
 * objects (`{ provide, useClass | useFactory | useValue | useExisting }`) kept whole.
 */
function collect(ctx: RepoContext, file: string, expr: ts.Expression, depth: number): Entry[] {
  if (depth > 8) return [{ kind: 'unresolved', file, node: expr, reason: `"${short(expr)}" nests too deeply to read` }];
  const e = unwrap(expr);
  if (ts.isArrayLiteralExpression(e))
    return e.elements.flatMap((el) => collect(ctx, file, ts.isSpreadElement(el) ? el.expression : el, depth + 1));
  if (ts.isConditionalExpression(e)) return [...collect(ctx, file, e.whenTrue, depth + 1), ...collect(ctx, file, e.whenFalse, depth + 1)];
  if (ts.isIdentifier(e)) {
    const d = ctx.resolveName(file, e.text);
    if (!d) return [{ kind: 'unresolved', file, node: e, reason: `cannot find where "${e.text}" is defined` }];
    if ('external' in d) return [{ kind: 'external' }];
    if (d.kind === 'class') return [{ kind: 'class', decl: d }];
    if (ts.isVariableDeclaration(d.node) && d.node.initializer) {
      const init = unwrap(d.node.initializer);
      if (ts.isObjectLiteralExpression(init)) return [providerObject(ctx, d.file, init, d.name)];
      return collect(ctx, d.file, init, depth + 1);
    }
    return [{ kind: 'unresolved', file, node: e, reason: `"${e.text}" is not a class, array or provider object` }];
  }
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    if (ts.isIdentifier(callee) && callee.text === 'forwardRef') {
      const fn = e.arguments[0] ? unwrap(e.arguments[0]) : undefined;
      if (fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return collect(ctx, file, fn.body, depth + 1);
      return [{ kind: 'unresolved', file, node: e, reason: `forwardRef whose target is not an arrow returning a class` }];
    }
    if (ts.isPropertyAccessExpression(callee) && /^(forRoot|forFeature|register|forChild)/.test(callee.name.text))
      return collect(ctx, file, callee.expression, depth + 1);
    return [{ kind: 'unresolved', file, node: e, reason: `"${short(e)}" is computed by a call` }];
  }
  if (ts.isObjectLiteralExpression(e)) {
    const moduleProp = e.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === 'module') as ts.PropertyAssignment | undefined;
    if (moduleProp) return collect(ctx, file, moduleProp.initializer, depth + 1);
    return [providerObject(ctx, file, e, undefined)];
  }
  return [{ kind: 'unresolved', file, node: e, reason: `"${short(e)}" is not a form the reader understands` }];
}

function providerObject(ctx: RepoContext, file: string, obj: ts.ObjectLiteralExpression, varName: string | undefined): Entry {
  const prop = (n: string) =>
    (obj.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === n) as ts.PropertyAssignment | undefined)?.initializer;
  const provide = prop('provide');
  if (!provide) return { kind: 'unresolved', file, node: obj, reason: `object without "provide" or "module"` };
  const token = unwrap(provide);
  const keys: string[] = [];
  let tokenName: string;
  if (ts.isIdentifier(token)) {
    tokenName = token.text;
    const d = ctx.resolveName(file, token.text);
    keys.push(d && !('external' in d) ? declKey(d) : `name:${token.text}`);
  } else {
    tokenName = ctx.evalString(file, token) ?? short(token);
    keys.push(`str:${tokenName}`);
  }
  let implFile = file;
  let cls: Decl | undefined;
  const useClass = prop('useClass') ?? prop('useExisting');
  if (useClass && ts.isIdentifier(unwrap(useClass))) {
    const d = ctx.resolveName(file, (unwrap(useClass) as ts.Identifier).text);
    if (d && !('external' in d) && d.kind === 'class') [implFile, cls] = [d.file, d];
  }
  const rec: ProviderRec = { name: varName ?? tokenName, file: implFile, keys, roots: [{ file, node: obj }] };
  if (cls) rec.cls = cls;
  return { kind: 'provider', rec };
}

const short = (node: ts.Node): string => {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

/** DI keys a class's constructor asks for: parameter types, or @Inject(token). */
function injectedKeys(ctx: RepoContext, cls: Decl): string[] {
  if (!ts.isClassDeclaration(cls.node)) return [];
  const ctor = cls.node.members.find(ts.isConstructorDeclaration);
  if (!ctor) return [];
  const keys: string[] = [];
  for (const param of ctor.parameters) {
    const inject = decoratorsOf(param).find((d) => d.name === 'Inject');
    let target: ts.Expression | ts.EntityName | undefined = inject?.args[0] ? unwrapForwardRef(inject.args[0]) : undefined;
    if (!target && param.type && ts.isTypeReferenceNode(param.type)) target = param.type.typeName;
    if (!target) continue;
    if (ts.isIdentifier(target)) {
      const d = ctx.resolveName(cls.file, target.text);
      keys.push(d && !('external' in d) ? declKey(d) : `name:${target.text}`);
    } else if (ts.isExpression(target)) {
      const s = ctx.evalString(cls.file, target);
      if (s !== undefined) keys.push(`str:${s}`);
    }
  }
  return keys;
}

/** `forwardRef(() => X)` → X; anything else unchanged. */
function unwrapForwardRef(expr: ts.Expression): ts.Expression {
  const e = unwrap(expr);
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'forwardRef') {
    const fn = e.arguments[0] ? unwrap(e.arguments[0]) : undefined;
    if (fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return unwrap(fn.body);
  }
  return e;
}

// ---------------------------------------------------------------------------------
// Code reach: which other services' and agents' code a module's code uses
// ---------------------------------------------------------------------------------

/**
 * Walk the value references out of a module's own code — its declared classes and
 * provider objects, and every file in its directory — following imports into code
 * no one owns (a shared barrel, a provider factory) until it lands in another
 * service's files or an agent's. Type positions and `import type` are skipped: using
 * a type is not using the code.
 */
function reachFrom(
  ctx: RepoContext,
  m: ModuleRec,
  self: string,
  files: string[],
  serviceOfFile: (f: string) => string | undefined,
  agentOfFile: Map<string, string>,
): { services: Set<string>; agents: Set<string> } {
  const services = new Set<string>();
  const agents = new Set<string>();
  const seen = new Set<ts.Node>();

  const land = (file: string): boolean => {
    const agent = agentOfFile.get(file);
    if (agent) {
      agents.add(agent);
      return true;
    }
    const owner = serviceOfFile(file);
    if (owner && owner !== self) {
      services.add(owner);
      return true;
    }
    return owner === self;
  };

  const visit = (file: string, node: ts.Node): void => {
    if (seen.has(node)) return;
    seen.add(node);
    const walk = (n: ts.Node): void => {
      if (ts.isTypeNode(n) || ts.isImportDeclaration(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n))
        follow(file, n.text);
      ts.forEachChild(n, walk);
    };
    walk(node);
  };

  const follow = (file: string, name: string): void => {
    const local = ctx.declarations(file).get(name);
    if (local) {
      if (!seen.has(local.node)) visit(file, local.node);
      return;
    }
    const binding = ctx.imports(file).get(name);
    if (!binding || binding.typeOnly || binding.target.kind !== 'file') return;
    if (binding.imported === '*') {
      land(binding.target.path);
      return;
    }
    const d = ctx.resolveExport(binding.target.path, binding.imported, new Set());
    if (!d || 'external' in d) {
      land(binding.target.path);
      return;
    }
    // A barrel that belongs to another service is that service, whatever it re-exports.
    if (land(binding.target.path) && serviceOfFile(binding.target.path) !== self) return;
    if (land(d.file)) return;
    visit(d.file, d.node);
  };

  for (const root of [...m.controllers, ...m.providers.flatMap((p) => (p.cls ? [p.cls] : []))]) visit(root.file, root.node);
  for (const p of m.providers) for (const r of p.roots) visit(r.file, r.node);
  for (const f of files)
    if (serviceOfFile(f) === self)
      for (const stmt of ctx.sourceFile(f)?.statements ?? []) if (!ts.isImportDeclaration(stmt)) visit(f, stmt);
  return { services, agents };
}

// ---------------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------------

const importsModelSdk = (ctx: RepoContext, file: string): boolean =>
  [...ctx.imports(file).values()].some((b) => b.target.kind === 'external' && isModelSdk(b.target.pkg));

/**
 * Agents, two ways. A directory under `agents/` with a definition file (agent.ts,
 * <x>-agent.ts, <x>.agent.ts, or a prompt) is one agent per definition, owning the
 * files beside it and its tools/ directory. Outside agents/, a file that imports a
 * model SDK AND asks it to generate is one agent — the second test is what keeps an
 * embedding client or an SDK wrapper from being drawn as one.
 */
function readAgents(
  ctx: RepoContext,
  files: string[],
  unresolved: Unresolved[],
): { agents: SkeletonAgent[]; agentOfFile: Map<string, string> } {
  const agents: SkeletonAgent[] = [];
  const agentOfFile = new Map<string, string>();
  const groups = new Map<string, string[]>();
  for (const f of files) {
    const segs = f.split('/');
    const i = segs.lastIndexOf('agents', segs.length - 2);
    if (i < 0 || i + 2 >= segs.length) continue;
    const dir = segs.slice(0, i + 2).join('/');
    groups.set(dir, [...(groups.get(dir) ?? []), f]);
  }

  for (const [dir, groupFiles] of [...groups].sort((a, b) => byString(a[0], b[0]))) {
    const dirName = posix.basename(dir);
    const base = (f: string) => posix.basename(f).replace(/\.(m?[tj]sx?)$/, '');
    const isDef = (f: string) => posix.dirname(f) === dir && /^(agent|.+[.-]agent)$/.test(base(f));
    let defs = groupFiles.filter(isDef);
    if (!defs.length) defs = groupFiles.filter((f) => posix.dirname(f) === dir && /^(prompts?|.+[.-]prompts?)$/.test(base(f))).slice(0, 1);
    if (!defs.length) {
      const sdk = groupFiles.find((f) => importsModelSdk(ctx, f));
      if (sdk)
        unresolved.push({ file: sdk, reason: `${dir} uses a model SDK but has no agent or prompt file; read as shared model code, not an agent` });
      continue;
    }
    // Each <x>-agent.ts claims the files named <x>-*; a plain agent.ts (or the one
    // prompt) takes the rest of the directory, tools/ included.
    const named = defs
      .map((f) => ({ f, x: /^(agent|prompts?)$/.test(base(f)) ? null : base(f).replace(/[.-](agent|prompts?)$/, '') }))
      .sort((a, b) => byString(a.f, b.f));
    const plain = named.find((n) => n.x === null) ?? null;
    const owned = new Map<string, string[]>();
    for (const f of groupFiles) {
      const owner = named.find((n) => n.x !== null && posix.dirname(f) === dir && (base(f).startsWith(`${n.x}-`) || base(f).startsWith(`${n.x}.`)));
      const def = owner ?? plain ?? (named.length === 1 ? named[0]! : null);
      if (def) owned.set(def.f, [...(owned.get(def.f) ?? []), f]);
    }
    for (const n of named) {
      const id = civilId(n.x ?? dirName);
      const agentFiles = (owned.get(n.f) ?? [n.f]).sort(byString);
      const tools = toolsOf(ctx, n.f, agentFiles, dir);
      for (const t of tools) if (!agentFiles.includes(t.file)) agentFiles.push(t.file);
      agentFiles.sort(byString);
      agents.push({ id, files: agentFiles, tools, source: { file: n.f } });
      for (const f of agentFiles) if (!agentOfFile.has(f)) agentOfFile.set(f, id);
    }
  }

  for (const f of files) {
    if (agentOfFile.has(f) || [...groups.keys()].some((d) => isUnder(f, d))) continue;
    if (!importsModelSdk(ctx, f) || !GENERATION_CALL.test(ctx.files[f] ?? '')) continue;
    const id = civilId(posix.basename(f).replace(/\.(m?[tj]sx?)$/, '').replace(/[.-](service|agent|client|provider)$/, ''));
    agents.push({ id, files: [f], tools: toolsOf(ctx, f, [f], null), source: { file: f } });
    agentOfFile.set(f, id);
  }
  agents.sort((a, b) => byString(a.id, b.id));
  return { agents, agentOfFile };
}

/**
 * Which agents each agent's code calls: an import, from one agent's files, of a class
 * in another agent's files or of anything from its definition file (an analyzer that
 * hands part of the work to a scorer agent). A prompt borrowing another prompt's
 * formatting helper is sharing text, not calling an agent, so it does not count.
 */
function agentsUsedByAgents(ctx: RepoContext, agents: SkeletonAgent[], agentOfFile: Map<string, string>): Map<string, Set<string>> {
  const definition = new Map(agents.map((a) => [a.id, a.source.file]));
  const uses = new Map<string, Set<string>>();
  for (const agent of agents)
    for (const file of agent.files)
      for (const binding of ctx.imports(file).values()) {
        if (binding.typeOnly || binding.target.kind !== 'file' || binding.imported === '*') continue;
        const d = ctx.resolveExport(binding.target.path, binding.imported, new Set());
        if (!d || 'external' in d) continue;
        const target = agentOfFile.get(d.file);
        if (!target || target === agent.id) continue;
        if (d.kind === 'class' || definition.get(target) === d.file)
          uses.set(agent.id, (uses.get(agent.id) ?? new Set()).add(target));
      }
  return uses;
}

/**
 * An agent's tools: what its definition passes as `tools: [...]` (resolved to the
 * file that defines each), plus every file in its tools/ directory.
 */
function toolsOf(ctx: RepoContext, def: string, agentFiles: string[], dir: string | null): { name: string; file: string }[] {
  const tools = new Map<string, string>();
  const sf = ctx.sourceFile(def);
  const toolName = (file: string, ident: string) => (file === def ? ident : civilId(posix.basename(file).replace(/\.(m?[tj]sx?)$/, '')));
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && propName(n.name) === 'tools' && ts.isArrayLiteralExpression(unwrap(n.initializer))) {
      for (const el of (unwrap(n.initializer) as ts.ArrayLiteralExpression).elements) {
        let target = unwrap(ts.isSpreadElement(el) ? el.expression : el);
        if (ts.isCallExpression(target) || ts.isNewExpression(target)) target = unwrap(target.expression);
        if (!ts.isIdentifier(target)) continue;
        const d = ctx.resolveName(def, target.text);
        if (d && !('external' in d)) tools.set(d.file === def ? `${def}#${target.text}` : d.file, toolName(d.file, target.text));
      }
    }
    ts.forEachChild(n, visit);
  };
  if (sf) visit(sf);
  if (dir)
    for (const f of agentFiles)
      if (isUnder(f, posix.join(dir, 'tools')) && !tools.has(f) && !/\/index\.[tj]sx?$/.test(f)) tools.set(f, toolName(f, ''));
  return [...tools]
    .map(([key, name]) => ({ name, file: key.split('#')[0]! }))
    .sort((a, b) => byString(a.name, b.name));
}

// ---------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------

interface Prefix {
  value: string;
  /** Route paths (prefix-less) the prefix does not apply to, as matchers. */
  exclude: { test: RegExp; method: string | null }[];
}

/**
 * setGlobalPrefix(prefix, { exclude }) — wherever the app is configured, which is
 * often a helper outside the bootstrap file. Exclusions are honoured, because
 * leaving /healthz under /api would draw a route the server does not serve.
 */
function readGlobalPrefix(ctx: RepoContext, calls: { file: string; call: ts.CallExpression }[], unresolved: Unresolved[]): Prefix | null {
  if (!calls.length) return null;
  const [first, ...rest] = calls;
  for (const c of rest)
    unresolved.push({ file: c.file, line: ctx.line(c.file, c.call), reason: 'a second setGlobalPrefix call; only the first is applied' });
  const { file, call } = first!;
  const arg = call.arguments[0];
  const value = arg ? ctx.evalString(file, arg) : undefined;
  if (value === undefined) {
    unresolved.push({ file, line: ctx.line(file, call), reason: 'setGlobalPrefix argument is computed at runtime; routes are read without it' });
    return null;
  }
  const exclude: Prefix['exclude'] = [];
  const opts = call.arguments[1] ? objectLiteralOf(ctx, file, call.arguments[1]) : undefined;
  const ex = opts?.node.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === 'exclude') as ts.PropertyAssignment | undefined;
  const exArray = ex ? unwrap(ex.initializer) : undefined;
  if (exArray && ts.isArrayLiteralExpression(exArray))
    for (const el of exArray.elements) {
      let path: string | undefined;
      let method: string | null = null;
      const e = unwrap(el as ts.Expression);
      if (ts.isObjectLiteralExpression(e)) {
        for (const p of e.properties) {
          if (!ts.isPropertyAssignment(p)) continue;
          if (propName(p.name) === 'path') path = ctx.evalString(opts!.file, p.initializer);
          if (propName(p.name) === 'method' && ts.isPropertyAccessExpression(p.initializer) && p.initializer.name.text !== 'ALL')
            method = p.initializer.name.text;
        }
      } else path = ctx.evalString(opts!.file, e);
      if (path === undefined) {
        unresolved.push({ file, line: ctx.line(file, el), reason: `global prefix exclusion "${short(el)}" is computed at runtime; ignored` });
        continue;
      }
      exclude.push({ test: excludeMatcher(path), method });
    }
  return { value: trimSlashes(value), exclude };
}

/** A path-to-regexp-ish matcher for an exclusion: params match a segment, wildcards the rest. */
function excludeMatcher(pattern: string): RegExp {
  const p = trimSlashes(pattern);
  let out = '';
  let i = 0;
  while (i < p.length) {
    const rest = p.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^\/?\{\*[\w]*\}/))) out += '(?:/.*)?';
    else if ((m = rest.match(/^\/?\(\.\*\)/)) || (m = rest.match(/^\/?\*[\w]*/))) out += '(?:/.*)?';
    else if ((m = rest.match(/^:[\w]+/))) out += '[^/]+';
    else {
      m = [rest[0]!];
      out += rest[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    i += m[0].length;
  }
  return new RegExp(`^${out}$`);
}

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '');

function joinPath(...parts: string[]): string {
  const joined = parts.map(trimSlashes).filter(Boolean).join('/').replace(/\/{2,}/g, '/');
  return `/${joined}`;
}

/** A decorator argument read as one or more paths: none, 'x', ['a','b'], { path }. */
function pathsOf(ctx: RepoContext, file: string, arg: ts.Expression | undefined): string[] | undefined {
  if (!arg) return [''];
  const e = unwrap(arg);
  if (ts.isArrayLiteralExpression(e)) {
    const all = e.elements.map((el) => ctx.evalString(file, el as ts.Expression));
    return all.every((v): v is string => v !== undefined) ? all : undefined;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const p = e.properties.find((x) => ts.isPropertyAssignment(x) && propName(x.name) === 'path') as ts.PropertyAssignment | undefined;
    return p ? pathsOf(ctx, file, p.initializer) : [''];
  }
  const v = ctx.evalString(file, e);
  if (v !== undefined) return [v];
  // A constant that is itself an array of paths.
  if (ts.isIdentifier(e)) {
    const d = ctx.resolveName(file, e.text);
    if (d && !('external' in d) && ts.isVariableDeclaration(d.node) && d.node.initializer)
      return pathsOf(ctx, d.file, d.node.initializer);
  }
  return undefined;
}

function readController(ctx: RepoContext, c: Decl, prefix: Prefix | null, unresolved: Unresolved[]): SkeletonRoute[] {
  if (!ts.isClassDeclaration(c.node)) return [];
  const deco = decoratorsOf(c.node).find((d) => d.name === 'Controller');
  if (!deco) {
    unresolved.push({ file: c.file, line: ctx.line(c.file, c.node), reason: `${c.name} is declared as a controller but has no @Controller decorator` });
    return [];
  }
  const ctrlPaths = pathsOf(ctx, c.file, deco.args[0]);
  if (!ctrlPaths) {
    unresolved.push({ file: c.file, line: ctx.line(c.file, c.node), reason: `${c.name}: @Controller path is computed at runtime; its routes are not read` });
    return [];
  }
  const routes: SkeletonRoute[] = [];
  for (const member of c.node.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    const handler = member.name.getText();
    for (const d of decoratorsOf(member)) {
      const method = HTTP_METHODS[d.name];
      if (!method) continue;
      const methodPaths = pathsOf(ctx, c.file, d.args[0]);
      if (!methodPaths) {
        unresolved.push({ file: c.file, line: ctx.line(c.file, member), reason: `${c.name}.${handler}: @${d.name} path is computed at runtime; route not read` });
        continue;
      }
      for (const cp of ctrlPaths)
        for (const mp of methodPaths) {
          const bare = joinPath(cp, mp);
          const excluded = prefix?.exclude.some((x) => x.test.test(trimSlashes(bare)) && (x.method === null || x.method === method));
          routes.push({
            method,
            path: prefix && !excluded ? joinPath(prefix.value, bare) : bare,
            controller: c.name,
            handler,
            source: { file: c.file, line: ctx.line(c.file, member) },
          });
        }
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------------

/**
 * @Cron(expr | CronExpression.X, { name? }), @Interval([name,] ms), @Timeout([name,] ms).
 * An interval becomes the closest cron; a timeout runs once after boot, which cron
 * spells @reboot.
 */
function readSchedule(ctx: RepoContext, file: string, method: ts.MethodDeclaration): { schedule: string; name?: string; problem?: string } {
  const d = decoratorsOf(method).find((x) => ['Cron', 'Interval', 'Timeout'].includes(x.name))!;
  const label = `${method.name.getText()}: @${d.name}`;
  if (d.name === 'Cron') {
    const expr = d.args[0];
    const opts = d.args[1] ? objectLiteralOf(ctx, file, d.args[1]) : undefined;
    const nameProp = opts?.node.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === 'name') as ts.PropertyAssignment | undefined;
    const name = nameProp ? ctx.evalString(opts!.file, nameProp.initializer) : undefined;
    const withName = (r: { schedule: string; problem?: string }) => (name ? { ...r, name } : r);
    if (!expr) return withName({ schedule: '@reboot', problem: `${label} has no expression` });
    const literal = ctx.evalString(file, expr);
    if (literal !== undefined) return withName({ schedule: literal });
    const e = unwrap(expr);
    if (ts.isPropertyAccessExpression(e)) {
      const mapped = cronExpressionName(e.name.text);
      if (mapped) return withName({ schedule: mapped });
    }
    return withName({ schedule: short(expr), problem: `${label} expression "${short(expr)}" could not be read; kept as written` });
  }
  const [a, b] = d.args;
  const name = b && a ? ctx.evalString(file, a) : undefined;
  const msExpr = b ?? a;
  const ms = msExpr ? Number(ctx.evalString(file, msExpr)) : NaN;
  const r = (s: { schedule: string; problem?: string }) => (name ? { ...s, name } : s);
  if (d.name === 'Timeout') return r({ schedule: '@reboot' });
  if (!Number.isFinite(ms) || ms <= 0) return r({ schedule: '* * * * *', problem: `${label} interval could not be read; drawn as every minute` });
  return r({ schedule: intervalToCron(ms) });
}

/** The nearest cron to "every ms milliseconds" (cron's floor is a minute). */
export function intervalToCron(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
  return '0 0 * * *';
}

/** @nestjs/schedule's CronExpression enum, by member name — it is external, so read the name. */
export function cronExpressionName(name: string): string | null {
  let m: RegExpMatchArray | null;
  if (name === 'EVERY_SECOND') return '* * * * * *';
  if ((m = name.match(/^EVERY_(\d+)_SECONDS$/))) return `*/${m[1]} * * * * *`;
  if (name === 'EVERY_MINUTE') return '* * * * *';
  if ((m = name.match(/^EVERY_(\d+)_MINUTES$/))) return `*/${m[1]} * * * *`;
  if (name === 'EVERY_HOUR') return '0 * * * *';
  if ((m = name.match(/^EVERY_(\d+)_HOURS$/))) return `0 */${m[1]} * * *`;
  if (name === 'EVERY_DAY_AT_MIDNIGHT') return '0 0 * * *';
  if (name === 'EVERY_DAY_AT_NOON') return '0 12 * * *';
  if ((m = name.match(/^EVERY_DAY_AT_(\d+)(AM|PM)$/))) {
    const h = Number(m[1]) % 12 + (m[2] === 'PM' ? 12 : 0);
    return `0 ${h} * * *`;
  }
  if (name === 'EVERY_WEEK') return '0 0 * * 0';
  if (name === 'EVERY_WEEKDAY') return '0 0 * * 1-5';
  if (name === 'EVERY_WEEKEND') return '0 0 * * 6,0';
  if (name === 'EVERY_1ST_DAY_OF_MONTH_AT_MIDNIGHT') return '0 0 1 * *';
  if (name === 'EVERY_1ST_DAY_OF_MONTH_AT_NOON') return '0 12 1 * *';
  if (name === 'EVERY_QUARTER') return '0 0 1 */3 *';
  if (name === 'EVERY_6_MONTHS') return '0 0 1 */6 *';
  if (name === 'EVERY_YEAR') return '0 0 1 1 *';
  return null;
}
