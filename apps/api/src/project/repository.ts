import type pg from 'pg';

/**
 * Every query here filters by owner_id. That is the whole of the isolation model the
 * owner chose: one owner per project, invisible to everyone else. It is enforced in
 * the WHERE clause rather than in a handler, so a forgotten check is a query that
 * returns nothing rather than a query that returns someone else's project.
 */

export interface ProjectRow {
  id: string;
  name: string;
  sourceKind: 'github' | 'local';
  localPath: string | null;
  repoOwner: string | null;
  repoName: string | null;
  defaultBranch: string;
}

const COLUMNS = `id,
                 name,
                 source_kind    AS "sourceKind",
                 local_path     AS "localPath",
                 repo_owner     AS "repoOwner",
                 repo_name      AS "repoName",
                 default_branch AS "defaultBranch"`;

export async function listProjects(pool: pg.Pool, ownerId: string): Promise<ProjectRow[]> {
  const { rows } = await pool.query<ProjectRow>(
    `SELECT ${COLUMNS} FROM projects WHERE owner_id = $1 ORDER BY created_at`,
    [ownerId],
  );
  return rows;
}

export async function getProject(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
): Promise<ProjectRow | null> {
  // A non-uuid id would make Postgres throw rather than return nothing.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
    return null;
  }
  const { rows } = await pool.query<ProjectRow>(
    `SELECT ${COLUMNS} FROM projects WHERE id = $1 AND owner_id = $2`,
    [projectId, ownerId],
  );
  return rows[0] ?? null;
}

export async function createLocalProject(
  pool: pg.Pool,
  ownerId: string,
  name: string,
  localPath: string,
): Promise<ProjectRow> {
  const { rows } = await pool.query<ProjectRow>(
    `INSERT INTO projects (owner_id, name, source_kind, local_path)
     VALUES ($1, $2, 'local', $3)
     ON CONFLICT (owner_id, local_path) WHERE source_kind = 'local'
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING ${COLUMNS}`,
    [ownerId, name, localPath],
  );
  return rows[0]!;
}
