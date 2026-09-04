import type { FastifyInstance, FastifyReply } from 'fastify';
import type pg from 'pg';
import { parse } from 'yaml';
import { zComposition, type Composition } from '@civil/schema';
import type { Config } from '../config.js';
import { GitHubApp } from '../github/app.js';
import { CIVIL_DIR, compositionPathFor } from '../project/bundle.js';
import { SourceError, openProjectSource } from '../project/open.js';
import { OverlaySource } from '../project/overlay.js';
import { ContentTooLargeError, listPending } from '../project/pending.js';
import { getProject, type ProjectRow } from '../project/repository.js';
import { deriveProcesses, gatherSessionFiles } from '../project/session.js';
import type { ProjectSource } from '../project/source.js';
import type { TranspileOutput } from '../project/transpile.js';
import { sendRunnerError, transpileProject, type TranspileFlow } from './transpile-routes.js';

/**
 * docs/app-session.md: pressing Run runs the application. This side owns what can be
 * decided from the documents — transpiling the pending state, gathering the file
 * set, deriving process specs — and hands all of it to the session service, the
 * substrate adapter that owns materialisation and supervision. One session per
 * project, keyed by the project id, because the session IS the project running.
 */

interface SessionDeps {
  config: Config;
  pool: pg.Pool;
}

/** A session-service answer the client should see as-is, status included. */
class SessionError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body['error'] === 'string' ? body['error'] : `session service ${status}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * POST /sessions runs npm install before it answers, so a legitimate start can
 * take minutes — fetch's default patience would mislabel it session_unreachable.
 * undici's Agent could raise the headers timeout directly, but undici is not a
 * dependency here; a 30-minute signal is the headroom available without one.
 * GET and DELETE keep the defaults: a status read that slow IS unreachable.
 */
const SESSION_START_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The local adapter binds loopback and the deployed adapter's auth is an open item
 * (docs/app-session.md), so unlike runner dispatch there is no token to mint here.
 */
async function callSession(
  sessionUrl: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  payload?: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${sessionUrl}${path}`, {
      method,
      ...(method === 'POST' ? { signal: AbortSignal.timeout(SESSION_START_TIMEOUT_MS) } : {}),
      ...(payload === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    });
  } catch (error) {
    throw new SessionError(502, {
      error: 'session_unreachable',
      message: `The session service could not be reached: ${(error as Error).message}`,
    });
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  // The service's own statuses pass through whole — its 404 for "no session" is
  // exactly the answer the client should see.
  if (!response.ok) throw new SessionError(response.status, body);
  return body;
}

const sendSessionError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof SessionError) return reply.code(error.status).send(error.body);
  throw error;
};

/**
 * The two-tier editing rule's write-through (docs/app-session.md): a file save
 * also lands on the live session's real filesystem, so the running app's watcher
 * fires HMR. Best-effort by construction — pending is the durability, the session
 * is a cache — so "no session" (404), "no service", and "unreachable" are all
 * silence, never a failed save.
 */
export async function writeThroughToSession(
  sessionUrl: string | undefined,
  projectId: string,
  path: string,
  content: string,
): Promise<void> {
  if (!sessionUrl) return;
  try {
    await callSession(sessionUrl, 'PATCH', `/sessions/${projectId}/files`, {
      files: { [path]: content },
    });
  } catch {
    /* the session catches up at the next Run's rematerialisation */
  }
}

/**
 * The composition the boundary derivation reads, resolved through the overlay so a
 * pending edit to civil.yaml or the composition is what Run sees. A broken document
 * derives no processes; the validator owns reporting it.
 */
