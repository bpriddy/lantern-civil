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
  /** The repository's default branch — where pull requests go by default. */
  defaultBranch: string;
  /**
   * The branch the author is working on: pending edits, commits, sync, and the head
   * below are all this branch's. The default branch until the author switches.
   */
  branch: string;
  /** The commit Civil is editing against on `branch`. Null until first opened. */
  headSha: string | null;
  /** The branch `branch` was cut from, where its pull request goes; null for the default. */
  baseBranch: string | null;
  /** The pull request opened from `branch`, if any. */
  prNumber: number | null;
}

/**
 * Per-branch state lives in project_branches (migration 8); these subqueries read
 * the current branch's row so every caller sees one flat ProjectRow, and they work
 * in RETURNING as well as SELECT.
 */
const CURRENT = `COALESCE(projects.current_branch, projects.default_branch)`;
const BRANCH_ROW = `FROM project_branches b WHERE b.project_id = projects.id AND b.name = ${CURRENT}`;
const COLUMNS = `id,
                 name,
                 source_kind    AS "sourceKind",
                 local_path     AS "localPath",
                 example_slug   AS "exampleSlug",
                 repo_owner     AS "repoOwner",
                 repo_name      AS "repoName",
                 default_branch AS "defaultBranch",
                 ${CURRENT}     AS "branch",
                 (SELECT b.head_sha    ${BRANCH_ROW}) AS "headSha",
                 (SELECT b.base_branch ${BRANCH_ROW}) AS "baseBranch",
                 (SELECT b.pr_number   ${BRANCH_ROW}) AS "prNumber"`;

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

/** Records which commit the project is being edited against on its current branch. */
export async function setHeadSha(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  headSha: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO project_branches (owner_id, project_id, name, head_sha)
     SELECT owner_id, id, ${CURRENT}, $1 FROM projects WHERE id = $2 AND owner_id = $3
     ON CONFLICT (project_id, name) DO UPDATE SET head_sha = EXCLUDED.head_sha, updated_at = now()`,
    [headSha, projectId, ownerId],
  );
}

export interface BranchRow {
  name: string;
  headSha: string | null;
  baseBranch: string | null;
  prNumber: number | null;
  /** Edits set aside on this branch. */
  pending: number;
}

/** The branches Civil has worked on in this project, with their pending counts. */
export async function listProjectBranches(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
): Promise<BranchRow[]> {
  const { rows } = await pool.query<BranchRow>(
    `SELECT b.name, b.head_sha AS "headSha", b.base_branch AS "baseBranch", b.pr_number AS "prNumber",
            (SELECT count(*)::int FROM pending_changes p
              WHERE p.owner_id = $1 AND p.project_id = $2 AND p.branch = b.name) AS pending
       FROM project_branches b
      WHERE b.owner_id = $1 AND b.project_id = $2
      ORDER BY b.name`,
    [ownerId, projectId],
  );
  return rows;
}

/**
 * Makes `name` the branch the author works on, recording it if Civil has not seen
 * it before. `headSha` pins it (a branch just created, or just resolved); null
 * leaves an existing pin alone. `baseBranch` is only written for a new row.
 */
export async function switchBranch(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  input: { name: string; headSha: string | null; baseBranch: string | null },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE projects SET current_branch = $1, updated_at = now() WHERE id = $2 AND owner_id = $3`,
      [input.name, projectId, ownerId],
    );
    if (!rowCount) throw new Error('project not found');
    await client.query(
      `INSERT INTO project_branches (owner_id, project_id, name, head_sha, base_branch)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, name) DO UPDATE
         SET head_sha = COALESCE(EXCLUDED.head_sha, project_branches.head_sha), updated_at = now()`,
      [ownerId, projectId, input.name, input.headSha, input.baseBranch],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Remembers the pull request opened from a branch. */
export async function setBranchPr(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  branch: string,
  prNumber: number,
): Promise<void> {
  await pool.query(
    `UPDATE project_branches SET pr_number = $1, updated_at = now()
      WHERE owner_id = $2 AND project_id = $3 AND name = $4`,
    [prNumber, ownerId, projectId, branch],
  );
}
