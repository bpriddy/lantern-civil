import { posix } from 'node:path';
import ts from 'typescript';
import { emptySkeleton, type FileMap, type Skeleton, type SkeletonClient } from './skeleton.js';
import { readNestServer, type NestRead } from './nest.js';
import { readViteClient } from './vite.js';
import { readSchedulerJobs } from './schedules.js';

/**
 * The deterministic reader: an existing repository's file map in, a Skeleton out
 * (docs/lift-repo.md). Pure — it parses text the caller already loaded, never a
 * filesystem — so it runs on the server path under no-local-file-storage, and the
 * same commit always reads to the same skeleton.
 *
 * Syntax only: each file is parsed with ts.createSourceFile and walked. There is no
 * Program and no type checker, because a checker wants node_modules and a lib to
 * resolve against, and the repo's dependencies are exactly what we do not have. What
 * the reader needs from "types" — which class a constructor parameter names, which
 * file an identifier came from — import declarations answer well enough, and what
 * they cannot answer goes to `unresolved` rather than being guessed.
 *
 * This file holds the dispatch (which package.json is which kind of app) and the
 * shared machinery the framework readers use: parsing, import resolution through
 * relative paths, barrels, workspace packages and tsconfig path aliases, and
 * evaluation of the string constants route decorators are written with.
 */

/**
 * The most files a lift loads. A monorepo's source is hundreds of files; the cap is a
 * guard against a vendored tree or a generated client, not a budget the common case
 * meets. Hitting it is reported (selectLiftPathsReport), never silent.
 */
export const LIFT_PATH_CAP = 2500;

const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.turbo',
  '.next',
  '.terraform',
  'e2e',
  '__tests__',
  '__mocks__',
  'test',
  'tests',
]);

const isTestOrDeclaration = (path: string): boolean =>
  /\.d\.ts$/.test(path) || /\.(spec|test|e2e-spec)\.tsx?$/.test(path);

/** Root files that say which package manager runs the workspace (never lockfiles: too big). */
const WORKSPACE_FILES = new Set(['pnpm-workspace.yaml', '.yarnrc.yml', 'bunfig.toml']);

const isCode = (path: string): boolean => /\.tsx?$/.test(path) && !isTestOrDeclaration(path);

/**
 * Which files a lift needs, in priority order so a cap drops the least useful first:
 * manifests (package.json, tsconfig*.json, the workspace file that names the package
 * manager — the reader's map of the repo), then code under a package's src/
 * directory plus its vite.config, then Terraform (*.tf: where a cloud scheduler's
 * jobs and the routes they call are declared — small, and the only place external
 * schedules are written down), then prose (README.md, docs/**.md) for the model
 * pass. Tests, declarations, build output and vendored code are never read: they
 * describe the code, they are not it.
 */
export function selectLiftPathsReport(paths: readonly string[]): {
  paths: string[];
  /** Matching files left out because the cap was reached; 0 normally. */
  dropped: number;
} {
  const manifests: string[] = [];
  const code: string[] = [];
  const infra: string[] = [];
  const prose: string[] = [];
  for (const path of paths) {
    const segments = path.split('/');
    if (segments.slice(0, -1).some((s) => EXCLUDED_SEGMENTS.has(s))) continue;
    const base = segments[segments.length - 1]!;
    if (base === 'package.json' || /^tsconfig(\.[\w-]+)?\.json$/.test(base)) manifests.push(path);
    else if (segments.length === 1 && WORKSPACE_FILES.has(base)) manifests.push(path);
    else if (/^vite\.config\.(ts|mts|js|mjs)$/.test(base)) code.push(path);
    else if (isCode(path) && segments.slice(0, -1).includes('src')) code.push(path);
    else if (base.endsWith('.tf')) infra.push(path);
    else if (base === 'README.md' || (segments[0] === 'docs' && base.endsWith('.md'))) prose.push(path);
  }
  const ordered = [...manifests.sort(byString), ...code.sort(byString), ...infra.sort(byString), ...prose.sort(byString)];
  return { paths: ordered.slice(0, LIFT_PATH_CAP), dropped: Math.max(0, ordered.length - LIFT_PATH_CAP) };
}

