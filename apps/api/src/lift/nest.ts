import { posix } from 'node:path';
import ts from 'typescript';
import type {
  SkeletonAgent,
  SkeletonOperation,
  SkeletonProcess,
  SkeletonRoute,
  SkeletonServer,
  SkeletonService,
} from './skeleton.js';
import {
  byString,
  civilId,
  decoratorsOf,
  hasModifier,
  isUnder,
  propName,
  unwrap,
  type Decl,
  type Pkg,
  type RepoContext,
} from './read.js';
import { readRegistries, type DeclaredOperation, type RegistryArray } from './reader-registry.js';
import { customRoutes, HTTP_METHODS } from './reader-decorators.js';

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
  /** The @Module class, or for a feature the declaration that anchors it. */
  node: ts.Node;
  global: boolean;
  imports: string[];
  controllers: Decl[];
  providers: ProviderRec[];
  /**
   * Features whose registry-listed controllers this module mounts: loaded with it, but
   * not a dependency of it — mounting a controller is serving it, not using it.
   */
  mounts: string[];
  /**
   * Role/feature checks guarding an import or mount, by target key: the values checked
   * (`roles.includes("api")` → "api"), or null when some occurrence is unguarded.
   */
  guards: Map<string, Set<string> | null>;
  /** The same, for the controllers it declares, by file#name. */
  controllerGuards: Map<string, Set<string> | null>;
  /** A feature (no @Module: a directory a registry declares) and the directory it owns. */
  feature?: { dir: string; registries: RegistryArray[] };
}

type Entry = (
  | { kind: 'class'; decl: Decl }
  | { kind: 'provider'; rec: ProviderRec }
  | { kind: 'external' }
  | { kind: 'unresolved'; file: string; node: ts.Node; reason: string }
) & {
  /** Values of the role/feature checks this entry is listed behind, when recognisable. */
  guard?: string[];
};

/**
 * What collect() needs beyond the expression: the local consts of the function body it
 * is reading (a module factory's `const base = SharedModule.forRoot(...)`), and a
 * hook that queues a static module factory (`X.forProfiles(...)`) to be read into X.
 */
