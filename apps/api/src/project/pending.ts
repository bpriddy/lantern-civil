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
       (owner_id, project_id, branch, path, kind, content, size_bytes, base_blob_sha)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (project_id, branch, path) DO UPDATE
       SET content = EXCLUDED.content,
           size_bytes = EXCLUDED.size_bytes,
           updated_at = now(),
           -- kind is NOT refreshed: a file added in this pending set stays an add
           -- however many times it is saved. Letting it flip to 'modify' would tell
           -- the committer to expect a blob at HEAD that was never there.
           kind = pending_changes.kind
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
    `INSERT INTO pending_changes (owner_id, project_id, branch, path, kind, content, size_bytes)
     VALUES ($1, $2, $3, $4, 'delete', NULL, 0)
     ON CONFLICT (project_id, branch, path) DO UPDATE
       SET kind = 'delete', content = NULL, content_ref = NULL, size_bytes = 0, updated_at = now()`,
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

export async function clearPending(
  pool: pg.Pool,
  ownerId: string,
  projectId: string,
  branch: string,
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM pending_changes WHERE owner_id = $1 AND project_id = $2 AND branch = $3`,
    [ownerId, projectId, branch],
  );
  return rowCount ?? 0;
}
