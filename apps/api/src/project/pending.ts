import type pg from 'pg';

/**
 * Uncommitted work. CLAUDE.md: nothing on the container filesystem may be the only
 * copy of anything, and an uncommitted edit is reconstructible from nothing — so it
 * lives here, which is also what makes picking a project up on another device work.
 */

export type ChangeKind = 'add' | 'modify' | 'delete' | 'rename';

export interface PendingChange {
  path: string;
  kind: ChangeKind;
  fromPath: string | null;
  content: string | null;
  contentRef: string | null;
  sizeBytes: number;
  baseBlobSha: string | null;
  /**
   * The commit this edit was made against: the project's head when the row was
   * first saved, kept across re-saves. When it differs from the head now and the
   * file changed upstream in between, the file is in conflict (conflicts.ts).
   * Null for rows saved before it was recorded — those cannot be checked.
   */
  baseCommitSha: string | null;
  updatedAt: string;
}

/**
 * Above this, content belongs in GCS with a pointer in content_ref — the same split
 * run_events uses. Not wired yet: manifests and Python files are single-digit KB, and
 * an unused code path that writes to object storage is a liability, not a feature.
 * The column and the constraint already allow it, so adding it is additive.
 */
export const MAX_INLINE_BYTES = 512 * 1024;

export class ContentTooLargeError extends Error {
  constructor(size: number) {
    super(
      `File is ${size} bytes; inline storage stops at ${MAX_INLINE_BYTES}. ` +
        'Spilling to GCS is not implemented yet.',
    );
    this.name = 'ContentTooLargeError';
  }
}

const SELECT = `path,
                kind,
                from_path      AS "fromPath",
                content,
                content_ref    AS "contentRef",
                size_bytes     AS "sizeBytes",
                base_blob_sha  AS "baseBlobSha",
                base_commit_sha AS "baseCommitSha",
                updated_at     AS "updatedAt"`;

export async function listPending(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  branch: string,
): Promise<PendingChange[]> {
  const { rows } = await pool.query<PendingChange>(
    `SELECT ${SELECT} FROM pending_changes
      WHERE owner_id = $1 AND project_id = $2 AND branch = $3
      ORDER BY path`,
    [ownerId, projectId, branch],
  );
  return rows;
}

export interface SaveInput {
  ownerId: string;
  projectId: string;
  branch: string;
  path: string;
  content: string;
  /** The blob the editor was looking at, so divergence is detectable per file. */
  baseBlobSha?: string | undefined;
  /** Whether the file exists at HEAD — decides add versus modify. */
  existsAtHead: boolean;
}

export async function savePending(pool: pg.Pool, input: SaveInput): Promise<PendingChange> {
  const size = Buffer.byteLength(input.content, 'utf8');
  if (size > MAX_INLINE_BYTES) throw new ContentTooLargeError(size);

  const { rows } = await pool.query<PendingChange>(
    `INSERT INTO pending_changes
       (owner_id, project_id, branch, path, kind, content, size_bytes, base_blob_sha,
        base_commit_sha)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             (SELECT head_sha FROM projects WHERE id = $2 AND owner_id = $1))
     ON CONFLICT (project_id, branch, path) DO UPDATE
       SET content = EXCLUDED.content,
           -- An edit keeps the base it started from; only resolving a conflict
           -- (rebasePending) or a commit moves it.
           base_commit_sha = COALESCE(pending_changes.base_commit_sha, EXCLUDED.base_commit_sha),
           size_bytes = EXCLUDED.size_bytes,
           updated_at = now(),
           -- kind is NOT refreshed: a file added in this pending set stays an add
           -- however many times it is saved. Letting it flip to 'modify' would tell
           -- the committer to expect a blob at HEAD that was never there.
           -- The exception is a pending delete: saving content un-deletes the file,
           -- and keeping 'delete' would violate pending_changes_content_shape.
           kind = CASE WHEN pending_changes.kind = 'delete'
                       THEN EXCLUDED.kind
                       ELSE pending_changes.kind END
     RETURNING ${SELECT}`,
    [
      input.ownerId,
      input.projectId,
      input.branch,
      input.path,
      input.existsAtHead ? 'modify' : 'add',
      input.content,
      size,
      input.baseBlobSha ?? null,
    ],
  );
  return rows[0]!;
}

/** Marks a committed file deleted. Discarding an edit is revertPending instead. */
export async function deletePending(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  branch: string,
  path: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO pending_changes
       (owner_id, project_id, branch, path, kind, content, size_bytes, base_commit_sha)
     VALUES ($1, $2, $3, $4, 'delete', NULL, 0,
             (SELECT head_sha FROM projects WHERE id = $2 AND owner_id = $1))
     ON CONFLICT (project_id, branch, path) DO UPDATE
       SET kind = 'delete', content = NULL, content_ref = NULL, size_bytes = 0, updated_at = now(),
           base_commit_sha = COALESCE(pending_changes.base_commit_sha, EXCLUDED.base_commit_sha)`,
    [ownerId, projectId, branch, path],
  );
}

/** Throws the pending edit away; the file reverts to whatever HEAD says. */
export async function revertPending(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  branch: string,
  path: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM pending_changes
      WHERE owner_id = $1 AND project_id = $2 AND branch = $3 AND path = $4`,
    [ownerId, projectId, branch, path],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Clears exactly the rows a commit wrote, and nothing saved since. A commit spans
 * several GitHub calls; an edit landing in that window (another tab, the background
 * re-transpile an op triggers) updates its row in place, and deleting it would lose
 * work that was never committed. So a row is cleared only if it still holds what was
 * committed — same kind, same content — and any row changed since survives as pending.
 */
export async function clearCommitted(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  branch: string,
  committed: readonly Pick<PendingChange, 'path' | 'kind' | 'content' | 'contentRef'>[],
): Promise<number> {
  if (committed.length === 0) return 0;
  const { rowCount } = await pool.query(
    `DELETE FROM pending_changes p
      USING unnest($4::text[], $5::text[], $6::text[], $7::text[])
            AS c(path, kind, content, content_ref)
      WHERE p.owner_id = $1 AND p.project_id = $2 AND p.branch = $3
        AND p.path = c.path
        AND p.kind = c.kind
        AND p.content IS NOT DISTINCT FROM c.content
        AND p.content_ref IS NOT DISTINCT FROM c.content_ref`,
    [
      ownerId,
      projectId,
      branch,
      committed.map((c) => c.path),
      committed.map((c) => c.kind),
      committed.map((c) => c.content),
      committed.map((c) => c.contentRef),
    ],
  );
  return rowCount ?? 0;
}

/**
 * Moves edits onto a new base commit. Two callers, both meaning "this edit now
 * stands on that commit": resolving a conflict as mine (the author has seen the
 * upstream change and keeps their version over it), and a commit, after which the
 * rows it spared — edits saved while it was in flight — sit on top of what was just
 * committed. `paths` undefined means every row on the branch.
 */
export async function rebasePending(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  branch: string,
  headSha: string,
  paths?: readonly string[],
): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE pending_changes SET base_commit_sha = $4
      WHERE owner_id = $1 AND project_id = $2 AND branch = $3
        AND ($5::text[] IS NULL OR path = ANY($5::text[]))`,
    [ownerId, projectId, branch, headSha, paths ?? null],
  );
  return rowCount ?? 0;
}
