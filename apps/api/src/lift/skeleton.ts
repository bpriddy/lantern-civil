/**
 * The skeleton: what a reader found in an existing codebase, before it becomes Civil
 * documents (docs/lift-repo.md). Readers (nest.ts, vite.ts) produce it from a file
 * map; the mapper (to-documents.ts) turns it into civil/ documents; the model pass
 * (refine.ts) may rename and classify within it, never invent.
 *
 * Every entity names the files that implement it, repo-relative, so the registry can
 * record the repo's code as the implementation (owner "repo") and nothing is claimed
 * that a file does not show. Ids are stable for the same code — derived from paths
 * and class names, never from order — so Update can match them across runs.
 */

/** Repo-relative path → file content. Readers never touch a filesystem. */
export type FileMap = Readonly<Record<string, string>>;

export interface SourceRef {
  file: string;
  /** 1-based; omitted when the entity is a whole file. */
  line?: number;
}

/** A frontend app (Vite today): becomes a `client` node. */
export interface SkeletonClient {
  /** kebab-case, from the package name or directory: "web". */
  id: string;
  /** The app's directory, repo-relative: "apps/web". */
  path: string;
  framework: 'vite';
  /** The package.json script that runs it in development, as written ("vite"). */
  devScript: string | null;
  /**
   * That script's name in package.json ("dev"), so the client node can say how to run
   * it (`npm run <name>`). Optional — added after the first contract; absent means
   * "dev" by convention, or no script when devScript is null.
   */
  devScriptName?: string;
  /**
   * The repository's package manager, from the root package.json's `packageManager`
   * field or the workspace file beside it, so the dev command is one the repo can
   * run (`pnpm run dev` resolves `workspace:*`; `npm run dev` does not). Optional —
   * added after the first contract; absent means npm.
   */
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** Server apps this client calls, by SkeletonServer.id, when the reader can tell. */
  calls: string[];
  source: SourceRef;
}

export interface SkeletonRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL' | 'OPTIONS' | 'HEAD';
  /** Full path as served: global prefix + controller prefix + method path, "/api/tasks/:id". */
  path: string;
  /** The controller class and method that handle it. */
  controller: string;
  handler: string;
  source: SourceRef;
}

/** A backend app (NestJS today): becomes an `api` boundary over its services. */
export interface SkeletonServer {
  /** kebab-case: "server". */
  id: string;
  path: string;
  framework: 'nestjs';
  /** setGlobalPrefix(...) in the bootstrap, when found. */
  globalPrefix: string | null;
  routes: SkeletonRoute[];
  /** SkeletonService ids that serve at least one route here. */
  exposes: string[];
  source: SourceRef;
  /**
   * The root module this server boots, when the bootstrap chooses between several
   * (`mode === 'worker' ? WorkerModule : AppModule`): each choice is its own
   * deployment of the same package, so each is its own server. Optional — added
   * after the first contract; absent for the ordinary one-root server.
   */
  rootModule?: string;
  /**
   * True when this deployment serves nothing under the global prefix while a sibling
   * root does: an internal service (a worker) that clients do not call. Optional,
   * absent meaning false.
   */
  internal?: boolean;
  /**
   * The package's code files that no module or agent owns — bootstrap, shared
   * helpers, connectors — so the registry can record them under `shared` and the
   * unowned remainder is an exception the author sees, not a silent gap. Optional.
   */
  sharedFiles?: string[];
}

/**
 * A unit of backend functionality: a NestJS feature module (its controllers and
 * providers together). Becomes a `service` node, or a graph-backed service when it
 * uses agents.
 */
export interface SkeletonService {
  /** kebab-case from the module: "tasks", "knowledge". */
  id: string;
  /** The server app it belongs to. */
  server: string;
  /** The @Module class and its file. */
  moduleClass: string;
  source: SourceRef;
  /** Controllers and providers declared by the module, with their files. */
  controllers: { name: string; file: string }[];
  providers: { name: string; file: string }[];
  /** Other services this one uses — module imports and injected providers. */
  dependsOn: string[];
  /** Agents its code uses (imports or injects), by SkeletonAgent.id. */
  agents: string[];
  /** True for cross-cutting modules (config, database, logging, auth guards...). */
  infrastructure: boolean;
  /**
   * Every file the service owns: its module directory when the module is the only one
   * there, otherwise the files of what it declares and the same-directory helpers
   * those import. Optional — added after the first contract; absent means the module,
   * controller and provider files above.
   */
  files?: string[];
  /** The directory the module owns, when it owns one (see `files`). Optional. */
  directory?: string;
  /** True when this is a module the bootstrap hands NestFactory.create. Optional. */
  root?: boolean;
  /**
   * Agents in `agents` its code reaches only through another agent's code: agent id →
   * the agents that call it, so a graph draws an analyzer handing work to a scorer
   * rather than the service calling both. Optional.
   */
  agentsVia?: Record<string, string[]>;
  /**
   * Services on another deployment whose internal routes this one's code names — a
   * task queue or an HTTP call aimed at a worker's /internal/... path. Optional.
   */
  dispatchesTo?: string[];
}

/** An LLM agent the code defines: becomes an `agent` node inside its service's graph. */
export interface SkeletonAgent {
  /** kebab-case from its directory or class: "briefing". */
  id: string;
  /** Files that define it — agent, prompt, output schema, tools. */
  files: string[];
  /** Tools it is given, as functions or modules, when the reader can tell. */
  tools: { name: string; file: string }[];
  source: SourceRef;
}

/**
 * Scheduled work: becomes a `process` node. In code (@Cron, @Interval), or in the
 * repository's infrastructure — a Cloud Scheduler job posting to one of the server's
 * routes — when `route` says which.
 */
export interface SkeletonProcess {
  id: string;
  /** A cron expression; intervals are expressed as the closest cron. */
  schedule: string;
  /** The service whose code runs, by id. */
  calls: string[];
  source: SourceRef;
  /** "POST /internal/nightly": the route an external scheduler calls. Optional. */
  route?: string;
}

export interface Skeleton {
  clients: SkeletonClient[];
  servers: SkeletonServer[];
  services: SkeletonService[];
  agents: SkeletonAgent[];
  processes: SkeletonProcess[];
  /** What the reader saw but could not resolve — reported, never guessed. */
  unresolved: { file: string; line?: number; reason: string }[];
  /** Frameworks detected, for the summary: ["nestjs", "vite"]. */
  frameworks: string[];
}

export const emptySkeleton = (): Skeleton => ({
  clients: [],
  servers: [],
  services: [],
  agents: [],
  processes: [],
  unresolved: [],
  frameworks: [],
});

/**
 * What the model pass (refine.ts) may contribute — validated against the skeleton
 * before use: every id it names must exist, every new id must be a valid, unique
 * Civil id. It renames and classifies; it never adds or removes an entity.
 */
export interface Refinement {
  /** Old id → clearer id, for any entity kind. */
  renames: Record<string, string>;
  /** Service ids that are cross-cutting plumbing rather than product functionality. */
  infrastructure: string[];
  /** Entity id (after renames) → one plain sentence on what it does. */
  descriptions: Record<string, string>;
  /** A few paragraphs on the system as a whole, for civil/architecture.md. */
  summary: string;
}
