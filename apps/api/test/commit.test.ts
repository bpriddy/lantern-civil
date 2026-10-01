import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BranchMovedError, commitPendingChanges } from '../dist/github/commit.js';

/**
 * Civil never decides whose version of a file wins. A commit is built on exactly
 * the commit the author has been editing against; if the branch moved since, it is
 * refused before anything is written, and the author syncs and resolves. Getting
 * this wrong does not error — it quietly lands one person's files over another's.
 */

/** GitHub, faked: the branch tip is `tip`; every write is recorded. */
const fakeGitHub = (tip: string) => {
  const writes: string[] = [];
  const app = {
    asInstallation: async (_id: number, path: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') writes.push(`${method} ${path.replace(/^\/repos\/o\/r/, '')}`);
      if (path.endsWith('/git/ref/heads/main')) return { object: { sha: tip } };
      if (path.includes('/git/commits/') && method === 'GET') return { tree: { sha: 'tree0' } };
      if (path.endsWith('/git/blobs')) return { sha: 'blob1' };
      if (path.endsWith('/git/trees')) return { sha: 'tree1' };
      if (path.endsWith('/git/commits')) return { sha: 'commit1', html_url: 'https://x/commit1' };
      return {};
    },
  };
  return { app, writes };
};

const request = (expectedHead: string | null | undefined) => ({
  installationId: 1,
  owner: 'o',
  repo: 'r',
  branch: 'main',
  message: 'm',
  changes: [
    {
      path: 'a.py', kind: 'modify', fromPath: null, content: 'x', contentRef: null,
      sizeBytes: 1, baseBlobSha: null, updatedAt: 'now',
    },
  ],
  expectedHead,
});

test('a branch that moved since the author synced is refused before anything is written', async () => {
  const { app, writes } = fakeGitHub('upstream-new');
  await assert.rejects(
    () => commitPendingChanges(app as never, request('pinned-old') as never),
    (error: unknown) => error instanceof BranchMovedError && error.currentSha === 'upstream-new',
  );
  assert.deepEqual(writes, [], 'no blob, tree, commit, or ref update — nothing to clean up');
});

test('a branch still where the author left it commits on top of it', async () => {
  const { app, writes } = fakeGitHub('pinned');
  const result = await commitPendingChanges(app as never, request('pinned') as never);
  assert.equal(result.commitSha, 'commit1');
  assert.ok(writes.includes('PATCH /git/refs/heads/main'), 'the branch moves to the new commit');
  assert.ok(!('reparentedOnto' in result), 'there is no automatic re-parenting any more');
});