export function selectLiftPaths(paths: readonly string[]): string[] {
  return selectLiftPathsReport(paths).paths;
}

/**
 * Read a repository. Apps are found by their package.json — @nestjs/core makes a
 * server, vite with a script that runs it makes a client — and each is handed to its
 * framework reader. A repo with neither is not an error: it reads to an empty
 * skeleton whose unresolved list says why, so the caller can show the author a
 * reason instead of a blank graph.
 */
export function readRepo(files: FileMap): Skeleton {
  const ctx = new RepoContext(files);
  const skeleton = emptySkeleton();
  for (const { path, reason } of ctx.manifestProblems) skeleton.unresolved.push({ file: path, reason });

  const servers = ctx.packages.filter((p) => hasDependency(p.json, '@nestjs/core'));
  const clients = ctx.packages.filter((p) => hasDependency(p.json, 'vite') && viteScript(p.json) !== null);

  const reads = servers.map((pkg) => readNestServer(ctx, pkg));
  const manager = packageManager(ctx);
  const readClients = clients.map((pkg) => ({ ...readViteClient(ctx, pkg, viteScript(pkg.json)!), ...(manager !== 'npm' ? { packageManager: manager } : {}) }));
  dedupeIds(reads, readClients);
  for (const read of reads) {
    skeleton.servers.push(...read.servers);
    skeleton.services.push(...read.services);
    skeleton.agents.push(...read.agents);
    skeleton.processes.push(...read.processes);
    skeleton.unresolved.push(...read.unresolved);
  }
  skeleton.clients.push(...readClients);
  if (servers.length) skeleton.frameworks.push('nestjs');
  if (clients.length) skeleton.frameworks.push('vite');

  linkClients(ctx, skeleton, servers, clients);
  readSchedulerJobs(files, skeleton);

  if (!servers.length && !clients.length) {
    skeleton.unresolved.push({
      file: ctx.packages.length ? ctx.packages[0]!.manifest : '.',
      reason: ctx.packages.length
        ? `no supported framework found: none of the ${ctx.packages.length} package.json files depends on @nestjs/core (a NestJS server) or on vite with a script that runs it (a Vite client)`
        : 'no package.json found, so there is no JavaScript app to read: lift reads NestJS servers and Vite clients',
    });
  }
  return skeleton;
}

/**
 * Which servers each client calls. With one server package, every client calls it —
 * a two-app monorepo is the case this is built for and there is nothing to decide.
 * With several, a client calls the servers it shares a workspace package with (the
 * shared routes/types package both sides import), and only when that narrows it;
 * anything else is reported rather than drawn.
 *
 * A package read as several deployments (an app and its internal worker) is called
 * only at the deployments that are not internal: a browser cannot reach a service
 * whose ingress is internal-only, and drawing it would say it can.
 */
function linkClients(ctx: RepoContext, skeleton: Skeleton, servers: Pkg[], clients: Pkg[]): void {
  const reachableAt = (dir: string): string[] =>
    skeleton.servers.filter((s) => s.path === dir && !s.internal).map((s) => s.id);
  for (const client of skeleton.clients) {
    if (servers.length === 1) {
      client.calls = reachableAt(servers[0]!.dir);
      continue;
    }
    if (!servers.length) continue;
    const pkg = clients.find((c) => c.dir === client.path)!;
    const shared = new Set(ctx.workspaceDependencies(pkg));
    const calls = servers
      .filter((s) => ctx.workspaceDependencies(s).some((d) => shared.has(d)))
      .flatMap((s) => reachableAt(s.dir));
    if (calls.length && calls.length < servers.length) client.calls = calls.sort(byString);
    else
      skeleton.unresolved.push({
        file: pkg.manifest,
        reason: `client "${client.id}": cannot tell which of the ${servers.length} servers it calls`,
      });
  }
}

