import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ContentTooLargeError,
  MAX_INLINE_BYTES,
  clearPending,
  deletePending,
  listPending,
  revertPending,
  savePending,
} from '../dist/project/pending.js';

/**
 * Uncommitted work lives entirely in Postgres (pending.ts's own header explains
 * why). Every function here is a single SQL statement, so the thing worth testing
 * is that each one issues exactly the statement it claims to, with the right
 * parameters in the right order, and shapes the returned rows correctly — the same
 * mock-pool approach apps/api/test/transpile.test.ts uses for the runner's calls
 * into pending_changes.
 */
function mockPool(response: { rows?: unknown[]; rowCount?: number } = { rows: [] }) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return response;
    },
  };
}

// --- listPending -------------------------------------------------------------

test('listPending selects everything pending for one owner/project/branch, ordered by path', async () => {
  const rows = [
    {
      path: 'src/a.py',
      kind: 'add',
      fromPath: null,
      content: 'x',
      contentRef: null,
      sizeBytes: 1,
      baseBlobSha: null,
      updatedAt: 'now',
    },
  ];
  const pool = mockPool({ rows });

  const result = await listPending(pool as never, 'owner-1', 'proj-1', 'main');

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0]!;
  assert.match(sql, /FROM pending_changes/);
  assert.match(sql, /WHERE owner_id = \$1 AND project_id = \$2 AND branch = \$3/);
  assert.match(sql, /ORDER BY path/);
  // The select list maps every snake_case column pending_changes has to camelCase.
  assert.match(sql, /from_path\s+AS "fromPath"/);
  assert.match(sql, /content_ref\s+AS "contentRef"/);
  assert.match(sql, /size_bytes\s+AS "sizeBytes"/);
  assert.match(sql, /base_blob_sha\s+AS "baseBlobSha"/);
  assert.match(sql, /updated_at\s+AS "updatedAt"/);
  assert.deepEqual(params, ['owner-1', 'proj-1', 'main']);
  assert.equal(result, rows);
});

test('listPending returns an empty array when nothing is pending', async () => {
  const pool = mockPool({ rows: [] });
  const result = await listPending(pool as never, 'owner-1', 'proj-1', 'main');
  assert.deepEqual(result, []);
});

// --- savePending ---------------------------------------------------------------

test('savePending inserts an add when the file does not exist at HEAD', async () => {
  const row = { path: 'src/new.py', kind: 'add', updatedAt: 'now' };
  const pool = mockPool({ rows: [row] });

  const result = await savePending(pool as never, {
    ownerId: 'owner-1',
    projectId: 'proj-1',
    branch: 'main',
    path: 'src/new.py',
    content: 'print(1)',
    existsAtHead: false,
  });

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0]!;
  assert.match(sql, /INSERT INTO pending_changes/);
  assert.match(sql, /ON CONFLICT \(project_id, branch, path\) DO UPDATE/);
  assert.match(sql, /RETURNING/);
  assert.deepEqual(params, [
    'owner-1',
    'proj-1',
    'main',
    'src/new.py',
    'add',
    'print(1)',
    Buffer.byteLength('print(1)', 'utf8'),
    null,
  ]);
  assert.equal(result, row, 'the first returned row is handed back');
});

test('savePending inserts a modify when the file exists at HEAD, and forwards baseBlobSha', async () => {
  const pool = mockPool({ rows: [{ path: 'src/existing.py' }] });

  await savePending(pool as never, {
    ownerId: 'owner-1',
    projectId: 'proj-1',
    branch: 'main',
    path: 'src/existing.py',
    content: 'print(2)',
    baseBlobSha: 'deadbeef',
    existsAtHead: true,
  });

  const { params } = pool.calls[0]!;
  assert.equal(params[4], 'modify');
  assert.equal(params[7], 'deadbeef');
});

test('savePending never refreshes kind on conflict, so a pending add stays an add', async () => {
  const pool = mockPool({ rows: [{ path: 'x' }] });
  await savePending(pool as never, {
    ownerId: 'o',
    projectId: 'p',
    branch: 'main',
    path: 'x',
    content: 'y',
    existsAtHead: false,
  });
  assert.match(pool.calls[0]!.sql, /kind = pending_changes\.kind/, 'kind is preserved across re-saves, not re-derived');
});

test('savePending rejects content over MAX_INLINE_BYTES before ever touching the pool', async () => {
  const pool = mockPool();
  const big = 'x'.repeat(MAX_INLINE_BYTES + 1);

  await assert.rejects(
    () =>
      savePending(pool as never, {
        ownerId: 'owner-1',
        projectId: 'proj-1',
        branch: 'main',
        path: 'big.py',
        content: big,
        existsAtHead: false,
      }),
    ContentTooLargeError,
  );
  assert.equal(pool.calls.length, 0, 'no query is issued when the content is rejected up front');
});

// --- deletePending ---------------------------------------------------------------

test('deletePending marks a path deleted via upsert, without touching kind for the wrong reason', async () => {
  const pool = mockPool();

  await deletePending(pool as never, 'owner-1', 'proj-1', 'main', 'src/gone.py');

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0]!;
  assert.match(sql, /INSERT INTO pending_changes/);
  assert.match(sql, /'delete'/);
  assert.match(sql, /ON CONFLICT \(project_id, branch, path\) DO UPDATE/);
  assert.match(sql, /SET kind = 'delete', content = NULL, content_ref = NULL, size_bytes = 0/);
  assert.deepEqual(params, ['owner-1', 'proj-1', 'main', 'src/gone.py']);
});

// --- revertPending ---------------------------------------------------------------

test('revertPending deletes the pending row scoped to owner/project/branch/path', async () => {
  const pool = mockPool({ rowCount: 1 });

  const result = await revertPending(pool as never, 'owner-1', 'proj-1', 'main', 'src/edited.py');

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0]!;
  assert.match(sql, /DELETE FROM pending_changes/);
  assert.match(sql, /WHERE owner_id = \$1 AND project_id = \$2 AND branch = \$3 AND path = \$4/);
  assert.deepEqual(params, ['owner-1', 'proj-1', 'main', 'src/edited.py']);
  assert.equal(result, true, 'a row was actually deleted');
});

test('revertPending returns false when there was nothing pending to revert', async () => {
  const pool = mockPool({ rowCount: 0 });
  const result = await revertPending(pool as never, 'owner-1', 'proj-1', 'main', 'src/never-touched.py');
  assert.equal(result, false);
});

test('revertPending treats a missing rowCount as zero rather than throwing', async () => {
  const pool = mockPool({});
  const result = await revertPending(pool as never, 'owner-1', 'proj-1', 'main', 'src/x.py');
  assert.equal(result, false);
});

// --- clearPending (same delete-count shape as revertPending, one branch wide) ---

test('clearPending deletes every pending row for a branch and reports the count', async () => {
  const pool = mockPool({ rowCount: 3 });

  const result = await clearPending(pool as never, 'owner-1', 'proj-1', 'main');

  const { sql, params } = pool.calls[0]!;
  assert.match(sql, /DELETE FROM pending_changes WHERE owner_id = \$1 AND project_id = \$2 AND branch = \$3/);
  assert.deepEqual(params, ['owner-1', 'proj-1', 'main']);
  assert.equal(result, 3);
});