interface CollectEnv {
  locals?: Map<string, { file: string; expr: ts.Expression }> | undefined;
  /** Queue X.method for reading; false when X has no static method of that name. */
  factory(cls: Decl, method: string): boolean;
  /** An inline dynamic module `{ module: X, imports, providers }`: its fields belong to X. */
  inline(cls: Decl, file: string, obj: ts.ObjectLiteralExpression, guard: string[]): void;
}

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
  // Static module factories (`AppRootModule.forProfiles(profiles)`, `X.forRoot(...)`) are read
  // into their class: every object literal the factory can return is that module's
  // metadata, the union over branches, each entry remembering the role check it sits
  // behind. A factory called inside one (`A.forRoot()` among the imports) is read in
  // turn; each class#method once, and at most FACTORY_LIMIT in all.
  const modules = new Map<string, ModuleRec>();
  const factoryQueue: { cls: Decl; method: string; fn: ts.FunctionLikeDeclaration }[] = [];
  const inlineQueue: { cls: Decl; file: string; obj: ts.ObjectLiteralExpression; guard: string[] }[] = [];
  const factorySeen = new Set<string>();
  const env: CollectEnv = {
    factory(cls, method) {
      const fn = staticMember(cls, method);
      if (!fn) return false;
      const key = `${declKey(cls)}.${method}`;
      if (!factorySeen.has(key)) {
        factorySeen.add(key);
        factoryQueue.push({ cls, method, fn });
      }
      return true;
    },
    inline(cls, file, obj, guard) {
      inlineQueue.push({ cls, file, obj, guard });
    },
  };
  for (const { file, node } of moduleClasses) {
    const rec = readModule(ctx, file, node, unresolved, env);
    modules.set(rec.key, rec);
  }

  // Roots: whatever the bootstrap hands NestFactory.create. Both arms of a
  // `mode === 'worker' ? WorkerModule : AppModule` are served — but not by the same
  // process: each arm is its own deployment of this package, with its own routes and
  // its own ingress, so each is read as its own server below. A bootstrap helper that
  // receives the module as a parameter (`createApp(module)`) is read at its callers.
  const roots: string[] = [];
  const rootCandidates: { file: string; call: ts.CallExpression; entries: Entry[] }[] = [];
  for (const { file, call } of bootstraps) {
    const arg = call.arguments[0];
    if (!arg) continue;
    const passed = parameterArguments(ctx, files, file, arg);
    const entries = passed ? passed.flatMap((p) => collect(ctx, p.file, p.expr, 0, env)) : collect(ctx, file, arg, 0, env);
    rootCandidates.push({ file, call, entries });
  }
  drainFactories(ctx, modules, factoryQueue, inlineQueue, env, unresolved);
  for (const { file, call, entries } of rootCandidates)
    for (const e of entries) {
      if (e.kind === 'class' && modules.has(declKey(e.decl))) {
        if (!roots.includes(declKey(e.decl))) roots.push(declKey(e.decl));
      } else if (e.kind === 'unresolved') unresolved.push({ file, line: ctx.line(file, call), reason: `bootstrap module: ${e.reason}` });
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
      queue.push(...modules.get(key)!.imports, ...modules.get(key)!.mounts);
    }
    return seen;
  };
  let reachable = modulesFrom(roots.length ? roots : [...modules.keys()]);

  const rootDirs = new Set([pkg.dir, posix.join(pkg.dir, 'src')]);
  for (const key of roots) rootDirs.add(posix.dirname(modules.get(key)!.file));
  if (bootstrap) rootDirs.add(posix.dirname(bootstrap.file));

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

  // --- registries: controllers and declarations listed in exported arrays ---
  // A @Controller a registry lists belongs to the directory that defines it; so does a
  // define-factory declaration. Such a directory that no @Module owns is a feature: a
  // service of its own, owning the directory, serving its controllers wherever a module
  // mounts them (or, mounted nowhere, at the root — the registry is the evidence).
  const registry = readRegistries(ctx, files);
  const fileSet = new Set(files);
  const declaringDirs = (): Set<string> => {
    const count = new Map<string, number>();
    for (const k of reachable) {
      const m = modules.get(k)!;
      if (m.controllers.length || m.providers.length) count.set(posix.dirname(m.file), (count.get(posix.dirname(m.file)) ?? 0) + 1);
    }
    return new Set([...count].filter(([d, n]) => n === 1 && !rootDirs.has(d)).map(([d]) => d));
  };
  const ownedDirs = declaringDirs();
  const featureCandidate = (file: string): string | null => {
    const dir = posix.dirname(file);
    if (!fileSet.has(file) || agentOfFile.has(file) || rootDirs.has(dir)) return null;
    if ([...ownedDirs].some((d) => isUnder(file, d))) return null;
    return dir;
  };
  const candidates = new Set<string>();
  for (const { decl } of registry.controllers.values()) {
    const dir = featureCandidate(decl.file);
    if (dir) candidates.add(dir);
  }
  for (const { op } of registry.operations.values()) {
    const dir = featureCandidate(op.file);
    if (dir) candidates.add(dir);
  }
  // A candidate under another is part of it: a feature's ops/ subdirectory is the feature.
  const featureDirs: string[] = [];
  for (const dir of [...candidates].sort((a, b) => a.length - b.length || byString(a, b)))
    if (!featureDirs.some((f) => isUnder(dir, f))) featureDirs.push(dir);
  const featureOf = (file: string): string | undefined => {
    const dir = featureDirs.filter((f) => isUnder(file, f)).sort((a, b) => b.length - a.length)[0];
    return dir ? `feature:${dir}` : undefined;
  };
  for (const dir of featureDirs.sort(byString)) {
    const controllers = [...registry.controllers.values()].filter((c) => isUnder(c.decl.file, dir)).map((c) => c.decl);
    const ops = [...registry.operations.values()].filter((o) => isUnder(o.op.file, dir));
    const registries = [...new Set([...registry.controllers.values()].filter((c) => isUnder(c.decl.file, dir)).flatMap((c) => c.registries).concat(ops.flatMap((o) => o.registries)))];
    // Anchored on the feature's own registry when it keeps one (its index's exported
    // array), else on its first controller, else on its first declaration.
    const own = registry.arrays.filter((a) => isUnder(a.file, dir) && registries.includes(a)).sort((a, b) => a.file.length - b.file.length || byString(a.file, b.file))[0];
    const anchorDecl = own ? ctx.declarations(own.file).get(own.name) : undefined;
    const firstController = controllers.sort((a, b) => byString(a.file, b.file) || byString(a.name, b.name))[0];
    // Labelled by its directory ("orders" → OrdersFeature): the directory is the unit,
    // whatever its registry array or first declaration happens to be called.
    const label = featureLabel(dir);
    let rec: ModuleRec;
    if (own && anchorDecl) rec = newModuleRec(`feature:${dir}`, label, own.file, anchorDecl.node);
    else if (firstController) rec = newModuleRec(`feature:${dir}`, label, firstController.file, firstController.node);
    else {
      const first = ops.map((o) => o.op).sort((a, b) => byString(a.file, b.file) || a.line - b.line)[0]!;
      const bound = first.key.includes('#') ? ctx.declarations(first.file).get(first.key.split('#')[1]!) : undefined;
      rec = newModuleRec(`feature:${dir}`, label, first.file, bound?.node ?? ctx.sourceFile(first.file)!);
    }
    rec.controllers = controllers;
    rec.feature = { dir, registries: registries.sort((a, b) => byString(a.file, b.file) || a.line - b.line) };
    modules.set(rec.key, rec);
  }
  // Modules that declare a feature's registry-listed controller mount the feature: the
  // controller is the feature's, served wherever the mounting module is loaded.
  const mounted = new Set<string>();
  for (const m of modules.values()) {
    if (m.feature) continue;
    const keep: Decl[] = [];
    for (const c of m.controllers) {
      const f = registry.controllers.has(declKey(c)) ? featureOf(c.file) : undefined;
      if (!f || !modules.has(f)) {
        keep.push(c);
        continue;
      }
      if (!m.mounts.includes(f)) m.mounts.push(f);
      const g = m.controllerGuards.get(declKey(c));
      mergeGuard(m.guards, f, g === undefined || g === null ? undefined : [...g]);
      mounted.add(f);
    }
    m.controllers = keep;
  }
  // A feature nothing mounts is still declared by its registry: served at the root.
  for (const dir of featureDirs) {
    const key = `feature:${dir}`;
    if (mounted.has(key)) continue;
    if (roots[0]) {
      modules.get(roots[0])!.mounts.push(key);
      mergeGuard(modules.get(roots[0])!.guards, key, undefined);
    }
  }
  reachable = modulesFrom(roots.length ? roots : [...modules.keys()]);
  for (const m of [...modules.values()].sort((a, b) => byString(a.key, b.key)))
    if (!reachable.has(m.key))
      unresolved.push({ file: m.file, line: ctx.line(m.file, m.node), reason: `${m.name} is not imported from the bootstrap's root module, so Nest never loads it; not read` });

  // --- services: one per reachable module that declares something ---
  const serviceMods = [...reachable]
    .map((k) => modules.get(k)!)
    .filter((m) => m.controllers.length || m.providers.length || m.feature)
    .sort((a, b) => byString(a.key, b.key));
  const idOf = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const m of serviceMods) {
    let id = civilId(m.feature ? posix.basename(m.feature.dir) : m.name.replace(/Module$/, '') || m.name);
    if (usedIds.has(id)) id = civilId(`${posix.basename(posix.dirname(m.feature?.dir ?? m.file))}-${id}`);
    for (let n = 2; usedIds.has(id); n++) id = civilId(`${m.feature ? posix.basename(m.feature.dir) : m.name}-${n}`);
    usedIds.add(id);
    idOf.set(m.key, id);
  }

  // Which service a file belongs to: a module's directory is its own when it is the
  // only module there and is not the app's root; otherwise only the files of the
  // classes it declares. Deepest directory wins, so a nested feature keeps its files.
  // A feature owns its directory.
  const moduleDirs = new Map<string, string[]>();
  for (const m of serviceMods) {
    const dir = m.feature?.dir ?? posix.dirname(m.file);
    moduleDirs.set(dir, [...(moduleDirs.get(dir) ?? []), m.key]);
  }
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
  // --- declared operations: each to the service that owns the file defining it ---
  const opsOf = new Map<string, SkeletonOperation[]>();
  const declaredByOf = new Map<string, Set<RegistryArray>>();
  const credit = (id: string, registries: RegistryArray[]) => {
    const set = declaredByOf.get(id) ?? new Set<RegistryArray>();
    for (const r of registries) set.add(r);
    declaredByOf.set(id, set);
  };
  const unattached = new Map<string, DeclaredOperation[]>();
  const ownerOfOp = (op: DeclaredOperation) => ownerOf.get(op.file) ?? serviceOfFile(op.file);
  for (const { op, registries } of [...registry.operations.values()].sort((a, b) => byString(a.op.file, b.op.file) || a.op.line - b.op.line)) {
    const owner = ownerOfOp(op);
    if (!owner) {
      unattached.set(op.file, [...(unattached.get(op.file) ?? []), op]);
      continue;
    }
    const entry: SkeletonOperation = { name: op.name, file: op.file, line: op.line, kind: op.kind };
    if (op.exposure !== undefined) entry.exposure = op.exposure;
    if (op.tool) entry.tool = true;
    if (op.scheduled) entry.scheduled = true;
    opsOf.set(owner, [...(opsOf.get(owner) ?? []), entry]);
    credit(owner, registries);
  }
  for (const [file, ops] of unattached)
    unresolved.push({
      file,
      line: ops[0]!.line,
      reason: `${ops.length} declared operation${ops.length === 1 ? '' : 's'} (${ops.map((o) => o.name).join(', ')}) in code no service owns; not attributed`,
    });
  for (const m of serviceMods)
    for (const c of m.controllers) {
      const listed = registry.controllers.get(declKey(c));
      if (listed) credit(idOf.get(m.key)!, listed.registries);
    }

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
    // Mounting a feature's controllers is serving them, not depending on the feature.
    for (const f of m.mounts) if (idOf.has(f) && !m.imports.includes(f)) deps.delete(idOf.get(f)!);

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
    const ops = opsOf.get(id);
    if (ops?.length) service.operations = ops;
    const declaredBy = [...(declaredByOf.get(id) ?? [])].sort((a, b) => byString(a.file, b.file) || a.line - b.line);
    if (declaredBy.length) service.declaredBy = declaredBy.map((r) => ({ name: r.name, file: r.file, line: r.line }));
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

  /**
   * Services a root loads only behind a role check, by the value checked. A module
   * reached by some path of unguarded imports is loaded whatever the role; the rest are
   * credited to the checks on the guarded edges that lead to them.
   */
  const rolesFrom = (root: string): { name: string; services: string[] }[] => {
    const edges = (m: ModuleRec) => [...m.imports, ...m.mounts];
    const open = new Set<string>();
    const queue = [root];
    while (queue.length) {
      const key = queue.shift()!;
      if (open.has(key) || !modules.has(key)) continue;
      open.add(key);
      const m = modules.get(key)!;
      for (const t of edges(m)) if (!m.guards.get(t)) queue.push(t);
    }
    const byRole = new Map<string, Set<string>>();
    for (const key of modulesFrom([root])) {
      const m = modules.get(key)!;
      for (const t of edges(m)) {
        const guard = m.guards.get(t);
        if (!guard) continue;
        for (const u of modulesFrom([t])) {
          if (open.has(u) || !idOf.has(u)) continue;
          for (const label of guard) byRole.set(label, (byRole.get(label) ?? new Set()).add(idOf.get(u)!));
        }
      }
    }
    return [...byRole]
      .sort((a, b) => byString(a[0], b[0]))
      .map(([name, ids]) => ({ name, services: [...ids].sort(byString) }));
  };

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
    const roles = d.root ? rolesFrom(d.root) : [];
    if (roles.length) server.roles = roles;
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
  // Scheduled declarations (`defineTimer({ ... })`, an object with a `cron`): each is
  // a process calling the service that declares it.
  for (const { op } of [...registry.operations.values()].sort((a, b) => byString(a.op.file, b.op.file) || a.op.line - b.op.line)) {
    if (!op.scheduled) continue;
    if (op.problem) unresolved.push({ file: op.file, line: op.line, reason: op.problem });
    const owner = ownerOfOp(op);
    if (!owner) continue;
    let id = civilId(op.name);
    if (processIds.has(id)) id = civilId(`${owner}-${id}`);
    for (let n = 2; processIds.has(id); n++) id = civilId(`${op.name}-${n}`);
    processIds.add(id);
    processes.push({ id, schedule: op.schedule ?? '@unknown', calls: [owner], source: { file: op.file, line: op.line } });
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

/** A feature's label from its directory: "orders" → "OrdersFeature", "user-graph" → "UserGraphFeature". */
export const featureLabel = (dir: string): string =>
  `${posix
    .basename(dir)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('')}Feature`;

const newModuleRec = (key: string, name: string, file: string, node: ts.Node): ModuleRec => ({
  key,
  name,
  file,
  node,
  global: false,
  imports: [],
  controllers: [],
  providers: [],
  mounts: [],
  guards: new Map(),
  controllerGuards: new Map(),
});

function readModule(ctx: RepoContext, file: string, node: ts.ClassDeclaration, unresolved: Unresolved[], env: CollectEnv): ModuleRec {
  const name = node.name!.text;
  const rec = newModuleRec(`${file}#${name}`, name, file, node);
  rec.global = decoratorsOf(node).some((d) => d.name === 'Global');
  const deco = decoratorsOf(node).find((d) => d.name === 'Module')!;
  const meta = deco.args[0] ? objectLiteralOf(ctx, file, deco.args[0]) : undefined;
  if (deco.args[0] && !meta) {
    unresolved.push({ file, line: ctx.line(file, node), reason: `${name}: @Module metadata is not an object literal; module not read` });
    return rec;
  }
  if (meta) absorbMetadata(ctx, rec, meta.file, meta.node, [], env, unresolved);
  return rec;
}

/** Merge a guard into what is recorded for one edge: unguarded anywhere is unguarded. */
function mergeGuard(map: Map<string, Set<string> | null>, key: string, guard: readonly string[] | undefined): void {
  if (!guard?.length) {
    map.set(key, null);
    return;
  }
  if (!map.has(key)) map.set(key, new Set(guard));
  else {
    const prev = map.get(key);
    if (prev) for (const g of guard) prev.add(g);
  }
}

/**
 * Read a module metadata object — @Module({...}) or the object a module factory returns —
 * into a module: imports, controllers and providers, each entry with the role checks
 * it is listed behind. Called for every return of a factory, so a factory's result is
 * the union of its branches; `...base` spreads of another metadata object are followed.
 */
function absorbMetadata(
  ctx: RepoContext,
  rec: ModuleRec,
  file: string,
  obj: ts.ObjectLiteralExpression,
  guard: string[],
  env: CollectEnv,
  unresolved: Unresolved[],
  depth = 0,
): void {
  if (depth > 6) return;
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const base = objectLiteralOf(ctx, file, prop.expression, env.locals);
      if (base) absorbMetadata(ctx, rec, base.file, base.node, guard, env, unresolved, depth + 1);
      continue;
    }
    let init: ts.Expression | undefined;
    if (ts.isPropertyAssignment(prop)) init = prop.initializer;
    else if (ts.isShorthandPropertyAssignment(prop)) init = prop.name;
    if (!init || !prop.name) continue;
    const field = propName(prop.name as ts.PropertyName);
    if (field !== 'imports' && field !== 'controllers' && field !== 'providers') continue;
    const entries = collect(ctx, file, init, 0, env).map((e) => (guard.length ? { ...e, guard: [...guard, ...(e.guard ?? [])] } : e));
    for (const e of entries) {
      if (e.kind === 'external') continue;
      if (e.kind === 'unresolved') {
        if (!unresolved.some((u) => u.file === e.file && u.line === ctx.line(e.file, e.node) && u.reason === `${rec.name}.${field}: ${e.reason}`))
          unresolved.push({ file: e.file, line: ctx.line(e.file, e.node), reason: `${rec.name}.${field}: ${e.reason}` });
        continue;
      }
      if (field === 'imports') {
        if (e.kind !== 'class') continue;
        const key = declKey(e.decl);
        if (key === rec.key) continue;
        if (!rec.imports.includes(key)) rec.imports.push(key);
        mergeGuard(rec.guards, key, e.guard);
      } else if (field === 'controllers') {
        if (e.kind !== 'class') continue;
        const key = declKey(e.decl);
        if (!rec.controllers.some((c) => declKey(c) === key)) rec.controllers.push(e.decl);
        mergeGuard(rec.controllerGuards, key, e.guard);
      } else {
        const p: ProviderRec =
          e.kind === 'class'
            ? { name: e.decl.name, file: e.decl.file, keys: [declKey(e.decl)], roots: [{ file: e.decl.file, node: e.decl.node }], cls: e.decl }
            : e.rec;
        if (!rec.providers.some((x) => x.name === p.name && x.file === p.file && x.keys.join() === p.keys.join())) rec.providers.push(p);
      }
    }
  }
}

