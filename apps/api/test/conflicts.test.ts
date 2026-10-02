import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findConflicts } from '../dist/project/conflicts.js';

/**
 * A missed conflict is the quiet failure: a commit lands the author's file over a
 * change they never saw. A false one is the loud failure: the author is asked to
 * choose when nothing happened upstream. Both are pinned here.
 */

const row = (path: string, kind: string, baseCommitSha: string | null) =>
  ({ path, kind, baseCommitSha, content: 'x', fromPath: null, contentRef: null, sizeBytes: 1, baseBlobSha: null, updatedAt: 'now' }) as never;

// Two commits: upstream edited app.yaml, added new.py, deleted gone.py; left keep.py alone.
const TREES: Record<string, Record<string, string>> = {
  base: { 'civil/app.yaml': 'b1', 'keep.py': 'k1', 'gone.py': 'g1' },
  head: { 'civil/app.yaml': 'b2', 'keep.py': 'k1', 'new.py': 'n1' },
};
const loads: string[] = [];
const blobsAt = async (sha: string) => {
  loads.push(sha);
  return (path: string) => TREES[sha]![path];
};

test('only files upstream changed under an edit are conflicts, each named for what happened', async () => {
  loads.length = 0;
  const conflicts = await findConflicts(
    [
      row('civil/app.yaml', 'modify', 'base'),
      row('keep.py', 'modify', 'base'), // upstream left it alone
      row('new.py', 'add', 'base'), // both sides created it
      row('gone.py', 'modify', 'base'), // edited here, deleted upstream
    ],
    'head',
    blobsAt,
  );
  assert.deepEqual(conflicts, [
    { path: 'civil/app.yaml', mine: 'modify', theirs: 'modified' },
    { path: 'gone.py', mine: 'modify', theirs: 'deleted' },
    { path: 'new.py', mine: 'add', theirs: 'added' },
  ]);
  assert.deepEqual(loads, ['head', 'base'], 'each tree is read once however many edits share it');
});

test('edits made against the head, or with no recorded base, cost nothing and conflict with nothing', async () => {
  loads.length = 0;
  assert.deepEqual(await findConflicts([row('civil/app.yaml', 'modify', 'head')], 'head', blobsAt), []);
  assert.deepEqual(await findConflicts([row('civil/app.yaml', 'modify', null)], 'head', blobsAt), []);
  assert.deepEqual(await findConflicts([row('civil/app.yaml', 'modify', 'base')], null, blobsAt), []);
  assert.deepEqual(loads, [], 'no tree is read when no edit is behind the head');
});
