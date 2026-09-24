import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LocalSource } from '../dist/project/source.js';

/**
 * PRD 6.1: every file the canvas shows is a projection of files in git, and LocalSource
 * is the port that reads them. Its `resolve()` is the one place a project-relative path
 * — attacker-influenced the moment any signed-in user can create a project — is turned
 * into a real filesystem read. A hole here reads anything the service account can reach,
 * so the traversal defence gets the hardest tests in this file.
 *
 * A real temp directory is used rather than a mock: the defence relies on
 * `fs.realpathSync`, and only real symlinks on a real disk exercise it.
 */

/**
 * Build a project fixture in a fresh temp directory and hand it, plus a `secret.txt`
 * that lives OUTSIDE the project root, to `fn`. Everything is torn down afterwards.
 *
 * The root is passed through `realpathSync` before LocalSource sees it: on macOS
 * `os.tmpdir()` is under `/var`, itself a symlink to `/private/var`, and LocalSource's
 * containment check compares realpath'd targets against the root it was given. A root
 * that still contains a symlink in its ancestry would make every legitimate read fail
 * closed — safe, but it would test the wrong thing. Production roots are git clones with
 * canonical paths, so canonicalising here matches reality.
 */
function withFixture(
  fn: (ctx: { root: string; secretPath: string; src: LocalSource }) => void,
): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'civil-source-')));
  const root = path.join(base, 'project');
  try {
    fs.mkdirSync(root);

    // A legitimate in-project surface.
    fs.writeFileSync(path.join(root, 'app.yaml'), 'committed app');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.py'), 'committed a');
    fs.writeFileSync(path.join(root, 'src', 'b.py'), 'committed b');
    fs.mkdirSync(path.join(root, 'src', 'nested'));
    fs.writeFileSync(path.join(root, 'src', 'nested', 'deep.py'), 'deep');

    // The thing traversal wants to reach: a readable file outside the root.
    const secretPath = path.join(base, 'secret.txt');
    fs.writeFileSync(secretPath, 'TOP SECRET');

    fn({ root, secretPath, src: new LocalSource(root) });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// resolve() — the security boundary. Every escape must read as absent, not throw.

test('a ../ traversal is refused rather than read', () => {
  withFixture(({ src }) => {
    // The file exists and is readable; only containment stops the read.
    assert.equal(src.read('../secret.txt'), undefined, 'a parent-escape read leaked');
    assert.equal(src.exists('../secret.txt'), false, 'a parent-escape existence check leaked');

    // A traversal buried mid-path is the same escape and must be refused too.
    assert.equal(src.read('src/../../secret.txt'), undefined);
    assert.equal(src.exists('src/../../secret.txt'), false);
  });
});

test('an absolute path pointing outside the root is refused', () => {
  withFixture(({ src, secretPath }) => {
    // path.resolve lets an absolute argument win outright, so this reaches the real
    // file unless containment catches it.
    assert.equal(src.read(secretPath), undefined, 'an absolute-path read leaked');
    assert.equal(src.exists(secretPath), false, 'an absolute-path existence check leaked');
    // A well-known absolute path outside the root is refused whether or not it exists.
    assert.equal(src.read('/etc/hosts'), undefined);
  });
});

test('a symlink pointing outside the root cannot smuggle a read out', () => {
  withFixture(({ src, root }) => {
    // A symlink whose name and location are entirely in-project, but whose target is
    // the outside secret. Lexical containment passes; only the realpath check stops it.
    fs.symlinkSync(path.join(root, '..', 'secret.txt'), path.join(root, 'escape.txt'));
    assert.equal(src.read('escape.txt'), undefined, 'a symlink escape leaked file bytes');
    assert.equal(src.exists('escape.txt'), false, 'a symlink escape leaked existence');

    // A symlink to a directory outside the root: reads THROUGH it must fail too, so an
    // in-project-looking path like linkdir/secret.txt cannot reach out.
    fs.symlinkSync(path.join(root, '..'), path.join(root, 'linkdir'));
    assert.equal(src.read('linkdir/secret.txt'), undefined, 'a dir-symlink escape leaked');
    assert.equal(src.exists('linkdir/secret.txt'), false);
  });
});

test('a symlink that stays inside the root resolves normally', () => {
  withFixture(({ src, root }) => {
    // The realpath check must not punish legitimate in-project symlinks: it only cares
    // that the resolved path is still contained.
    fs.symlinkSync(path.join(root, 'src', 'a.py'), path.join(root, 'link-to-a.py'));
    assert.equal(src.read('link-to-a.py'), 'committed a', 'an in-project symlink was refused');
    assert.equal(src.exists('link-to-a.py'), true);
  });
});

// ---------------------------------------------------------------------------
// read() / exists() — ordinary behaviour once containment is satisfied.

test('read returns the bytes of an in-project file and undefined otherwise', () => {
  withFixture(({ src }) => {
    assert.equal(src.read('app.yaml'), 'committed app');
    assert.equal(src.read('src/a.py'), 'committed a');
    assert.equal(src.read('src/nested/deep.py'), 'deep');

    // Missing file: absent, not an error.
    assert.equal(src.read('src/missing.py'), undefined);
    // A directory is not a file, so reading one yields undefined rather than throwing.
    assert.equal(src.read('src'), undefined, 'a directory read should be undefined');
  });
});

test('exists distinguishes files, directories, and absence', () => {
  withFixture(({ src }) => {
    assert.equal(src.exists('app.yaml'), true);
    assert.equal(src.exists('src'), true, 'an in-project directory exists');
    assert.equal(src.exists('src/nested/deep.py'), true);
    assert.equal(src.exists('src/missing.py'), false);
    assert.equal(src.exists('nope'), false);
  });
});

// ---------------------------------------------------------------------------
// list() — sorted, project-relative, and blind to the ignored directories.

test('list returns sorted project-relative paths using forward slashes', () => {
  withFixture(({ src, root }) => {
    // Written in a deliberately non-sorted order to prove list() sorts.
    fs.writeFileSync(path.join(root, 'zeta.txt'), 'z');
    fs.writeFileSync(path.join(root, 'alpha.txt'), 'a');

    const listed = src.list();
    assert.deepEqual(listed, [...listed].sort(), 'list() is not sorted');
    assert.ok(listed.includes('app.yaml'));
    assert.ok(listed.includes('src/a.py'), 'nested paths must be project-relative with /');
    assert.ok(listed.includes('src/nested/deep.py'));
    assert.ok(listed.includes('alpha.txt') && listed.includes('zeta.txt'));
    // Paths are relative to the root — no absolute segment leaks in.
    assert.ok(!listed.some((p) => p.startsWith('/') || p.includes(root)));
  });
});

test('list skips every ignored directory', () => {
  withFixture(({ src, root }) => {
    const ignored = ['.git', 'node_modules', '.civil', '__pycache__', '.venv', 'dist'];
    for (const dir of ignored) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, 'buried.txt'), 'should not appear');
    }
    // An ignored directory nested inside a real one is skipped too.
    fs.mkdirSync(path.join(root, 'src', 'node_modules'));
    fs.writeFileSync(path.join(root, 'src', 'node_modules', 'x.js'), 'nope');

    const listed = src.list();
    for (const dir of ignored) {
      assert.ok(
        !listed.some((p) => p === `${dir}/buried.txt` || p.split('/').includes(dir)),
        `list() leaked a file from the ignored directory "${dir}": ${JSON.stringify(listed)}`,
      );
    }
    // The real files are still all there.
    assert.ok(listed.includes('app.yaml') && listed.includes('src/a.py'));
  });
});

