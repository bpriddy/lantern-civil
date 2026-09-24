import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryFiles, globToRegExp } from '../dist/index.js';

// ---------------------------------------------------------------------------
// globToRegExp — the glob subset manifests actually use: `**`, `*`, `?`.
// Every pattern compiles to a full-string (anchored) matcher.
// ---------------------------------------------------------------------------

test('`**/` spans path segments, and matches zero directories too', () => {
  const re = globToRegExp('src/steps/**/*.py');

  // The example the task pins: crosses a directory boundary.
  assert.equal(re.test('src/steps/a/b.py'), true);
  // The `(?:.*/)?` group is optional, so zero intervening dirs also match.
  assert.equal(re.test('src/steps/x.py'), true);
  // Deeper nesting is still fine.
  assert.equal(re.test('src/steps/a/b/c.py'), true);
  // A different literal prefix must not match.
  assert.equal(re.test('src/other.py'), false);
  // The trailing `*.py` is a single segment: the basename cannot contain a slash.
  assert.equal(re.test('src/steps/a/b.py.bak'), false);
});

test('a leading `**/` may match zero segments at the root', () => {
  const re = globToRegExp('**/*.py');
  assert.equal(re.test('a.py'), true);
  assert.equal(re.test('a/b.py'), true);
  assert.equal(re.test('a/b/c.py'), true);
  assert.equal(re.test('a.txt'), false);
});

test('a bare `**` (not followed by /) becomes `.*` and crosses segments', () => {
  const re = globToRegExp('src/**.py');
  assert.equal(re.source, '^src\\/.*\\.py$');
  assert.equal(re.test('src/a/b.py'), true);
  assert.equal(re.test('src/.py'), true);
});

test('`*` matches within a single segment only', () => {
  const re = globToRegExp('src/*.py');
  assert.equal(re.test('src/a.py'), true);
  // A single star does not cross a slash.
  assert.equal(re.test('src/a/b.py'), false);
  assert.equal(re.test('src/a.txt'), false);
});

test('`?` matches exactly one non-slash character', () => {
  const re = globToRegExp('a?c');
  assert.equal(re.test('abc'), true);
  // Exactly one: zero characters fails.
  assert.equal(re.test('ac'), false);
  // ...and more than one fails.
  assert.equal(re.test('abbc'), false);
  // The one character may not be a slash.
  assert.equal(re.test('a/c'), false);
});

test('character classes are NOT a supported glob feature: brackets are literal', () => {
  // The doc comment scopes support to `**`, `*`, `?`. `[` and `]` fall into the
  // else-branch and are regex-escaped, so `[ab]` matches the literal text "[ab]"
  // rather than the class {a,b}.
  const re = globToRegExp('f[ab].py');
  assert.equal(re.source, '^f\\[ab\\]\\.py$');
  assert.equal(re.test('fa.py'), false);
  assert.equal(re.test('fb.py'), false);
  assert.equal(re.test('f[ab].py'), true);
});

test('literal segments match exactly, with regex metacharacters escaped', () => {
  const re = globToRegExp('src/main.py');
  assert.equal(re.test('src/main.py'), true);
  // The dot is a literal, not "any character".
  assert.equal(re.test('src/mainXpy'), false);
  assert.equal(re.test('src/other.py'), false);
});

test('the pattern is anchored to the whole string', () => {
  const re = globToRegExp('foo');
  assert.equal(re.test('foo'), true);
  // No leading or trailing slack: it is `^foo$`.
  assert.equal(re.test('foobar'), false);
  assert.equal(re.test('xfoo'), false);
  assert.equal(re.source, '^foo$');
});

// ---------------------------------------------------------------------------
// MemoryFiles — the in-memory ProjectFiles used by the browser and tests.
// ---------------------------------------------------------------------------

test('MemoryFiles.exists sees exact files and directories implied by contents', () => {
  const files = MemoryFiles.from({ 'src/a.py': 'A', 'src/b/c.py': 'C', 'top.txt': 'T' });

  // Exact entries.
  assert.equal(files.exists('src/a.py'), true);
  assert.equal(files.exists('top.txt'), true);

  // A directory exists because something lives under it.
  assert.equal(files.exists('src'), true);
  assert.equal(files.exists('src/b'), true);
  // Trailing slash is tolerated on a directory query.
  assert.equal(files.exists('src/'), true);

  // A partial segment is not a prefix: "s" is not the directory "src".
  assert.equal(files.exists('s'), false);
  assert.equal(files.exists('missing'), false);
  assert.equal(files.exists('src/a'), false);
});

test('MemoryFiles.read returns content for a hit and undefined for a miss', () => {
  const files = MemoryFiles.from({ 'src/a.py': 'print(1)' });
  assert.equal(files.read('src/a.py'), 'print(1)');
  assert.equal(files.read('src/missing.py'), undefined);
  // read never treats an implied directory as readable content.
  assert.equal(files.read('src'), undefined);
});

test('MemoryFiles.glob filters keys by the compiled pattern and returns them sorted', () => {
  const files = MemoryFiles.from({
    'src/b/c.py': 'C',
    'src/a.py': 'A',
    'other.txt': 'T',
  });

  // `**` reaches into subdirectories; results come back sorted.
  assert.deepEqual(files.glob('src/**/*.py'), ['src/a.py', 'src/b/c.py']);
  // A single-segment star does not descend.
  assert.deepEqual(files.glob('src/*.py'), ['src/a.py']);
  // Extension filtering.
  assert.deepEqual(files.glob('*.txt'), ['other.txt']);
  // No match is an empty list, never undefined.
  assert.deepEqual(files.glob('src/**/*.ts'), []);
});