function objectLiteralOf(
  ctx: RepoContext,
  file: string,
  expr: ts.Expression,
  locals?: Map<string, { file: string; expr: ts.Expression }>,
): { file: string; node: ts.ObjectLiteralExpression } | undefined {
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) return { file, node: e };
  if (ts.isIdentifier(e)) {
    const local = locals?.get(e.text);
    if (local) return objectLiteralOf(ctx, local.file, local.expr);
    const d = ctx.resolveName(file, e.text);
    if (d && !('external' in d) && ts.isVariableDeclaration(d.node) && d.node.initializer)
      return objectLiteralOf(ctx, d.file, d.node.initializer);
  }
  return undefined;
}

/**
 * The values a condition checks, when it is a recognisable role or feature check:
 * `roles.includes("api")`, `flags.has("beta")`, `mode === "worker"` (either side),
 * combined with && or ||, through local consts (`const isApi = roles.includes("api")`).
 * Anything else — a negation, a boolean flag, a computed value — gives none: the entry
 * is then read as unguarded, which is the union every reading of the code includes.
 */
function guardLabels(ctx: RepoContext, file: string, expr: ts.Expression, env: CollectEnv, depth = 0): string[] {
  if (depth > 6) return [];
  const e = unwrap(expr);
  const literal = (x: ts.Expression): string | undefined => {
    const u = unwrap(x);
    return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined;
  };
  if (ts.isIdentifier(e)) {
    const local = env.locals?.get(e.text);
    return local ? guardLabels(ctx, local.file, local.expr, env, depth + 1) : [];
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken)
      return [...guardLabels(ctx, file, e.left, env, depth + 1), ...guardLabels(ctx, file, e.right, env, depth + 1)];
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken) {
      const v = literal(e.right) ?? literal(e.left);
      return v !== undefined ? [v] : [];
    }
    return [];
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ['includes', 'has'].includes(e.expression.name.text) && e.arguments.length === 1) {
    const v = literal(e.arguments[0]!);
    return v !== undefined ? [v] : [];
  }
  return [];
}

