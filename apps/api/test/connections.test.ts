import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getGitHubConnection,
  listConnections,
  removeGitHubConnection,
  upsertGitHubConnection,
} from '../dist/project/connections.js';

/**
 * A mock pool that records every query issued and hands back a pre-scripted result,
 * the same shape apps/api/test/transpile.test.ts uses for its fake pool.
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

test('listConnections selects by user_id and maps snake_case to camelCase', async () => {
  const rows = [
    { provider: 'github', externalLogin: 'octocat', externalId: '42', installationId: '99' },
  ];
  const pool = mockPool({ rows });

  const result = await listConnections(pool as never, 'user-1');

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0]!;
  assert.match(sql, /FROM user_connections WHERE user_id = \$1/);
  assert.match(sql, /external_login\s+AS "externalLogin"/);
  assert.match(sql, /external_id\s+AS "externalId"/);
  assert.match(sql, /installation_id::text AS "installationId"/, 'the bigint installation id is cast to text');
  assert.deepEqual(params, ['user-1']);
  assert.equal(result, rows, 'rows are returned as-is');
});

test('getGitHubConnection reuses listConnections and returns the github row', async () => {
  const rows = [
    { provider: 'github', externalLogin: 'octocat', externalId: '42', installationId: null },
  ];
  const pool = mockPool({ rows });

  const result = await getGitHubConnection(pool as never, 'user-1');

  assert.equal(pool.calls.length, 1, 'goes through the same single query as listConnections');
  assert.match(pool.calls[0]!.sql, /FROM user_connections/);
  assert.deepEqual(result, rows[0]);
});

test('getGitHubConnection returns null when the user has no connections at all', async () => {
  const pool = mockPool({ rows: [] });
  const result = await getGitHubConnection(pool as never, 'user-1');
  assert.equal(result, null);
});

test('getGitHubConnection returns null when connections exist but none are github', async () => {
  // provider is typed as exactly 'github' today, but the lookup must not assume the
  // row set is empty just because it is non-empty.
  const rows = [{ provider: 'gitlab' as never, externalLogin: 'x', externalId: '1', installationId: null }];
  const pool = mockPool({ rows });
  const result = await getGitHubConnection(pool as never, 'user-1');
  assert.equal(result, null);
});

test('upsertGitHubConnection inserts with an upsert on (user_id, provider)', async () => {
  const pool = mockPool();

  await upsertGitHubConnection(pool as never, 'user-1', 'octocat', 'ext-42', '12345');

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0]!;
  assert.match(sql, /INSERT INTO user_connections/);
  assert.match(sql, /'github'/, 'provider is hardcoded to github');
  assert.match(sql, /ON CONFLICT \(user_id, provider\) DO UPDATE/);
  assert.match(sql, /external_login\s*=\s*EXCLUDED\.external_login/);
  assert.match(sql, /external_id\s*=\s*EXCLUDED\.external_id/);
  assert.match(sql, /installation_id\s*=\s*EXCLUDED\.installation_id/);
  assert.match(sql, /updated_at\s*=\s*now\(\)/);
  assert.deepEqual(params, ['user-1', 'octocat', 'ext-42', '12345']);
});

test('upsertGitHubConnection passes a null installationId through unchanged', async () => {
  const pool = mockPool();
  await upsertGitHubConnection(pool as never, 'user-1', 'octocat', 'ext-42', null);
  assert.deepEqual(pool.calls[0]!.params, ['user-1', 'octocat', 'ext-42', null]);
});

test('removeGitHubConnection deletes scoped to the user and the github provider', async () => {
  const pool = mockPool();

  await removeGitHubConnection(pool as never, 'user-1');

  assert.equal(pool.calls.length, 1);
  const { sql, params } = pool.calls[0]!;
  assert.match(sql, /DELETE FROM user_connections WHERE user_id = \$1 AND provider = 'github'/);
  assert.deepEqual(params, ['user-1']);
});
