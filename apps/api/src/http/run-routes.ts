import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { GitHubApp } from '../github/app.js';
import { SourceError, openProjectSource } from '../project/open.js';
import { OverlaySource } from '../project/overlay.js';
import { listPending } from '../project/pending.js';
import { getProject } from '../project/repository.js';
import type { ProjectSource } from '../project/source.js';
import {
  appendEvent,
  createRun,
  getRun,
  getRunByToken,
  listRuns,
  readEvents,
  requestCancel,
} from '../project/runs.js';

/**
 * PRD 8: one run model. Starting a run creates a job row, snapshots the project's
 * files, and hands the bundle to the runner — a separate service that holds no
 * platform credentials (PRD 12). Everything after that is reads: the runner writes
 * events with a per-run token, the browser reads them from an offset, and the two
 * never meet.
 */

interface RunDeps {
  config: Config;
  pool: pg.Pool;
}

/** A run bundle: everything the runner needs and nothing it must not have. */
interface RunBundle {
  runId: string;
  token: string;
  graphPath: string;
  input: unknown;
  toolValidation: 'strict' | 'lenient';
  files: Record<string, string>;
  /** Where events go home to. */
  eventsUrl: string;
}

export function registerRunRoutes(app: FastifyInstance, deps: RunDeps): void {
  const { config, pool } = deps;

  const githubApp = config.github
    ? new GitHubApp({ appId: config.github.appId, privateKey: config.github.privateKey })
    : undefined;

  app.post('/api/projects/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { graph?: unknown; input?: unknown };
    if (typeof body?.graph !== 'string') {
      return reply.code(400).send({ error: 'graph_required' });
    }

    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    let source: ProjectSource;
    try {
      source = await openProjectSource({ pool, githubApp }, request.identity.id, project);
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
    const pending = await listPending(pool, request.identity.id, project.id, project.defaultBranch);
    const overlay = new OverlaySource(source, pending);

    if (!overlay.exists(body.graph)) {
      return reply.code(404).send({ error: 'graph_not_found', message: `${body.graph} is not in this project.` });
    }

    const { run, runnerToken } = await createRun(pool, {
      ownerId: request.identity.id,
      projectId: project.id,
      branch: project.defaultBranch,
      graphPath: body.graph,
      commitSha: project.headSha,
      input: body.input ?? null,
      // PRD 11.3: strict in dev, lenient in prod — a property of the environment.
      toolValidation: config.env === 'production' ? 'lenient' : 'strict',
    });

    if (!config.runnerUrl) {
      // No runner deployed yet: the run exists, queued, and says why it is not
      // moving. Honest beats silent.
      await appendEvent(pool, run, {
        type: 'run.finished',
        payload: { status: 'failed', error: 'No runner is configured (CIVIL_RUNNER_URL).' },
      });
      return reply.code(202).send({ run: { ...run, status: 'failed' } });
    }

    // The snapshot: every file, at the pinned commit plus pending edits — the same
    // resolution every canvas read uses. ensure() hydrates what the prefetch
    // skipped; the runner gets bytes, never credentials.
    const paths = overlay.list();
    await overlay.ensure?.(paths);
    const files: Record<string, string> = {};
    for (const path of paths) {
      const content = overlay.read(path);
      if (content !== undefined) files[path] = content;
    }

    const bundle: RunBundle = {
      runId: run.id,
      token: runnerToken,
      graphPath: body.graph,
      input: body.input ?? null,
      toolValidation: run.toolValidation,
      files,
      eventsUrl: `${config.publicUrl ?? `http://127.0.0.1:${config.port}`}/runner/events`,
    };

    // Fire and account: dispatch failures become a finished-failed run with the
    // reason in the log, not a run stuck queued forever.
    void fetch(`${config.runnerUrl}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`runner answered ${response.status}`);
        }
      })
      .catch(async (error: unknown) => {
        await appendEvent(pool, run, {
          type: 'run.finished',
          payload: { status: 'failed', error: `Dispatch failed: ${(error as Error).message}` },
        }).catch(() => undefined);
      });

    return reply.code(202).send({ run });
  });

  app.get('/api/projects/:id/runs', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    return { runs: await listRuns(pool, request.identity.id, project.id) };
  });

  app.get('/api/projects/:id/runs/:runId', async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    const run = await getRun(pool, request.identity.id, id, runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    return { run };
  });

  /** PRD 8.2: offset-readable. `after` is the last seq the caller has. */
  app.get('/api/projects/:id/runs/:runId/events', async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    const after = Number((request.query as Record<string, unknown>)['after'] ?? -1);
    const run = await getRun(pool, request.identity.id, id, runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    const events = await readEvents(pool, request.identity.id, runId, Number.isFinite(after) ? after : -1);
    return { run: { status: run.status, eventSeq: run.eventSeq }, events };
  });

  app.post('/api/projects/:id/runs/:runId/cancel', async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    const cancelled = await requestCancel(pool, request.identity.id, id, runId);
    if (!cancelled) return reply.code(409).send({ error: 'not_cancellable' });
    return { ok: true };
  });

  /**
   * The runner's only door, outside the session guard. A per-run bearer token is
   * the entire identity: it appends to exactly one run, stops working the moment
   * the run finishes (the hash is cleared), and grants nothing else — which is
   * what makes handing it to a process that executes user code acceptable.
   *
   * The response carries whether cancellation was requested, so reporting events
   * doubles as the runner's poll — no second channel.
   */
  app.post('/runner/events', async (request, reply) => {
    const token = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return reply.code(401).send({ error: 'token_required' });

    const run = await getRunByToken(pool, token);
    if (!run) return reply.code(401).send({ error: 'unknown_run' });

    const body = request.body as {
      events?: { type?: unknown; nodeId?: unknown; graphPath?: unknown; payload?: unknown }[];
    };
    if (!Array.isArray(body?.events) || body.events.length === 0) {
      return reply.code(400).send({ error: 'events_required' });
    }

    for (const event of body.events) {
      if (typeof event?.type !== 'string') continue;
      await appendEvent(pool, run, {
        type: event.type,
        nodeId: typeof event.nodeId === 'string' ? event.nodeId : undefined,
        graphPath: typeof event.graphPath === 'string' ? event.graphPath : undefined,
        payload: event.payload,
      });
    }

    const fresh = await getRunByToken(pool, token);
    return { cancelled: fresh ? fresh.status === 'cancelled' : run.status === 'cancelled' };
  });
}
