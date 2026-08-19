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
  sourceKind: 'github' | 'local' | 'example';
  localPath: string | null;
  exampleSlug: string | null;
  repoOwner: string | null;
  repoName: string | null;
  defaultBranch: string;
  /** The commit Civil is editing against. Null until first opened. */
  headSha: string | null;
}

const COLUMNS = `id,
                 name,
                 source_kind    AS "sourceKind",
                 local_path     AS "localPath",
                 example_slug   AS "exampleSlug",
                 repo_owner     AS "repoOwner",
                 repo_name      AS "repoName",
                 default_branch AS "defaultBranch",
                 head_sha       AS "headSha"`;

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

export async function createGitHubProject(
  pool: pg.Pool,
  ownerId: string,
  input: { name: string; repoOwner: string; repoName: string; defaultBranch: string; installationId: string },
): Promise<ProjectRow> {
  const { rows } = await pool.query<ProjectRow>(
    `INSERT INTO projects
       (owner_id, name, source_kind, repo_owner, repo_name, default_branch, installation_id)
     VALUES ($1, $2, 'github', $3, $4, $5, $6)
     ON CONFLICT (owner_id, repo_owner, repo_name) WHERE source_kind = 'github'
       DO UPDATE SET name = EXCLUDED.name,
                     default_branch = EXCLUDED.default_branch,
                     installation_id = EXCLUDED.installation_id,
                     updated_at = now()
     RETURNING ${COLUMNS}`,
    [ownerId, input.name, input.repoOwner, input.repoName, input.defaultBranch, input.installationId],
  );
  return rows[0]!;
}

/** Opening the same example twice returns the one you already have, edits and all. */
export async function openExampleProject(
  pool: pg.Pool,
  ownerId: string,
  slug: string,
  name: string,
): Promise<ProjectRow> {
  const { rows } = await pool.query<ProjectRow>(
    `INSERT INTO projects (owner_id, name, source_kind, example_slug)
     VALUES ($1, $2, 'example', $3)
     ON CONFLICT (owner_id, example_slug) WHERE source_kind = 'example'
       DO UPDATE SET updated_at = now()
     RETURNING ${COLUMNS}`,
    [ownerId, name, slug],
  );
  return rows[0]!;
}

/** Records which commit a project is being edited against. */
export async function setHeadSha(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  headSha: string,
): Promise<void> {
  await pool.query(
    'UPDATE projects SET head_sha = $1, updated_at = now() WHERE id = $2 AND owner_id = $3',
    [headSha, projectId, ownerId],
  );
}
