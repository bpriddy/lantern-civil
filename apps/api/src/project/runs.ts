import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * PRD 8: a run is a job, not a request. Everything a watcher needs lives in these
 * two tables — status here, the story in run_events — so watching is reading, and
 * a watcher can detach and reattach without the run noticing (PRD 8.2).
 *
 * The runner authenticates with a per-run bearer token minted at dispatch. Only
 * its hash is stored, and it authorises exactly one run's events — the runner
 * holds no platform credentials (PRD 12), so this token is the entire extent of
 * what a run can write.
 */

export type RunStatus = 'queued' | 'running' | 'finished' | 'partial' | 'failed' | 'cancelled';

export interface Run {
  id: string;
  projectId: string;
  branch: string;
  graphPath: string;
  commitSha: string | null;
  sessionId: string | null;
  status: RunStatus;
  toolValidation: 'strict' | 'lenient';
  input: unknown;
  output: unknown;
  error: string | null;
  eventSeq: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const SELECT = `id,
                project_id      AS "projectId",
                branch,
                graph_path      AS "graphPath",
                commit_sha      AS "commitSha",
                session_id      AS "sessionId",
                status,
                tool_validation AS "toolValidation",
                input,
                output,
                error,
                event_seq::int  AS "eventSeq",
                created_at      AS "createdAt",
                started_at      AS "startedAt",
                finished_at     AS "finishedAt"`;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface CreateRunInput {
  ownerId: string;
  projectId: string;
  branch: string;
  graphPath: string;
  commitSha: string | null;
  input: unknown;
  toolValidation: 'strict' | 'lenient';
  sessionId?: string | undefined;
}

/** Creates a queued run and mints its runner token. The token is returned once and
 *  never stored — same discipline as sessions. */
export async function createRun(
  pool: pg.Pool,
  init: CreateRunInput,
): Promise<{ run: Run; runnerToken: string }> {
  const runnerToken = randomBytes(32).toString('base64url');
  const { rows } = await pool.query<Run>(
    `INSERT INTO runs
       (owner_id, project_id, branch, graph_path, commit_sha, session_id, input,
        tool_validation, runner_token_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT}`,
    [
      init.ownerId,
      init.projectId,
      init.branch,
      init.graphPath,
      init.commitSha,
      init.sessionId ?? null,
      JSON.stringify(init.input ?? null),
      init.toolValidation,
      hash(runnerToken),
    ],
  );
  return { run: rows[0]!, runnerToken };
}

export async function getRun(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  runId: string,
): Promise<Run | undefined> {
  const { rows } = await pool.query<Run>(
    `SELECT ${SELECT} FROM runs
      WHERE id = $1 AND owner_id = $2 AND project_id = $3`,
    [runId, ownerId, projectId],
  );
  return rows[0];
}

export async function listRuns(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  limit = 50,
): Promise<Run[]> {
  const { rows } = await pool.query<Run>(
    `SELECT ${SELECT} FROM runs
      WHERE owner_id = $1 AND project_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [ownerId, projectId, limit],
  );
  return rows;
}

/** The run a bearer token authorises, or nothing. This is the runner's whole identity. */
export async function getRunByToken(pool: pg.Pool, token: string): Promise<Run | undefined> {
  const { rows } = await pool.query<Run>(
    `SELECT ${SELECT} FROM runs WHERE runner_token_hash = $1`,
    [hash(token)],
  );
  return rows[0];
}

export interface RunEvent {
  seq: number;
  type: string;
  nodeId: string | null;
  graphPath: string | null;
  payload: unknown;
  createdAt: string;
}

/**
 * Appends one event, allocating the next seq under the run's row lock — which is
 * what makes seq gapless and offset reads exact (the M0 schema's design). Also
 * mirrors the lifecycle onto the run row: run.started/run.finished move status, so
 * the runs table answers "where is it" without replaying the log.
 */
export async function appendEvent(
  pool: pg.Pool,
  run: { id: string },
  event: {
    type: string;
    nodeId?: string | undefined;
    graphPath?: string | undefined;
    payload?: unknown;
  },
): Promise<RunEvent> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seqRow = await client.query<{ seq: string; owner_id: string }>(
      `UPDATE runs SET event_seq = event_seq + 1
        WHERE id = $1
        RETURNING event_seq - 1 AS seq, owner_id`,
      [run.id],
    );
    if (seqRow.rows.length === 0) throw new Error('run vanished mid-append');
    const seq = Number(seqRow.rows[0]!.seq);

    const { rows } = await client.query<RunEvent>(
      `INSERT INTO run_events (run_id, seq, owner_id, type, node_id, graph_path, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING seq::int, type, node_id AS "nodeId", graph_path AS "graphPath",
                 payload, created_at AS "createdAt"`,
      [
        run.id,
        seq,
        seqRow.rows[0]!.owner_id,
        event.type,
        event.nodeId ?? null,
        event.graphPath ?? null,
        event.payload === undefined ? null : JSON.stringify(event.payload),
      ],
    );

    if (event.type === 'run.started') {
      await client.query(
        `UPDATE runs SET status = 'running', started_at = COALESCE(started_at, now())
          WHERE id = $1`,
        [run.id],
      );
    } else if (event.type === 'run.finished') {
      const outcome = (event.payload ?? {}) as {
        status?: string;
        output?: unknown;
        error?: string;
      };
      const status: RunStatus = ['finished', 'partial', 'failed', 'cancelled'].includes(
        outcome.status ?? '',
      )
        ? (outcome.status as RunStatus)
        : 'finished';
      await client.query(
        `UPDATE runs
            SET status = $2,
                output = $3,
                error = $4,
                finished_at = now(),
                runner_token_hash = NULL
          WHERE id = $1`,
        [
          run.id,
          status,
          JSON.stringify(outcome.output ?? null),
          outcome.error ?? null,
        ],
      );
    }

    await client.query('COMMIT');
    return rows[0]!;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Events from an offset (PRD 8.2): reconnecting is a range read, not a resubscription. */
export async function readEvents(
  pool: pg.Pool,
  ownerId: string,
  runId: string,
  after: number,
  limit = 500,
): Promise<RunEvent[]> {
  const { rows } = await pool.query<RunEvent>(
    `SELECT seq::int, type, node_id AS "nodeId", graph_path AS "graphPath",
            payload, created_at AS "createdAt"
       FROM run_events
      WHERE run_id = $1 AND owner_id = $2 AND seq > $3
      ORDER BY seq
      LIMIT $4`,
    [runId, ownerId, after, limit],
  );
  return rows;
}

/**
 * Cancellation is a status the runner polls, not a signal — there is no channel to
 * a run but the database, deliberately (PRD 8.2: watchers and runs are decoupled).
 */
export async function requestCancel(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  runId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE runs SET status = 'cancelled', finished_at = COALESCE(finished_at, now())
      WHERE id = $1 AND owner_id = $2 AND project_id = $3
        AND status IN ('queued', 'running')`,
    [runId, ownerId, projectId],
  );
  return (rowCount ?? 0) > 0;
}