async function readComposition(overlay: OverlaySource): Promise<Composition | undefined> {
  await overlay.ensure?.([`${CIVIL_DIR}/civil.yaml`, 'civil.yaml']);
  const path = compositionPathFor(overlay);
  await overlay.ensure?.([path]);
  const raw = overlay.read(path);
  if (raw === undefined) return undefined;
  try {
    const parsed = zComposition.safeParse(parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session live-sync (docs/app-session.md): after a transpile, push the emitted
 * files, the retired deletions, and a restart of the boundary processes to the
 * running session. Boundaries restart because a graph edit changes orchestration
 * the Python server imported at start; clients never do — vite's HMR delivers a file
 * write. Best-effort like writeThroughToSession — "no session" (404), "no service",
 * and "unreachable" are all silence, never a failed transpile.
 */
export async function syncTranspileToSession(
  sessionUrl: string,
  projectId: string,
  boundaryNames: string[],
  output: TranspileOutput,
  retired: string[],
): Promise<void> {
  try {
    await callSession(sessionUrl, 'PATCH', `/sessions/${projectId}/files`, {
      files: output.files,
      deletions: retired,
      restart: boundaryNames,
    });
  } catch {
    /* the session catches up at the next Run's rematerialisation */
  }
}

/**
 * Transpile the project, then sync the result to a live session. One seam behind
 * both the explicit Transpile and the auto re-transpile a structural op triggers,
 * so Run never disagrees with the diff panel about what the app is. Transpilation
 * always runs; the sync is best-effort and only when a session service is
 * configured, so a project with no session transpiles exactly as before. Throws
 * whatever transpileProject throws (RunnerError, ContentTooLargeError); the sync
 * itself never throws.
 */
/**
 * The file set a fresh session materialises: HEAD-plus-pending, the emitted app
 * merged on top, and the flow's retirements removed — the cold-start twin of the
 * deletions the hot PATCH path sends, so a rematerialise never resurrects a stale
 * emission (retired can never name a current output; the flow guarantees it).
 */
export function assembleSessionFiles(
  base: Record<string, string>,
  flow: TranspileFlow,
): Record<string, string> {
  const files = { ...base, ...flow.output.files };
  for (const path of flow.retired) delete files[path];
  return files;
}

export async function transpileAndSync(
  deps: SessionDeps,
  ownerId: string,
  project: ProjectRow,
  source: ProjectSource,
  overlay: OverlaySource,
): Promise<TranspileFlow> {
  const flow = await transpileProject(deps, ownerId, project, source, overlay);
  if (deps.config.sessionUrl) {
    const composition = await readComposition(overlay);
    // Boundary names depend on roles and the composition, not the file bodies, so
    // the emitted files stand in for the full set the session derivation uses.
    const { boundaries } = deriveProcesses(
      project.id, composition, flow.output.files, flow.output.roles,
    );
    await syncTranspileToSession(
      deps.config.sessionUrl,
      project.id,
      boundaries.map((b) => b.name),
      flow.output,
      flow.retired,
    );
  }
  return flow;
}

/**
 * Whether a session is up right now — a cheap GET the ops auto-trigger uses to
 * decide against spending model latency on a re-transpile no running app will hear.
 * Any failure (404 no-session, unreachable) reads as "not live".
 */
export async function sessionIsLive(sessionUrl: string, projectId: string): Promise<boolean> {
  try {
    await callSession(sessionUrl, 'GET', `/sessions/${projectId}`);
    return true;
  } catch {
    return false;
  }
}

const previewUrl = (port: number): string => `http://127.0.0.1:${port}`;

export function registerSessionRoutes(app: FastifyInstance, deps: SessionDeps): void {
  const { config, pool } = deps;

  const githubApp = config.github
    ? new GitHubApp({ appId: config.github.appId, privateKey: config.github.privateKey })
    : undefined;

  /** The shared preamble: the project, its source, and the overlay every read uses. */
  const open = async (
    ownerId: string,
    project: ProjectRow,
  ): Promise<{ source: ProjectSource; overlay: OverlaySource }> => {
    const source = await openProjectSource({ pool, githubApp }, ownerId, project);
    const pending = await listPending(pool, ownerId, project.id, project.defaultBranch);
    return { source, overlay: new OverlaySource(source, pending) };
  };

  /** Both preconditions of every session route, resolved in one place. */
  const preflight = async (
    request: { params: unknown; identity: { id: string } },
    reply: FastifyReply,
  ): Promise<{ project: ProjectRow; sessionUrl: string } | undefined> => {
    const { id } = request.params as { id: string };
    const project = await getProject(pool, request.identity.id, id);
    if (!project) {
      void reply.code(404).send({ error: 'not_found' });
      return undefined;
    }
    if (!config.sessionUrl) {
      // No substrate here. Prod stays unset until a deployed adapter exists
      // (docs/app-session.md); honest beats silent, same as the runner.
      void reply.code(503).send({
        error: 'session_not_configured',
        message: 'No session service is configured (CIVIL_SESSION_URL).',
      });
      return undefined;
    }
    return { project, sessionUrl: config.sessionUrl };
  };

  app.post('/api/projects/:id/session', async (request, reply) => {
    const pre = await preflight(request, reply);
    if (!pre) return reply;
    const { project, sessionUrl } = pre;

    if (!config.runnerUrl) {
      // The session materialises the transpiled app, and transpilation is model
      // work that lives only in the runner (PRD 12).
      return reply.code(503).send({
        error: 'runner_not_configured',
        message: 'No runner is configured (CIVIL_RUNNER_URL).',
      });
    }

    let source: ProjectSource;
    let overlay: OverlaySource;
    try {
      ({ source, overlay } = await open(request.identity.id, project));
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }

    // The same flow the transpile route runs — staleness, memo, pending writes —
    // so Run never disagrees with the diff panel about what the app is.
    let flow: TranspileFlow;
    try {
      flow = await transpileProject(deps, request.identity.id, project, source, overlay);
    } catch (error) {
      if (error instanceof ContentTooLargeError) {
        return reply.code(413).send({ error: 'content_too_large', message: error.message });
      }
      // A runner failure surfaces with the status it arrived under, exactly as the
      // transpile route would have shown it.
      return sendRunnerError(reply, error);
    }

    // HEAD plus pending, with the emitted app merged on top and retirements
    // dropped — see assembleSessionFiles: a stale emission must not land beside
    // the fresh one on the workspace (the bug retirement exists to prevent).
    const files = assembleSessionFiles(await gatherSessionFiles(overlay), flow);

    const composition = await readComposition(overlay);
    const derived = deriveProcesses(project.id, composition, files, flow.output.roles);

    try {
      // Same sessionId again means stop old, start fresh — Run is idempotent.
      await callSession(sessionUrl, 'POST', '/sessions', {
        sessionId: project.id,
        files,
        processes: derived.processes,
      });
    } catch (error) {
      return sendSessionError(reply, error);
    }

    request.log.info(
      { projectId: project.id, files: Object.keys(files).length, processes: derived.processes.length },
      'session started',
    );
    return {
      sessionId: project.id,
      previews: derived.previews.map((p) => ({ name: p.name, url: previewUrl(p.port) })),
      boundaries: derived.boundaries.map((b) => ({ name: b.name, url: previewUrl(b.port) })),
    };
  });

  app.get('/api/projects/:id/session', async (request, reply) => {
    const pre = await preflight(request, reply);
    if (!pre) return reply;
    const { project, sessionUrl } = pre;

    let status: Record<string, unknown>;
    try {
      status = await callSession(sessionUrl, 'GET', `/sessions/${project.id}`);
    } catch (error) {
      return sendSessionError(reply, error);
    }

    // Which running processes are app surfaces is the composition's knowledge, not
    // the service's: client node ids name the previews, ported non-clients are the
    // boundary servers.
    let clientIds = new Set<string>();
    try {
      const { overlay } = await open(request.identity.id, project);
      const composition = await readComposition(overlay);
      clientIds = new Set(
        (composition?.spec.nodes ?? []).filter((n) => n.type === 'client').map((n) => n.id),
      );
    } catch (error) {
      if (!(error instanceof SourceError)) throw error;
      // An unreadable source degrades the labels, not the status answer.
    }

    const previews: { name: string; url: string }[] = [];
    const boundaries: { name: string; url: string }[] = [];
    const processes = Array.isArray(status['processes']) ? status['processes'] : [];
    for (const proc of processes as { name?: unknown; port?: unknown }[]) {
      if (typeof proc?.name !== 'string' || typeof proc?.port !== 'number') continue;
      const entry = { name: proc.name, url: previewUrl(proc.port) };
      (clientIds.has(proc.name) ? previews : boundaries).push(entry);
    }

    return { ...status, previews, boundaries };
  });

  app.get('/api/projects/:id/session/logs', async (request, reply) => {
    const pre = await preflight(request, reply);
    if (!pre) return reply;
    const { project, sessionUrl } = pre;

    const raw = (request.query as Record<string, unknown>)['after'];
    const after = Number(raw);
    const query = raw !== undefined && Number.isFinite(after) ? `?after=${after}` : '';
    try {
      return await callSession(sessionUrl, 'GET', `/sessions/${project.id}/logs${query}`);
    } catch (error) {
      return sendSessionError(reply, error);
    }
  });

  app.delete('/api/projects/:id/session', async (request, reply) => {
    const pre = await preflight(request, reply);
    if (!pre) return reply;
    const { project, sessionUrl } = pre;

    try {
      return await callSession(sessionUrl, 'DELETE', `/sessions/${project.id}`);
    } catch (error) {
      return sendSessionError(reply, error);
    }
  });
}
