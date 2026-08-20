import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OverlaySource } from '../dist/project/overlay.js';

/**
 * The overlay decides what every file in the project looks like. A bug here shows the
 * wrong bytes without erroring — the exact silent-corruption class PRD 2 says is worth
 * testing, and the reason this file exists at all.
 */

const base = {
  files: new Map([
    ['app.yaml', 'committed app'],
    ['src/a.py', 'committed a'],
    ['src/b.py', 'committed b'],
  ]),
  exists(p: string) { return this.files.has(p); },
  read(p: string) { return this.files.get(p); },
  list() { return [...this.files.keys()].sort(); },
  glob(pattern: string) {
    const re = new RegExp('^' + pattern.replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*') + '$');
    return this.list().filter((f) => re.test(f));
  },
};

const change = (over: Record<string, unknown>) => ({
  path: 'x', kind: 'modify', fromPath: null, content: null, contentRef: null,
  sizeBytes: 0, baseBlobSha: null, updatedAt: '', ...over,
}) as never;

test('an edit shadows the committed file', () => {
  const o = new OverlaySource(base, [change({ path: 'src/a.py', kind: 'modify', content: 'edited a' })]);
  assert.equal(o.read('src/a.py'), 'edited a');
  assert.equal(o.read('src/b.py'), 'committed b', 'untouched files still come from HEAD');
});

test('a directory implied by a pending file exists before the commit', () => {
  // The scaffold writes web/index.html as a pending add; the client node's
  // `path: web` must validate against it immediately, not after committing.
  const overlay = new OverlaySource(base, [
    change({ path: 'web/index.html', kind: 'add', content: '<!doctype html>' }),
  ]);
  assert.equal(overlay.exists('web'), true);
  assert.equal(overlay.exists('web/'), true);
  assert.equal(overlay.exists('we'), false, 'a prefix of a name is not a directory');
});

test('an added file exists before it is committed', () => {
  const o = new OverlaySource(base, [change({ path: 'src/new.py', kind: 'add', content: 'brand new' })]);
  assert.equal(o.exists('src/new.py'), true);
  assert.equal(o.read('src/new.py'), 'brand new');
  assert.ok(o.list().includes('src/new.py'));
  // A code node's include glob has to match a new step file before commit, or the
  // node would render empty (PRD 6.3).
  assert.ok(o.glob('src/**/*.py').includes('src/new.py'));
});

test('a pending delete makes the file absent even though HEAD still has it', () => {
  const o = new OverlaySource(base, [change({ path: 'src/b.py', kind: 'delete' })]);
  assert.equal(o.exists('src/b.py'), false);
  assert.equal(o.read('src/b.py'), undefined);
  assert.ok(!o.list().includes('src/b.py'));
  assert.ok(!o.glob('src/**/*.py').includes('src/b.py'));
});

test('a rename moves the bytes and vacates the old path', () => {
  const o = new OverlaySource(base, [
    change({ path: 'src/renamed.py', kind: 'rename', fromPath: 'src/a.py' }),
  ]);
  // A pure rename carries no content — the bytes are whatever the old path held.
  assert.equal(o.read('src/renamed.py'), 'committed a');
  assert.equal(o.exists('src/a.py'), false, 'the old path must read as gone');
  assert.equal(o.read('src/a.py'), undefined);

  const listed = o.list();
  assert.ok(listed.includes('src/renamed.py'));
  assert.ok(!listed.includes('src/a.py'));
});

test('a rename that also edits uses the new content', () => {
  const o = new OverlaySource(base, [
    change({ path: 'src/renamed.py', kind: 'rename', fromPath: 'src/a.py', content: 'moved and edited' }),
  ]);
  assert.equal(o.read('src/renamed.py'), 'moved and edited');
  assert.equal(o.exists('src/a.py'), false);
});

test('content in GCS reads as absent rather than empty', () => {
  // Spilling large files to object storage is not wired yet. Returning '' would
  // silently render an empty file and look like data loss.
  const o = new OverlaySource(base, [
    change({ path: 'src/big.py', kind: 'modify', content: null, contentRef: 'gs://bucket/blob' }),
  ]);
  assert.equal(o.read('src/big.py'), undefined);
});

test('nothing leaks when there are no pending changes', () => {
  const o = new OverlaySource(base, []);
  assert.deepEqual(o.list(), base.list());
  assert.equal(o.read('app.yaml'), 'committed app');
  assert.deepEqual([...o.status().keys()], []);
});

test('status reports what the tree should badge', () => {
  const o = new OverlaySource(base, [
    change({ path: 'src/a.py', kind: 'modify', content: 'x' }),
    change({ path: 'src/new.py', kind: 'add', content: 'y' }),
    change({ path: 'src/b.py', kind: 'delete' }),
  ]);
  assert.deepEqual(
    [...o.status().entries()].sort(),
    [['src/a.py', 'modify'], ['src/b.py', 'delete'], ['src/new.py', 'add']],
  );
});

test('ensure forwards only what pending does not satisfy', async () => {
  const asked: string[][] = [];
  const hydratable = {
    ...base,
    ensure: async (paths: readonly string[]) => { asked.push([...paths]); },
  };
  const o = new OverlaySource(hydratable, [
    change({ path: 'src/a.py', kind: 'modify', content: 'edited' }),
    change({ path: 'src/moved.py', kind: 'rename', fromPath: 'src/b.py', content: null }),
    change({ path: 'gone.py', kind: 'delete', content: null }),
  ]);

  await o.ensure(['src/a.py', 'src/moved.py', 'gone.py', 'app.yaml']);

  // Pending content answers a; the rename needs its base bytes from the OLD path;
  // the delete needs nothing; the untouched file passes straight through.
  assert.deepEqual(asked, [['src/b.py', 'app.yaml']]);
});

test('ensure is safe when the base has no hydration', async () => {
  const o = new OverlaySource(base, [change({ path: 'src/a.py', kind: 'modify', content: 'x' })]);
  await o.ensure(['src/a.py', 'app.yaml']);
  assert.equal(o.read('app.yaml'), 'committed app');
});