/**
 * Ids are unique across the whole skeleton, because the mapper puts several kinds
 * into one composition. The precedence is fixed — servers, clients, services keep
 * their names; an agent or process that collides takes a kind suffix ("briefing" the
 * module and "briefing" the agent become briefing and briefing-agent) — so the result
 * depends on what the code is called, never on the order it was read in. A server's
 * references to its own entities are renamed with them, within that server only.
 */
function dedupeIds(reads: NestRead[], clients: SkeletonClient[]): void {
  const taken = new Set<string>();
  const claim = (id: string, suffix: string): string => {
    let next = id;
    if (taken.has(next)) next = civilId(`${id}-${suffix}`);
    for (let n = 2; taken.has(next); n++) next = civilId(`${id}-${suffix}-${n}`);
    taken.add(next);
    return next;
  };
  for (const r of reads) {
    const servers = new Map<string, string>();
    for (const server of r.servers) {
      const next = claim(server.id, 'server');
      servers.set(server.id, next);
      server.id = next;
    }
    for (const svc of r.services) svc.server = servers.get(svc.server) ?? svc.server;
  }
  for (const c of clients) c.id = claim(c.id, 'client');
  for (const r of reads) {
    const services = new Map<string, string>();
    for (const svc of r.services) {
      const next = claim(svc.id, svc.server);
      services.set(svc.id, next);
      svc.id = next;
    }
    const agents = new Map<string, string>();
    for (const a of r.agents) {
      const next = claim(a.id, 'agent');
      agents.set(a.id, next);
      a.id = next;
    }
    const svc = (id: string) => services.get(id) ?? id;
    const agent = (id: string) => agents.get(id) ?? id;
    for (const s of r.services) {
      s.dependsOn = s.dependsOn.map(svc).sort(byString);
      s.agents = s.agents.map(agent).sort(byString);
      if (s.dispatchesTo) s.dispatchesTo = s.dispatchesTo.map(svc).sort(byString);
      if (s.agentsVia)
        s.agentsVia = Object.fromEntries(Object.entries(s.agentsVia).map(([a, callers]) => [agent(a), callers.map(agent)]));
    }
    for (const server of r.servers) server.exposes = server.exposes.map(svc).sort(byString);
    for (const p of r.processes) {
      p.calls = p.calls.map(svc);
      p.id = claim(p.id, 'job');
    }
  }
}

// ---------------------------------------------------------------------------------
// Shared machinery for the framework readers.
// ---------------------------------------------------------------------------------

