import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DIAGNOSTIC_CODES,
  blocksRun,
  diagnosticsFor,
  isFatal,
} from '../dist/index.js';

// A minimal Diagnostic factory: full-shaped by default, overridable per field.
const diag = (over: Record<string, unknown> = {}) => ({
  file: 'app.yaml',
  jsonPointer: '',
  code: 'invalid-manifest',
  message: 'something is wrong',
  severity: 'error',
  ...over,
});

// ---------------------------------------------------------------------------
// The code vocabulary is the contract other packages match against.
// ---------------------------------------------------------------------------

test('DIAGNOSTIC_CODES is a unique, complete vocabulary', () => {
  // No accidental duplicates.
  assert.equal(new Set(DIAGNOSTIC_CODES).size, DIAGNOSTIC_CODES.length);

  // The distinctive codes the validators emit are all present.
  for (const code of [
    'invalid-manifest',
    'duplicate-id',
    'unresolved-ref',
    'unresolved-entrypoint',
    'flow-cycle',
    'subgraph-cycle',
    'io-direction-violation',
  ]) {
    assert.ok(DIAGNOSTIC_CODES.includes(code), `expected ${code} in the vocabulary`);
  }

  // And a code that was never defined is absent.
  assert.equal(DIAGNOSTIC_CODES.includes('not-a-real-code'), false);
});

// ---------------------------------------------------------------------------
// isFatal — PRD 6.4's error/run-blocking distinction.
// ---------------------------------------------------------------------------

test('isFatal is true only when some diagnostic is an error', () => {
  assert.equal(isFatal([]), false);
  assert.equal(isFatal([diag({ severity: 'run-blocking' })]), false);
  assert.equal(isFatal([diag({ severity: 'error' })]), true);
  // Any error among run-blockers still makes the set fatal.
  assert.equal(
    isFatal([diag({ severity: 'run-blocking' }), diag({ severity: 'error' })]),
    true,
  );
});

// ---------------------------------------------------------------------------
// blocksRun — any diagnostic at all blocks Run, even a non-fatal one.
// ---------------------------------------------------------------------------

test('blocksRun is true whenever there is any diagnostic', () => {
  assert.equal(blocksRun([]), false);
  assert.equal(blocksRun([diag({ severity: 'run-blocking' })]), true);
  assert.equal(blocksRun([diag({ severity: 'error' })]), true);
});

test('a run-blocking-only set blocks Run without being fatal', () => {
  // The whole point of the two severities: a flow cycle saves fine but stops Run.
  const ds = [diag({ code: 'flow-cycle', severity: 'run-blocking' })];
  assert.equal(blocksRun(ds), true);
  assert.equal(isFatal(ds), false);
});

// ---------------------------------------------------------------------------
// diagnosticsFor — the per-node filter the UI uses to render on a node face.
// ---------------------------------------------------------------------------

test('diagnosticsFor returns exactly the diagnostics carrying that nodeId', () => {
  const ds = [
    diag({ code: 'duplicate-id', nodeId: 'a' }),
    diag({ code: 'unresolved-ref', nodeId: 'b' }),
    diag({ code: 'flow-cycle', nodeId: 'a' }),
    // An edge-scoped diagnostic (no nodeId) must never be attributed to a node.
    diag({ code: 'unknown-node', edgeId: 'e1' }),
  ];

  const forA = diagnosticsFor(ds, 'a');
  assert.equal(forA.length, 2);
  assert.deepEqual(forA.map((d) => d.code).sort(), ['duplicate-id', 'flow-cycle']);

  assert.deepEqual(diagnosticsFor(ds, 'b').map((d) => d.code), ['unresolved-ref']);
  // A node with nothing against it gets an empty list.
  assert.deepEqual(diagnosticsFor(ds, 'nobody'), []);
});