const withGuard = (entries: Entry[], labels: string[]): Entry[] =>
  labels.length ? entries.map((x) => ({ ...x, guard: [...labels, ...(x.guard ?? [])] })) : entries;

/**
 * The entries of a module metadata array, as Nest would see them: arrays and spreads
 * flattened, both arms of a conditional (the guarded arm remembering its check),
 * `forwardRef(() => X)` unwrapped, local consts of the factory being read followed,
 * dynamic modules from a static factory (`X.forRoot(...)`, `X.forProfiles(...)`) read as
 * X with the factory queued to be read into X, and provider objects
 * (`{ provide, useClass | useFactory | useValue | useExisting }`) kept whole.
 */
function collect(ctx: RepoContext, file: string, expr: ts.Expression, depth: number, env: CollectEnv): Entry[] {
  if (depth > 8) return [{ kind: 'unresolved', file, node: expr, reason: `"${short(expr)}" nests too deeply to read` }];
  const e = unwrap(expr);
  if (ts.isArrayLiteralExpression(e))
    return e.elements.flatMap((el) => collect(ctx, file, ts.isSpreadElement(el) ? el.expression : el, depth + 1, env));
  if (ts.isConditionalExpression(e))
    return [
      ...withGuard(collect(ctx, file, e.whenTrue, depth + 1, env), guardLabels(ctx, file, e.condition, env)),
      ...collect(ctx, file, e.whenFalse, depth + 1, env),
    ];
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return withGuard(collect(ctx, file, e.right, depth + 1, env), guardLabels(ctx, file, e.left, env));
  if (ts.isIdentifier(e)) {
    const local = env.locals?.get(e.text);
    if (local) return collect(ctx, local.file, local.expr, depth + 1, env);
    const d = ctx.resolveName(file, e.text);
    if (!d) return [{ kind: 'unresolved', file, node: e, reason: `cannot find where "${e.text}" is defined` }];
    if ('external' in d) return [{ kind: 'external' }];
    if (d.kind === 'class') return [{ kind: 'class', decl: d }];
    if (ts.isVariableDeclaration(d.node) && d.node.initializer) {
      const init = unwrap(d.node.initializer);
      if (ts.isObjectLiteralExpression(init) && !init.properties.some((p) => p.name && propName(p.name as ts.PropertyName) === 'module'))
        return [providerObject(ctx, d.file, init, d.name)];
      return collect(ctx, d.file, init, depth + 1, { ...env, locals: undefined });
    }
    return [{ kind: 'unresolved', file, node: e, reason: `"${e.text}" is not a class, array or provider object` }];
  }
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    if (ts.isIdentifier(callee) && callee.text === 'forwardRef') {
      const fn = e.arguments[0] ? unwrap(e.arguments[0]) : undefined;
      if (fn && ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return collect(ctx, file, fn.body, depth + 1, env);
      return [{ kind: 'unresolved', file, node: e, reason: `forwardRef whose target is not an arrow returning a class` }];
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      const target = unwrap(callee.expression);
      // `POLICIES.map((g) => ({ provide: APP_GUARD, useClass: g }))`: one binding per class.
      if (method === 'map' && e.arguments[0]) {
        const fn = unwrap(e.arguments[0]);
        const body = (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !ts.isBlock(fn.body) ? unwrap(fn.body) : undefined;
        if (body && ts.isObjectLiteralExpression(body)) {
          const bound = providerObject(ctx, file, body, undefined);
          if (bound.kind === 'provider')
            return collect(ctx, file, target, depth + 1, env).map((x): Entry => {
              if (x.kind !== 'class') return x;
              return { kind: 'provider', rec: { ...bound.rec, name: x.decl.name, file: x.decl.file, cls: x.decl }, ...(x.guard ? { guard: x.guard } : {}) };
            });
        }
      }
      if (ts.isIdentifier(target)) {
        const d = env.locals?.has(target.text) ? null : ctx.resolveName(file, target.text);
        if (d && 'external' in d) return [{ kind: 'external' }];
        if (d && d.kind === 'class') {
          if (env.factory(d, method) || /^(forRoot|forFeature|register|forChild)/.test(method)) return [{ kind: 'class', decl: d }];
          return [{ kind: 'unresolved', file, node: e, reason: `"${short(e)}": ${d.name} has no static ${method} the reader can read` }];
        }
      }
      if (/^(forRoot|forFeature|register|forChild)/.test(method)) return collect(ctx, file, callee.expression, depth + 1, env);
    }
    return [{ kind: 'unresolved', file, node: e, reason: `"${short(e)}" is computed by a call` }];
  }
  if (ts.isObjectLiteralExpression(e)) {
    const moduleProp = e.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === 'module') as ts.PropertyAssignment | undefined;
    if (moduleProp) {
      const found = collect(ctx, file, moduleProp.initializer, depth + 1, env);
      for (const x of found) if (x.kind === 'class') env.inline(x.decl, file, e, x.guard ?? []);
      return found;
    }
    return [providerObject(ctx, file, e, undefined)];
  }
  return [{ kind: 'unresolved', file, node: e, reason: `"${short(e)}" is not a form the reader understands` }];
}