// ---------------------------------------------------------------------------
// glob() — anchored to the root, sorted, and filtered of the ignored directories.

test('glob returns sorted matches relative to the root', () => {
  withFixture(({ src }) => {
    assert.deepEqual(src.glob('src/*.py'), ['src/a.py', 'src/b.py']);
    assert.deepEqual(src.glob('src/**/*.py'), ['src/a.py', 'src/b.py', 'src/nested/deep.py']);
    // A pattern that matches nothing yields an empty list, not an error.
    assert.deepEqual(src.glob('*.nonexistent'), []);
  });
});

test('glob filters out matches inside ignored directories', () => {
  withFixture(({ src, root }) => {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'bundle.py'), 'built');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'));
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.py'), 'dep');

    const hits = src.glob('**/*.py');
    assert.ok(!hits.some((p) => p.split('/').includes('dist')), 'dist/ leaked into glob');
    assert.ok(!hits.some((p) => p.split('/').includes('node_modules')), 'node_modules/ leaked into glob');
    // The legitimate matches are still returned.
    assert.ok(hits.includes('src/a.py') && hits.includes('src/nested/deep.py'));
  });
});

// ---------------------------------------------------------------------------
// Shape of the port itself.

test('root is stored as a resolved absolute path', () => {
  withFixture(({ src, root }) => {
    assert.equal(src.root, root);
    assert.ok(path.isAbsolute(src.root));
  });
});

test('a disk source exposes no ensure hook', () => {
  withFixture(({ src }) => {
    // The interface makes ensure optional and absent for sources whose reads are
    // already local; callers branch on its presence, so it must genuinely be missing.
    assert.equal(src.ensure, undefined);
  });
});
