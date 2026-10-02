import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shapeCheck, toCommit } from '../dist/http/git-routes.js';

/**
 * What the source-control panel tells the author about GitHub. A wrong "up to
 * date" is the dangerous answer: it invites a commit the branch-moved guard will
 * refuse, or a sync the author did not know they needed.
 */

const gh = (sha: string, message: string) => ({
  sha,
  html_url: `https://github.com/o/r/commit/${sha}`,
  commit: { message, author: { name: 'Ben', date: '2026-10-01T10:00:00Z' } },
});

test('toCommit keeps the summary line and the author', () => {
  assert.deepEqual(toCommit(gh('abc', 'Add route\n\nlong body')), {
    sha: 'abc',
    message: 'Add route',
    author: 'Ben',
    date: '2026-10-01T10:00:00Z',
    url: 'https://github.com/o/r/commit/abc',
  });
});

test('the same tip is up to date; no branch yet is nothing landed', () => {
  assert.deepEqual(shapeCheck('h', 'h'), { tip: 'h', head: 'h', behind: 0, diverged: false, commits: [] });
  assert.equal(shapeCheck('h', null).behind, 0);
});

test('a moved branch reports how far behind, newest first', () => {
  const result = shapeCheck('h', 't', {
    status: 'ahead',
    ahead_by: 2,
    commits: [gh('c1', 'first'), gh('c2', 'second')],
  });
  assert.equal(result.behind, 2);
  assert.equal(result.diverged, false);
  assert.deepEqual(result.commits.map((c) => c.sha), ['c2', 'c1']);
});

test('a force push under the pinned head is called out', () => {
  assert.equal(shapeCheck('h', 't', { status: 'diverged', ahead_by: 1, commits: [] }).diverged, true);
});

test('with no pinned head, how far behind is unknowable rather than zero', () => {
  assert.equal(shapeCheck(null, 't').behind, null);
});

import { validBranchName } from '../dist/http/git-routes.js';

test('branch names git and GitHub both accept, and nothing they reserve', () => {
  for (const ok of ['feature/save-record', 'fix-123', 'ben/try.this', 'v2_0']) {
    assert.ok(validBranchName(ok), ok);
  }
  for (const bad of ['', 'has space', 'a..b', '-lead', 'x/.hidden', 'name.lock', 'trail/', '/lead', 'a@{b', 'x'.repeat(201)]) {
    assert.ok(!validBranchName(bad), bad);
  }
});