/** A class's static method (or static arrow property) by name. */
function staticMember(cls: Decl, method: string): ts.FunctionLikeDeclaration | undefined {
  if (!ts.isClassDeclaration(cls.node)) return undefined;
  for (const m of cls.node.members) {
    if (!hasModifier(m, ts.SyntaxKind.StaticKeyword) || !m.name || propName(m.name as ts.PropertyName) !== method) continue;
    if (ts.isMethodDeclaration(m) && m.body) return m;
    if (ts.isPropertyDeclaration(m) && m.initializer) {
      const init = unwrap(m.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
    }
  }
  return undefined;
}

const isFunctionLike = (n: ts.Node): boolean =>
  ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n);

/**
 * What a static module factory returns: every object literal any of its return
 * statements yields — through `if (cond) return …` (the then-branch guarded by cond),
 * conditional expressions, and local consts — with the local consts of its body, so
 * the metadata can name them. Nested functions' returns are not the factory's.
 */
function readFactory(fn: ts.FunctionLikeDeclaration, file: string, env: CollectEnv, ctx: RepoContext): {
  returns: { obj: ts.ObjectLiteralExpression; guard: string[] }[];
  locals: Map<string, { file: string; expr: ts.Expression }>;
} {
  const locals = new Map<string, { file: string; expr: ts.Expression }>();
  const returns: { obj: ts.ObjectLiteralExpression; guard: string[] }[] = [];
  const body = fn.body;
  if (!body) return { returns, locals };
  const scoped: CollectEnv = { ...env, locals };
  const gatherLocals = (n: ts.Node): void => {
    if (n !== body && isFunctionLike(n)) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) locals.set(n.name.text, { file, expr: n.initializer });
    ts.forEachChild(n, gatherLocals);
  };
  gatherLocals(body);
  const returned = (expr: ts.Expression, guard: string[], depth: number): void => {
    if (depth > 6) return;
    const e = unwrap(expr);
    if (ts.isObjectLiteralExpression(e)) returns.push({ obj: e, guard });
    else if (ts.isConditionalExpression(e)) {
      returned(e.whenTrue, [...guard, ...guardLabels(ctx, file, e.condition, scoped)], depth + 1);
      returned(e.whenFalse, guard, depth + 1);
    } else if (ts.isIdentifier(e) && locals.has(e.text)) returned(locals.get(e.text)!.expr, guard, depth + 1);
  };
  const visit = (n: ts.Node, guard: string[]): void => {
    if (n !== body && isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) {
      if (n.expression) returned(n.expression, guard, 0);
      return;
    }
    if (ts.isIfStatement(n)) {
      visit(n.thenStatement, [...guard, ...guardLabels(ctx, file, n.expression, scoped)]);
      if (n.elseStatement) visit(n.elseStatement, guard);
      return;
    }
    ts.forEachChild(n, (c) => visit(c, guard));
  };
  if (ts.isBlock(body)) visit(body, []);
  else returned(body as ts.Expression, [], 0);
  return { returns, locals };
}