export const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A Civil id from a code name: "TasksModule" → "tasks-module", "agents/briefing" →
 * "agents-briefing". Lowercase letters, digits, hyphens; starts with a letter; at
 * most 64 characters (the schema's ID_PATTERN).
 */
export function civilId(name: string): string {
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const lettered = /^[a-z]/.test(kebab) ? kebab : `x-${kebab}`;
  return lettered.slice(0, 64).replace(/-+$/, '') || 'x';
}

export interface Pkg {
  /** Repo-relative directory, '' for the root. */
  dir: string;
  manifest: string;
  name: string | null;
  json: PackageJson;
}

interface PackageJson {
  name?: unknown;
  packageManager?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

const dependencyNames = (json: PackageJson): string[] => [
  ...Object.keys(json.dependencies ?? {}),
  ...Object.keys(json.devDependencies ?? {}),
  ...Object.keys(json.peerDependencies ?? {}),
];

export const hasDependency = (json: PackageJson, name: string): boolean => dependencyNames(json).includes(name);

/**
 * The script that runs Vite in development, as written: "dev" when it invokes vite,
 * else the first script (by name) whose command starts vite's dev server. Build and
 * preview scripts do not count — a package that only builds with vite is a library.
 * Returned with its name, which is how the client node will say to run it.
 */
function viteScript(json: PackageJson): { name: string; command: string } | null {
  const scripts = Object.entries(json.scripts ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string');
  const runsDev = (cmd: string) => /(^|[\s;&|])vite(\s+(dev|serve)\b|\s+--|\s*$|\s*[;&|])/.test(cmd) && !/vite\s+(build|preview)/.test(cmd);
  const dev = scripts.find(([name, cmd]) => name === 'dev' && runsDev(cmd));
  if (dev) return { name: dev[0], command: dev[1] };
  const other = scripts.sort((a, b) => byString(a[0], b[0])).find(([, cmd]) => runsDev(cmd));
  return other ? { name: other[0], command: other[1] } : null;
}

/**
 * The package manager the repository is run with: the root package.json's
 * `packageManager` field ("pnpm@9.1.0") when set, else the workspace file only that
 * manager reads. npm otherwise — it is what a bare package.json implies.
 */
function packageManager(ctx: RepoContext): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const root = ctx.packages.find((p) => p.dir === '');
  const declared = typeof root?.json.packageManager === 'string' ? root.json.packageManager.split('@')[0] : undefined;
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') return declared;
  if (ctx.files['pnpm-workspace.yaml'] !== undefined) return 'pnpm';
  if (ctx.files['.yarnrc.yml'] !== undefined) return 'yarn';
  if (ctx.files['bunfig.toml'] !== undefined) return 'bun';
  return 'npm';
}

/** A top-level declaration a name resolved to. */
export interface Decl {
  file: string;
  name: string;
  node: ts.Node;
  kind: 'class' | 'function' | 'variable' | 'enum' | 'other';
}

/** Where an import specifier points. */
export type Resolution =
  | { kind: 'file'; path: string }
  | { kind: 'external'; pkg: string }
  | { kind: 'missing'; specifier: string };

export interface ImportBinding {
  specifier: string;
  /** 'default', '*' (namespace), or the exported name. */
  imported: string;
  typeOnly: boolean;
  target: Resolution;
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'];

/**
 * Everything a framework reader asks of the repo, memoised per lift: parsed files,
 * each file's imports and top-level declarations, and name resolution across files.
 * Holds no state but caches of pure functions over the file map.
 */
export class RepoContext {
  readonly packages: Pkg[] = [];
  readonly manifestProblems: { path: string; reason: string }[] = [];
  private readonly packageByName = new Map<string, Pkg>();
  private readonly parsed = new Map<string, ts.SourceFile | null>();
  private readonly importsCache = new Map<string, Map<string, ImportBinding>>();
  private readonly declsCache = new Map<string, Map<string, Decl>>();
  private readonly aliasCache = new Map<string, { base: string; paths: [string, string[]][] } | null>();

  constructor(readonly files: FileMap) {
    for (const path of Object.keys(files).sort(byString)) {
      if (!(path === 'package.json' || path.endsWith('/package.json'))) continue;
      if (path.split('/').includes('node_modules')) continue;
      let json: PackageJson;
      try {
        json = JSON.parse(files[path]!) as PackageJson;
      } catch {
        this.manifestProblems.push({ path, reason: 'package.json does not parse as JSON; skipped' });
        continue;
      }
      if (!json || typeof json !== 'object') continue;
      const pkg: Pkg = {
        dir: posix.dirname(path) === '.' ? '' : posix.dirname(path),
        manifest: path,
        name: typeof json.name === 'string' ? json.name : null,
        json,
      };
      this.packages.push(pkg);
      if (pkg.name) this.packageByName.set(pkg.name, pkg);
    }
  }

  /** Code files under a package directory, excluding nested packages' files. */
  codeFilesOf(pkg: Pkg): string[] {
    const nested = this.packages.filter((p) => p !== pkg && isUnder(p.dir, pkg.dir)).map((p) => p.dir);
    return Object.keys(this.files)
      .filter((f) => isUnder(f, pkg.dir) && isCode(f) && !nested.some((d) => isUnder(f, d)))
      .sort(byString);
  }

  /** Workspace packages (by name) this package depends on. */
  workspaceDependencies(pkg: Pkg): string[] {
    return dependencyNames(pkg.json).filter((d) => this.packageByName.has(d));
  }

  /** The package whose directory most closely contains a path. */
  packageOf(path: string): Pkg | undefined {
    let best: Pkg | undefined;
    for (const p of this.packages) if (isUnder(path, p.dir) && (!best || p.dir.length > best.dir.length)) best = p;
    return best;
  }

  sourceFile(path: string): ts.SourceFile | null {
    if (this.parsed.has(path)) return this.parsed.get(path)!;
    const text = this.files[path];
    const sf =
      text === undefined
        ? null
        : ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    this.parsed.set(path, sf);
    return sf;
  }

  line(file: string, node: ts.Node): number {
    const sf = this.sourceFile(file)!;
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  }

  /**
   * Resolve an import specifier the way the repo's build would, as far as text
   * allows: relative paths (with the .js-for-.ts convention of NodeNext), directory
   * barrels, workspace packages by name (to their source, since dist is not read),
   * and tsconfig `paths` aliases. Anything else is an external dependency.
   */
  resolve(from: string, specifier: string): Resolution {
    if (specifier.startsWith('.')) {
      const hit = this.probe(posix.join(posix.dirname(from), specifier));
      return hit ? { kind: 'file', path: hit } : { kind: 'missing', specifier };
    }
    const aliased = this.resolveAlias(from, specifier);
    if (aliased) return aliased;
    const [first, second] = specifier.split('/');
    const pkgName = specifier.startsWith('@') ? `${first}/${second}` : first!;
    const pkg = this.packageByName.get(pkgName);
    if (pkg) {
      const sub = specifier.slice(pkgName.length).replace(/^\//, '');
      const roots = [posix.join(pkg.dir, 'src'), pkg.dir];
      for (const root of roots) {
        const hit = this.probe(sub ? posix.join(root, sub) : posix.join(root, 'index'));
        if (hit) return { kind: 'file', path: hit };
      }
      return { kind: 'missing', specifier };
    }
    return { kind: 'external', pkg: pkgName };
  }

  private probe(base: string): string | null {
    const stem = base.replace(/\.(m?js|jsx)$/, '');
    const candidates = [base, ...CODE_EXTENSIONS.map((e) => stem + e), ...CODE_EXTENSIONS.map((e) => `${stem}/index${e}`)];
    for (const c of candidates) if (this.files[c] !== undefined && /\.(m?[tj]sx?)$/.test(c)) return c;
    return null;
  }

  /** tsconfig `paths` for the package a file lives in, following one `extends` chain. */
  private resolveAlias(from: string, specifier: string): Resolution | null {
    const pkg = this.packageOf(from);
    if (!pkg) return null;
    const config = this.aliasesFor(pkg.dir);
    if (!config) return null;
    for (const [pattern, targets] of config.paths) {
      const star = pattern.indexOf('*');
      let captured: string | null = null;
      if (star < 0) captured = pattern === specifier ? '' : null;
      else {
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (specifier.startsWith(pre) && specifier.endsWith(post) && specifier.length >= pre.length + post.length)
          captured = specifier.slice(pre.length, specifier.length - post.length);
      }
      if (captured === null) continue;
      for (const t of targets) {
        const hit = this.probe(posix.join(config.base, t.replace('*', captured)));
        if (hit) return { kind: 'file', path: hit };
      }
      return { kind: 'missing', specifier };
    }
    return null;
  }

  private aliasesFor(dir: string): { base: string; paths: [string, string[]][] } | null {
    if (this.aliasCache.has(dir)) return this.aliasCache.get(dir)!;
    let result: { base: string; paths: [string, string[]][] } | null = null;
    let configPath: string | null = posix.join(dir, 'tsconfig.json');
    for (let hops = 0; configPath && hops < 5 && !result; hops++) {
      const text = this.files[configPath];
      if (text === undefined) break;
      const parsed = ts.parseConfigFileTextToJson(configPath, text).config as
        | { extends?: unknown; compilerOptions?: { baseUrl?: unknown; paths?: unknown } }
        | undefined;
      const opts = parsed?.compilerOptions;
      if (opts?.paths && typeof opts.paths === 'object') {
        const base = posix.join(posix.dirname(configPath), typeof opts.baseUrl === 'string' ? opts.baseUrl : '.');
        const paths = Object.entries(opts.paths as Record<string, unknown>)
          .filter((e): e is [string, string[]] => Array.isArray(e[1]))
          // Longest prefix first, as TypeScript matches.
          .sort((a, b) => b[0].length - a[0].length);
        result = { base, paths };
      }
      const ext = parsed?.extends;
      configPath =
        typeof ext === 'string' && ext.startsWith('.')
          ? posix.join(posix.dirname(configPath), ext.endsWith('.json') ? ext : `${ext}.json`)
          : null;
    }
    this.aliasCache.set(dir, result);
    return result;
  }

  /** A file's import bindings, local name → where it comes from. */
  imports(file: string): Map<string, ImportBinding> {
    const cached = this.importsCache.get(file);
    if (cached) return cached;
    const map = new Map<string, ImportBinding>();
    const sf = this.sourceFile(file);
    for (const stmt of sf?.statements ?? []) {
      if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !stmt.importClause) continue;
      const specifier = stmt.moduleSpecifier.text;
      const target = this.resolve(file, specifier);
      const clause = stmt.importClause;
      const typeOnly = clause.isTypeOnly;
      if (clause.name) map.set(clause.name.text, { specifier, imported: 'default', typeOnly, target });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) map.set(named.name.text, { specifier, imported: '*', typeOnly, target });
      if (named && ts.isNamedImports(named))
        for (const el of named.elements)
          map.set(el.name.text, {
            specifier,
            imported: (el.propertyName ?? el.name).text,
            typeOnly: typeOnly || el.isTypeOnly,
            target,
          });
    }
    this.importsCache.set(file, map);
    return map;
  }

  /** A file's top-level declarations by local name ('default' for a default export). */
  declarations(file: string): Map<string, Decl> {
    const cached = this.declsCache.get(file);
    if (cached) return cached;
    const map = new Map<string, Decl>();
    const sf = this.sourceFile(file);
    for (const stmt of sf?.statements ?? []) {
      const isDefault = hasModifier(stmt, ts.SyntaxKind.DefaultKeyword);
      const add = (name: string, node: ts.Node, kind: Decl['kind']) => {
        map.set(name, { file, name, node, kind });
        if (isDefault) map.set('default', { file, name, node, kind });
      };
      if (ts.isClassDeclaration(stmt)) add(stmt.name?.text ?? 'default', stmt, 'class');
      else if (ts.isFunctionDeclaration(stmt)) add(stmt.name?.text ?? 'default', stmt, 'function');
      else if (ts.isEnumDeclaration(stmt)) add(stmt.name.text, stmt, 'enum');
      else if (ts.isVariableStatement(stmt))
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) add(d.name.text, d, 'variable');
        }
      else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) map.set('default', { file, name: 'default', node: stmt.expression, kind: 'other' });
    }
    this.declsCache.set(file, map);
    return map;
  }

  /**
   * What a name used in `file` refers to: a local declaration, or — through the
   * file's imports and any barrels' re-exports — a declaration elsewhere in the repo.
   * External packages resolve to { external }, so a caller can tell "from
   * @nestjs/common" (fine, ignore) from "nowhere" (report it).
   */
  resolveName(file: string, name: string): Decl | { external: string } | null {
    const local = this.declarations(file).get(name);
    if (local && name !== 'default') return local;
    const binding = this.imports(file).get(name);
    if (!binding) return null;
    if (binding.target.kind === 'external') return { external: binding.target.pkg };
    if (binding.target.kind === 'missing' || binding.imported === '*') return null;
    return this.resolveExport(binding.target.path, binding.imported, new Set());
  }

  /** An exported name of a file, following `export … from` and `export *` chains. */
  resolveExport(file: string, name: string, seen: Set<string>): Decl | { external: string } | null {
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const sf = this.sourceFile(file);
    if (!sf) return null;
    const stars: string[] = [];
    for (const stmt of sf.statements) {
      if (!ts.isExportDeclaration(stmt)) continue;
      const spec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
      if (!stmt.exportClause) {
        if (spec) stars.push(spec);
        continue;
      }
      if (!ts.isNamedExports(stmt.exportClause)) continue;
      for (const el of stmt.exportClause.elements) {
        if (el.name.text !== name) continue;
        const original = (el.propertyName ?? el.name).text;
        if (!spec) return this.resolveName(file, original);
        const target = this.resolve(file, spec);
        if (target.kind === 'external') return { external: target.pkg };
        if (target.kind === 'missing') return null;
        return this.resolveExport(target.path, original, seen);
      }
    }
    const local = this.declarations(file).get(name);
    if (local) return local;
    // `import { X } from './x'; export { X }` is covered above; a bare local import
    // re-exported implicitly is not a thing, so only `export *` remains.
    for (const spec of stars) {
      const target = this.resolve(file, spec);
      if (target.kind !== 'file') continue;
      const hit = this.resolveExport(target.path, name, seen);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * The string value of an expression, when the source fixes it: literals, templates
   * over constants, `+` concatenation, constants imported from anywhere in the repo,
   * properties of `as const` objects, and string enum members. Undefined when it
   * depends on anything at runtime.
   */
  evalString(file: string, expr: ts.Expression, depth = 0): string | undefined {
    if (depth > 12) return undefined;
    const e = unwrap(expr);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isNumericLiteral(e)) return e.text;
    if (ts.isTemplateExpression(e)) {
      let out = e.head.text;
      for (const span of e.templateSpans) {
        const v = this.evalString(file, span.expression, depth + 1);
        if (v === undefined) return undefined;
        out += v + span.literal.text;
      }
      return out;
    }
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = this.evalString(file, e.left, depth + 1);
      const r = this.evalString(file, e.right, depth + 1);
      return l === undefined || r === undefined ? undefined : l + r;
    }
    if (ts.isIdentifier(e)) {
      const decl = this.resolveName(file, e.text);
      if (!decl || 'external' in decl) return undefined;
      if (ts.isVariableDeclaration(decl.node) && decl.node.initializer)
        return this.evalString(decl.file, decl.node.initializer, depth + 1);
      return undefined;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const member = this.evalMember(file, e.expression, e.name.text, depth);
      return member;
    }
    return undefined;
  }

  private evalMember(file: string, target: ts.Expression, prop: string, depth: number): string | undefined {
    const t = unwrap(target);
    if (!ts.isIdentifier(t)) return undefined;
    const decl = this.resolveName(file, t.text);
    if (!decl || 'external' in decl) return undefined;
    if (ts.isEnumDeclaration(decl.node)) {
      const m = decl.node.members.find((mem) => mem.name.getText() === prop);
      return m?.initializer ? this.evalString(decl.file, m.initializer, depth + 1) : undefined;
    }
    if (ts.isVariableDeclaration(decl.node) && decl.node.initializer) {
      const obj = unwrap(decl.node.initializer);
      if (!ts.isObjectLiteralExpression(obj)) return undefined;
      for (const p of obj.properties)
        if (ts.isPropertyAssignment(p) && propName(p.name) === prop) return this.evalString(decl.file, p.initializer, depth + 1);
    }
    return undefined;
  }
}

// --- small AST helpers, shared with nest.ts / vite.ts ---

export const isUnder = (path: string, dir: string): boolean => dir === '' || path === dir || path.startsWith(`${dir}/`);

/** Strip the wrappers that do not change a value: parens, `as`, `satisfies`, `!`. */
export function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e))
      e = e.expression;
    else return e;
  }
}

export function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).some((m) => m.kind === kind) : false;
}

/** A decorator's callee name and arguments: @Get('x') → { name: 'Get', args: ['x'] }. */
export function decoratorsOf(node: ts.Node): { name: string; args: readonly ts.Expression[]; node: ts.Decorator }[] {
  if (!ts.canHaveDecorators(node)) return [];
  return (ts.getDecorators(node) ?? []).flatMap((d): { name: string; args: readonly ts.Expression[]; node: ts.Decorator }[] => {
    const e = d.expression;
    if (ts.isCallExpression(e)) {
      const callee = e.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      return name ? [{ name, args: e.arguments, node: d }] : [];
    }
    if (ts.isIdentifier(e)) return [{ name: e.text, args: [], node: d }];
    return [];
  });
}
