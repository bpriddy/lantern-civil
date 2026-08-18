import pg from 'pg';
import type { Config } from '../config.js';

/**
 * PRD 12: Cloud SQL Postgres. On Cloud Run the connection is a unix socket
 * (`?host=/cloudsql/<project>:<region>:<instance>`), which `pg` understands from the
 * URL, so nothing here is Cloud-Run-specific.
 */
export function createPool(config: Config): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    // Cloud Run scales to many instances against one small Postgres; a large
    // per-instance pool is how you exhaust max_connections. PRD 2 is explicit that
    // this does not need to withstand load.
    max: config.isProduction ? 5 : 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

export async function checkConnection(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}