/** The most static factories one server's read follows: a guard, not a budget. */
const FACTORY_LIMIT = 64;

/**
 * Read queued module factories and inline dynamic modules into their classes, until
 * none are left (a factory's metadata may call further factories). A class with a
 * factory but no @Module decorator is still a module: Nest takes the dynamic module.
 */
function drainFactories(
  ctx: RepoContext,
  modules: Map<string, ModuleRec>,
  factories: { cls: Decl; method: string; fn: ts.FunctionLikeDeclaration }[],
  inlines: { cls: Decl; file: string; obj: ts.ObjectLiteralExpression; guard: string[] }[],
  env: CollectEnv,
  unresolved: Unresolved[],
): void {
  const ensure = (cls: Decl): ModuleRec => {
    const key = declKey(cls);
    if (!modules.has(key)) modules.set(key, newModuleRec(key, cls.name, cls.file, cls.node));
    return modules.get(key)!;
  };
  const inlineSeen = new Set<ts.Node>();
  let read = 0;
  while (factories.length || inlines.length) {
    if (read++ >= FACTORY_LIMIT) {
      const next = factories[0] ?? null;
      if (next)
        unresolved.push({ file: next.cls.file, line: ctx.line(next.cls.file, next.fn), reason: `more than ${FACTORY_LIMIT} module factories; ${next.cls.name}.${next.method} and later ones not read` });
      break;
    }
    const inline = inlines.shift();
    if (inline) {
      if (inlineSeen.has(inline.obj)) continue;
      inlineSeen.add(inline.obj);
      absorbMetadata(ctx, ensure(inline.cls), inline.file, inline.obj, inline.guard, env, unresolved);
      continue;
    }
    const { cls, method, fn } = factories.shift()!;
    const rec = ensure(cls);
    const { returns, locals } = readFactory(fn, cls.file, env, ctx);
    if (!returns.length)
      unresolved.push({ file: cls.file, line: ctx.line(cls.file, fn), reason: `${cls.name}.${method} returns no module object the reader can read` });
    for (const r of returns) absorbMetadata(ctx, rec, cls.file, r.obj, r.guard, { ...env, locals }, unresolved);
  }
}

/**
 * When the bootstrap is a helper that takes the module as a parameter
 * (`const createApp = (module) => NestFactory.create(module)`), the modules are what
 * its callers in the package pass in that position — through a local const of the
 * calling function when that is how the caller names it. Null when `arg` is not such
 * a parameter or nothing calls the helper.
 */
