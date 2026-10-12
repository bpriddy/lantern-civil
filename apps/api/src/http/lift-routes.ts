import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { GitHubApp } from '../github/app.js';
import { LiftRefusal, liftRepository, type LiftAsk, type LiftResult, type LiftStage } from '../lift/index.js';
import type { AreaMemo } from '../lift/analysts.js';
import type { Claim } from '../lift/claims.js';
import { ManifestEditError } from '../manifest/document.js';
import { SourceError, openProjectSource } from '../project/open.js';
import { OverlaySource } from '../project/overlay.js';
import {
  ContentTooLargeError,
  MAX_INLINE_BYTES,
  listPending,
  revertPending,
  savePending,
} from '../project/pending.js';
import { getProject } from '../project/repository.js';
import type { ProjectSource } from '../project/source.js';
import { callRunner } from './transpile-routes.js';

/**
 * "Generate graph from repo" / "Update graph from repo" (docs/lift-repo.md): reads
 * the project's own code and proposes Civil documents for it — civil.yaml, the
 * composition, a graph per service, the registry, an architecture note.
 *
 * Everything lands as pending changes, never a commit (CLAUDE.md: nothing applied
 * unpreviewably). The author reviews the proposal in the diff panel, discards what
 * they do not want, and commits the rest like any other edit. Running it again is
 * Update: the mapper merges with the documents already there, pending ones included,
 * so the author's ids, layout, and hand additions survive.
 */

