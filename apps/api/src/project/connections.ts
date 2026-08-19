import type pg from 'pg';

/** PRD 15 is GitHub-only, so `provider` has exactly one legal value today. */
export interface Connection {
  provider: 'github';
  externalLogin: string | null;
  externalId: string | null;
  installationId: string | null;
}

export async function listConnections(pool: pg.Pool, userId: string): Promise<Connection[]> {
  const { rows } = await pool.query<Connection>(
    `SELECT provider,
            external_login  AS "externalLogin",
            external_id     AS "externalId",
            installation_id::text AS "installationId"
       FROM user_connections WHERE user_id = $1`,
    [userId],
  );
  return rows;
}

export async function getGitHubConnection(pool: pg.Pool, userId: string): Promise<Connection | null> {
  const rows = await listConnections(pool, userId);
  return rows.find((c) => c.provider === 'github') ?? null;
}

export async function upsertGitHubConnection(
  pool: pg.Pool,
  userId: string,
  login: string,
  externalId: string,
  installationId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO user_connections (user_id, provider, external_login, external_id, installation_id)
     VALUES ($1, 'github', $2, $3, $4)
     ON CONFLICT (user_id, provider) DO UPDATE
       SET external_login = EXCLUDED.external_login,
           external_id    = EXCLUDED.external_id,
           installation_id = EXCLUDED.installation_id,
           updated_at     = now()`,
    [userId, login, externalId, installationId],
  );
}

export async function removeGitHubConnection(pool: pg.Pool, userId: string): Promise<void> {
  await pool.query(`DELETE FROM user_connections WHERE user_id = $1 AND provider = 'github'`, [userId]);
}