function parameterArguments(ctx: RepoContext, files: readonly string[], file: string, arg: ts.Expression): { file: string; expr: ts.Expression }[] | null {
  const e = unwrap(arg);
  if (!ts.isIdentifier(e) || ctx.resolveName(file, e.text)) return null;
  let fn: ts.Node | undefined = e.parent;
  while (fn && !(ts.isFunctionLike(fn) && fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === e.text))) fn = fn.parent;
  if (!fn || !ts.isFunctionLike(fn)) return null;
  const index = fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === e.text);
  let declNode: ts.Node | undefined;
  let name: string | undefined;
  if (ts.isFunctionDeclaration(fn) && fn.name) [declNode, name] = [fn, fn.name.text];
  else {
    let p: ts.Node | undefined = fn.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p))) p = p.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) [declNode, name] = [p, p.name.text];
  }
  if (!declNode || !name) return null;
  const out: { file: string; expr: ts.Expression }[] = [];
  for (const f of files) {
    if (!(ctx.files[f] ?? '').includes(name)) continue;
    const sf = ctx.sourceFile(f);
    if (!sf) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name && n.arguments[index]) {
        const d = ctx.resolveName(f, name);
        if (d && !('external' in d) && d.node === declNode) out.push({ file: f, expr: localValue(n.arguments[index]!) });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out.length ? out : null;
}

/** An identifier bound by a const in an enclosing function: its initializer; else itself. */
function localValue(expr: ts.Expression): ts.Expression {
  const e = unwrap(expr);
  if (!ts.isIdentifier(e)) return expr;
  for (let scope: ts.Node | undefined = e.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope)) continue;
    for (const stmt of scope.statements)
      if (ts.isVariableStatement(stmt))
        for (const d of stmt.declarationList.declarations)
          if (ts.isIdentifier(d.name) && d.name.text === e.text && d.initializer) return d.initializer;
  }
  return expr;
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
 * Agents, three ways. A directory under `agents/` with a definition file (agent.ts,
 * <x>-agent.ts, <x>.agent.ts, or a prompt) is one agent per definition, owning the
 * files beside it and its tools/ directory. By file convention, a `<name>.agent.ts`
 * anywhere (or a `<name>.ts` directly in an agent/ or agents/ directory) exporting a
 * value is the agent <name> with its same-prefix parts, whatever it calls the model
 * through. Otherwise, a file that imports a model SDK AND asks it to generate is one
 * agent — the second test is what keeps an embedding client or an SDK wrapper from
 * being drawn as one.
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
      const { tools, codeFiles } = toolsOf(ctx, n.f, agentFiles, dir);
      for (const t of codeFiles) if (!agentFiles.includes(t)) agentFiles.push(t);
      agentFiles.sort(byString);
      agents.push({ id, files: agentFiles, tools, source: { file: n.f } });
      for (const f of agentFiles) if (!agentOfFile.has(f)) agentOfFile.set(f, id);
    }
  }

  // By file convention: `<name>.agent.ts` anywhere, or `<name>.ts` directly in an agent/
  // or agents/ directory, that exports a class, function or object, is the agent <name>
  // — however it reaches the model (an SDK, or the project's own gateway). It owns the
  // siblings that share its prefix: <name>.prompt.ts, <name>.output.ts, <name>.tools.ts.
  const inGroup = (f: string) => [...groups.keys()].some((d) => isUnder(f, d));
  const conventional = files
    .filter((f) => !agentOfFile.has(f) && !inGroup(f))
    .flatMap((f) => {
      const name = conventionAgentName(f);
      return name && exportsValue(ctx, f) ? [{ f, name }] : [];
    });
  const conventionDefs = new Set(conventional.map((c) => c.f));
  for (const { f, name } of conventional) {
    const dir = posix.dirname(f);
    const siblings = files.filter(
      (s) => s !== f && posix.dirname(s) === dir && posix.basename(s).startsWith(`${name}.`) && !conventionDefs.has(s) && !agentOfFile.has(s),
    );
    const agentFiles = [f, ...siblings].sort(byString);
    const { tools } = toolsOf(ctx, f, agentFiles, null);
    const id = civilId(name);
    agents.push({ id, files: agentFiles, tools, source: { file: f } });
    for (const x of agentFiles) if (!agentOfFile.has(x)) agentOfFile.set(x, id);
  }

  for (const f of files) {
    if (agentOfFile.has(f) || inGroup(f)) continue;
    if (!importsModelSdk(ctx, f) || !GENERATION_CALL.test(ctx.files[f] ?? '')) continue;
    const id = civilId(posix.basename(f).replace(/\.(m?[tj]sx?)$/, '').replace(/[.-](service|agent|client|provider)$/, ''));
    agents.push({ id, files: [f], tools: toolsOf(ctx, f, [f], null).tools, source: { file: f } });
    agentOfFile.set(f, id);
  }
  agents.sort((a, b) => byString(a.id, b.id));
  return { agents, agentOfFile };
}

/** Stems that name an agent's parts or a directory's plumbing, never an agent. */
const NOT_AGENT_STEM = /^(index|types?|utils?|helpers?|constants?|config|shared|common|base|prompts?|tools?|outputs?|schemas?)$/;

/**
 * The agent a file defines by convention, by name: `<name>.agent.ts` anywhere, or
 * `<name>.ts` directly in an agent/ or agents/ directory (a part like <name>.prompt.ts,
 * or plumbing like index.ts, is not one). Null otherwise.
 */
function conventionAgentName(file: string): string | null {
  const base = posix.basename(file).replace(/\.(m?[tj]sx?)$/, '');
  const suffixed = /^(.+)\.agent$/.exec(base);
  if (suffixed) return suffixed[1]!;
  const parent = posix.basename(posix.dirname(file));
  if (parent !== 'agent' && parent !== 'agents') return null;
  if (base.includes('.') || NOT_AGENT_STEM.test(base)) return null;
  return base;
}