interface LiftDeps {
  config: Config;
  pool: pg.Pool;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A lift's progress, written as it goes so the canvas can show a run that takes
 * minutes while the request running it is still open. Best-effort: a failed write
 * costs the progress line, never the lift.
 */
function progressWriter(pool: pg.Pool, ownerId: string, projectId: string, runId: string | undefined) {
  const write = async (state: 'running' | 'done' | 'failed', stage: string, detail: string, areas?: { done: number; total: number }) => {
    if (!runId) return;
    try {
      await pool.query(
        `INSERT INTO lift_runs (owner_id, project_id, run_id, state, stage, detail, areas_total, areas_done)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (project_id, run_id) DO UPDATE
           SET state = EXCLUDED.state, stage = EXCLUDED.stage, detail = EXCLUDED.detail,
               areas_total = COALESCE(EXCLUDED.areas_total, lift_runs.areas_total),
               areas_done = COALESCE(EXCLUDED.areas_done, lift_runs.areas_done),
               updated_at = now()
         WHERE lift_runs.owner_id = $1`,
        [ownerId, projectId, runId, state, stage, detail, areas?.total ?? null, areas?.done ?? null],
      );
    } catch {
      /* progress is a courtesy */
    }
  };
  return write;
}

/** The agent stage's memo, per project, in Postgres (migration 9). */
function areaMemo(pool: pg.Pool, ownerId: string, projectId: string): AreaMemo {
  return {
    async get(fingerprint) {
      const { rows } = await pool.query<{ claims: Claim[] }>(
        'SELECT claims FROM lift_area_memos WHERE owner_id = $1 AND project_id = $2 AND fingerprint = $3',
        [ownerId, projectId, fingerprint],
      );
      return rows[0]?.claims;
    },
    async put(fingerprint, areaId, claims) {
      await pool.query(
        `INSERT INTO lift_area_memos (owner_id, project_id, fingerprint, area_id, claims) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (project_id, fingerprint) DO UPDATE SET claims = EXCLUDED.claims, area_id = EXCLUDED.area_id, created_at = now()`,
        [ownerId, projectId, fingerprint, areaId, JSON.stringify(claims)],
      );
    },
    async latest(areaId) {
      const { rows } = await pool.query<{ claims: Claim[] }>(
        `SELECT claims FROM lift_area_memos WHERE owner_id = $1 AND project_id = $2 AND area_id = $3
          ORDER BY created_at DESC LIMIT 1`,
        [ownerId, projectId, areaId],
      );
      return rows[0]?.claims;
    },
  };
}

export function registerLiftRoutes(app: FastifyInstance, deps: LiftDeps): void {
  const { config, pool } = deps;

  /** A lift's progress, for the canvas to show while it runs. Owner-scoped. */
  app.get('/api/projects/:id/lift-runs/:runId', async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    if (!UUID.test(runId)) return reply.code(404).send({ error: 'not_found' });
    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });
    const { rows } = await pool.query(
      `SELECT run_id AS "runId", state, stage, detail, areas_total AS "areasTotal", areas_done AS "areasDone",
              updated_at AS "updatedAt"
         FROM lift_runs WHERE owner_id = $1 AND project_id = $2 AND run_id = $3`,
      [request.identity.id, project.id, runId],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'not_found' });
    return rows[0];
  });

  const githubApp = config.github
    ? new GitHubApp({ appId: config.github.appId, privateKey: config.github.privateKey })
    : undefined;

  app.post('/api/projects/:id/lift-repo', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ownerId = request.identity.id;
    // Owner-scoped like every route: someone else's project is not found, not refused.
    const project = await getProject(pool, ownerId, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    let base: ProjectSource;
    try {
      base = await openProjectSource({ pool, githubApp }, ownerId, project);
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
    // Read through pending work, the same as the canvas: an edit not yet committed is
    // part of the code being described, and an earlier, unreviewed lift is part of the
    // civil/ documents being merged with.
    const pending = await listPending(pool, ownerId, project.id, project.branch);
    const overlay = new OverlaySource(base, pending);

    // The model pass lives in the runner (PRD 12: models only there). No runner means
    // the deterministic result alone, which is complete and valid; the note says so.
    const runnerUrl = config.runnerUrl;
    const ask: LiftAsk | undefined = runnerUrl
      ? (body) => callRunner(runnerUrl, '/lift/refine', body)
      : undefined;
    // The agent stage (analysts and verifiers) runs wherever the runner does. Its memo
    // is keyed by the runner's analyze prompt version and model, so a change to either
    // asks again; a runner that cannot say which version it is gets nothing reused.
    const analyze: LiftAsk | undefined = runnerUrl
      ? (body) => callRunner(runnerUrl, '/lift/analyze', body)
      : undefined;
    let version: string | undefined;
    if (runnerUrl) {
      try {
        const meta = await callRunner(runnerUrl, '/transpile/meta');
        if (typeof meta['analyzeVersion'] === 'string' && typeof meta['model'] === 'string') {
          version = `${meta['analyzeVersion']}:${meta['model']}`;
        }
      } catch {
        /* no version: nothing is reused, everything is asked */
      }
    }
    const runId = typeof (request.body as { runId?: unknown } | null)?.runId === 'string'
      && UUID.test((request.body as { runId: string }).runId)
      ? (request.body as { runId: string }).runId
      : undefined;
    const progress = progressWriter(pool, ownerId, project.id, runId);
    await progress('running', 'listing', 'Starting.');

    let result: LiftResult;
    try {
      result = await liftRepository(overlay, {
        projectName: project.name,
        ask,
        analyze,
        analyzeOptions: { memo: areaMemo(pool, ownerId, project.id), ...(version ? { version } : {}) },
        progress: (stage: LiftStage, detail, areas) => void progress('running', stage, detail, areas),
      });
    } catch (error) {
      await progress('failed', 'done', (error as Error).message.slice(0, 300));
      // Refused before anything was proposed (a Python project, documents still at the
      // root), or the merge met a document it cannot edit: both are the author's to
      // know about in words, not a 500.
      if (error instanceof LiftRefusal) return reply.code(422).send({ error: error.code, message: error.message });
      if (error instanceof ManifestEditError) {
        return reply.code(422).send({
          error: 'merge_failed',
          message: `Could not merge into the existing documents: ${error.message}. Nothing was changed.`,
        });
      }
      throw error;
    }
    // GitHub lists at most so many entries in one tree; past that the listing is cut and
    // the repository reads as smaller than it is — said, never silent.
    if ((base as { truncated?: boolean }).truncated === true) {
      result.diagnostics.unshift(
        'warning: GitHub returned a truncated file listing for this repository; code past the cut is not in this graph.',
      );
    }

    // Nothing recognised is an answer, not an empty proposal: writing a bare civil.yaml
    // for a repo the reader cannot describe would only be noise in the diff.
    const { skeleton } = result;
    if (skeleton.clients.length === 0 && skeleton.servers.length === 0) {
      await progress('failed', 'done', 'Nothing was changed.');
      return reply.code(422).send({
        error: 'nothing_recognized',
        message:
          'No NestJS server or Vite client was found in this repository ' +
          `(read ${result.filesRead} of ${result.filesListed} files). Nothing was changed.`,
        diagnostics: result.diagnostics,
      });
    }

    // Land the proposal. A file that already says exactly this is left alone, so a
    // second Update on an unchanged repo produces no diff; one whose proposal equals
    // HEAD again only needs its pending row dropped.
    //
    // All or nothing: every size is checked before the first write, and the writes
    // share one transaction. A half-landed proposal (civil.yaml switched to TypeScript
    // with no composition to match) would be worse than none.
    const paths = Object.keys(result.files).sort();
    for (const path of paths) {
      const size = Buffer.byteLength(result.files[path]!, 'utf8');
      if (size > MAX_INLINE_BYTES) {
        const error = new ContentTooLargeError(size);
        await progress('failed', 'done', 'Nothing was changed.');
        return reply.code(413).send({ error: 'content_too_large', message: `${path}: ${error.message} Nothing was changed.` });
      }
    }
    await base.ensure?.(paths);
    await overlay.ensure(paths);
    const written: string[] = [];
    let unchanged = 0;
    const client = await pool.connect();
    // The pending helpers take a pool and only ever call query(), which a checked-out
    // client answers the same way — inside the transaction.
    const tx = client as unknown as pg.Pool;
    try {
      await client.query('BEGIN');
      for (const path of paths) {
        const content = result.files[path]!;
        if (overlay.read(path) === content) {
          unchanged += 1;
          continue;
        }
        if (base.exists(path) && base.read(path) === content) {
          await revertPending(tx, ownerId, project.id, project.branch, path);
        } else {
          await savePending(tx, {
            ownerId,
            projectId: project.id,
            branch: project.branch,
            path,
            content,
            // Add versus modify is HEAD's to decide, never the overlay's.
            existsAtHead: base.exists(path),
          });
        }
        written.push(path);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof ContentTooLargeError) {
        await progress('failed', 'done', 'Nothing was changed.');
        return reply.code(413).send({ error: 'content_too_large', message: error.message });
      }
      throw error;
    } finally {
      client.release();
    }

    const counts = {
      filesListed: result.filesListed,
      filesRead: result.filesRead,
      filesDropped: result.filesDropped,
      clients: skeleton.clients.length,
      servers: skeleton.servers.length,
      services: skeleton.services.length,
      agents: skeleton.agents.length,
      processes: skeleton.processes.length,
      written: written.length,
      unchanged,
    };
    request.log.info({ projectId: project.id, ...counts }, 'lifted repository');

    // The summary is what the toast shows and what an agent transcript will quote. When
    // nothing was written the mapper's summary already says so; saying it twice reads
    // as a stutter.
    const tail =
      written.length === 0
        ? /nothing to change/.test(result.summary)
          ? ''
          : ' Nothing changed — the documents already say this.'
        : ` ${written.length} file${written.length === 1 ? '' : 's'} proposed as pending changes — review them in the diff, then commit.`;
    await progress('done', 'done', `${written.length} file${written.length === 1 ? '' : 's'} proposed.`);
    return {
      files: written,
      summary: `${result.summary.trim()}${tail}`,
      note: result.note,
      diagnostics: result.diagnostics,
      counts,
      ...(result.analysis ? { analysis: result.analysis } : {}),
    };
  });
}