/** True when a file exports a class, a function, or a const holding a value (not only types). */
function exportsValue(ctx: RepoContext, file: string): boolean {
  for (const stmt of ctx.sourceFile(file)?.statements ?? []) {
    if (ts.isExportAssignment(stmt)) return true;
    if (!hasModifier(stmt, ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isClassDeclaration(stmt) || ts.isFunctionDeclaration(stmt)) return true;
    if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.some((d) => d.initializer)) return true;
  }
  return false;
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
 * An agent's tools: what its definition (or its <name>.tools.ts part) lists as
 * `tools: [...]` or in an exported `…tools` array — each entry resolved to the file
 * that defines it; an array a const holds is read through; a tool written as a name
 * ('search') or an object with a fixed `name` is that name — plus every file in its
 * tools/ directory.
 */
function toolsOf(
  ctx: RepoContext,
  def: string,
  agentFiles: string[],
  dir: string | null,
): { tools: { name: string; file: string }[]; codeFiles: string[] } {
  const tools = new Map<string, string>();
  /** Files that define a tool as code (not a tool named by a string). */
  const codeFiles = new Set<string>();
  const toolName = (file: string, ident: string) => (file === def ? ident : civilId(posix.basename(file).replace(/\.(m?[tj]sx?)$/, '')));
  const entries = (file: string, expr: ts.Expression, depth: number): void => {
    if (depth > 6) return;
    const e = unwrap(expr);
    if (ts.isArrayLiteralExpression(e)) {
      for (const el of e.elements) entries(file, ts.isSpreadElement(el) ? el.expression : el, depth + 1);
      return;
    }
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      tools.set(`${file}#${e.text}`, e.text);
      return;
    }
    if (ts.isObjectLiteralExpression(e)) {
      const n = e.properties.find((p) => ts.isPropertyAssignment(p) && propName(p.name) === 'name') as ts.PropertyAssignment | undefined;
      const value = n ? ctx.evalString(file, n.initializer) : undefined;
      if (value) tools.set(`${file}#${value}`, value);
      return;
    }
    let target = e;
    if (ts.isCallExpression(target) || ts.isNewExpression(target)) target = unwrap(target.expression);
    if (!ts.isIdentifier(target)) return;
    const d = ctx.resolveName(file, target.text);
    if (!d || 'external' in d) return;
    // A const holding the list itself (`tools: AGENT_TOOLS`) is read through.
    if (target === e && ts.isVariableDeclaration(d.node) && d.node.initializer && ts.isArrayLiteralExpression(unwrap(d.node.initializer))) {
      entries(d.file, d.node.initializer, depth + 1);
      return;
    }
    tools.set(d.file === def ? `${def}#${target.text}` : d.file, toolName(d.file, target.text));
    codeFiles.add(d.file);
  };
  const scan = (file: string) => {
    const sf = ctx.sourceFile(file);
    if (!sf) return;
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && propName(n.name) === 'tools') entries(file, n.initializer, 0);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /tools$/i.test(n.name.text) && n.initializer && ts.isArrayLiteralExpression(unwrap(n.initializer)) && n.parent.parent && hasModifier(n.parent.parent, ts.SyntaxKind.ExportKeyword))
        entries(file, n.initializer, 0);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  };
  scan(def);
  for (const f of agentFiles) if (f !== def && posix.dirname(f) === posix.dirname(def) && /[.-]tools?\.(m?[tj]sx?)$/.test(f)) scan(f);
  if (dir)
    for (const f of agentFiles)
      if (isUnder(f, posix.join(dir, 'tools')) && !tools.has(f) && !/\/index\.[tj]sx?$/.test(f)) tools.set(f, toolName(f, ''));
  const byName = new Map<string, string>();
  for (const [key, name] of tools) if (!byName.has(name)) byName.set(name, key.split('#')[0]!);
  const list = [...byName].map(([name, file]) => ({ name, file })).sort((a, b) => byString(a.name, b.name) || byString(a.file, b.file));
  return { tools: list, codeFiles: [...codeFiles].sort(byString) };
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

/** The path a route is recorded under when a custom decorator computes it at runtime. */
const COMPUTED_PATH = '<computed>';

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
    const line = ctx.line(c.file, member);
    const mount = (method: SkeletonRoute['method'], methodPaths: string[]) => {
      for (const cp of ctrlPaths)
        for (const mp of methodPaths) {
          const bare = joinPath(cp, mp);
          const excluded = prefix?.exclude.some((x) => x.test.test(trimSlashes(bare)) && (x.method === null || x.method === method));
          routes.push({
            method,
            path: prefix && !excluded ? joinPath(prefix.value, bare) : bare,
            controller: c.name,
            handler,
            source: { file: c.file, line },
          });
        }
    };
    for (const d of decoratorsOf(member)) {
      const method = HTTP_METHODS[d.name];
      if (!method) {
        // A project's own decorator wrapping Nest's (applyDecorators(Get(path), ...)).
        for (const r of customRoutes(ctx, c.file, d.node.expression) ?? []) {
          if (!r.method) {
            unresolved.push({ file: c.file, line, reason: `${c.name}.${handler}: @${d.name} mounts a route through ${r.via} whose method is computed at runtime; route not read` });
            continue;
          }
          if (r.paths) {
            mount(r.method, r.paths);
            continue;
          }
          unresolved.push({ file: c.file, line, reason: `${c.name}.${handler}: @${d.name} mounts ${r.method} through ${r.via} at a path computed at runtime; recorded as ${COMPUTED_PATH}` });
          routes.push({ method: r.method, path: COMPUTED_PATH, controller: c.name, handler, source: { file: c.file, line } });
        }
        continue;
      }
      const methodPaths = pathsOf(ctx, c.file, d.args[0]);
      if (!methodPaths) {
        unresolved.push({ file: c.file, line, reason: `${c.name}.${handler}: @${d.name} path is computed at runtime; route not read` });
        continue;
      }
      mount(method, methodPaths);
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
