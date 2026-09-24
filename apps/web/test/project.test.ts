import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnosticsByNode, isAbortError, isContract } from '../src/project.ts';

/**
 * The pure helpers in project.ts. The fetch-based client functions (fetchBundle,
 * liftGraph, …) need a network and are exercised elsewhere; these three are plain
 * data transforms, and everything downstream trusts them:
 *
 *  - isContract decides whether a node draws its discovered ports or an error, so a
 *    wrong answer either hides a contract or renders `{ error }` as if it were one.
 *  - isAbortError is what keeps a cancelled load from surfacing as a failure the user
 *    did not cause (project.ts: React runs cleanup immediately in development).
 *  - diagnosticsByNode is the lookup PRD 6.4 renders on the offending node.
 */

// --- isContract ------------------------------------------------------------

const contract = {
  name: 'classify',
  description: null,
  isAsync: false,
  inputs: [],
  output: { type: null, schema: null },
};

test('a well-formed contract is a contract', () => {
  assert.equal(isContract(contract as never), true);
});

test('an error result is not a contract', () => {
  assert.equal(isContract({ error: 'could not parse' }), false);
});

test('the absent contract is not a contract', () => {
  // undefined means "nothing to read", which must not read as a contract with no
  // arguments — the face has to fall back to showing nothing instead.
  assert.equal(isContract(undefined), false);
});

test('the guard keys off the error property, not its value', () => {
  // ContractResult is a union: the presence of `error` is the discriminant. An entry
  // carrying the key at all is the error arm, whatever it holds.
  assert.equal(isContract({ error: undefined } as never), false);
});

// --- isAbortError ----------------------------------------------------------

test('an aborted request is recognised', () => {
  assert.equal(isAbortError(new DOMException('aborted', 'AbortError')), true);
});

test('a different DOMException is not an abort', () => {
  assert.equal(isAbortError(new DOMException('missing', 'NotFoundError')), false);
});

test('a plain Error named AbortError is not an abort', () => {
  // The check is deliberately instanceof DOMException, not a name match: only the
  // real cancellation should be swallowed, never an error that merely borrows the name.
  assert.equal(isAbortError(new Error('AbortError')), false);
});

test('non-errors are not aborts', () => {
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError('AbortError'), false);
});

// --- diagnosticsByNode -----------------------------------------------------

const diag = (over: Record<string, unknown>) =>
  ({
    file: 'graphs/main.graph.yaml',
    jsonPointer: '',
    code: 'invalid-manifest',
    severity: 'error',
    message: 'x',
    ...over,
  }) as never;

test('diagnostics are grouped by the node they name', () => {
  const map = diagnosticsByNode(
    [
      diag({ nodeId: 'n1', message: 'first' }),
      diag({ nodeId: 'n1', message: 'second' }),
      diag({ nodeId: 'n2', message: 'other' }),
    ],
    'graphs/main.graph.yaml',
  );
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('n1')?.map((d) => d.message), ['first', 'second']);
  assert.deepEqual(map.get('n2')?.map((d) => d.message), ['other']);
});

test('diagnostics from other files are excluded', () => {
  // The bundle carries every file's diagnostics at once; a lookup for one manifest
  // must not render another manifest's problems on a like-named node.
  const map = diagnosticsByNode(
    [
      diag({ nodeId: 'n1', message: 'mine' }),
      diag({ file: 'graphs/other.graph.yaml', nodeId: 'n1', message: 'theirs' }),
    ],
    'graphs/main.graph.yaml',
  );
  assert.deepEqual(map.get('n1')?.map((d) => d.message), ['mine']);
});

test('a diagnostic with no node is not placed on the canvas', () => {
  // File-level problems (a manifest that will not parse at all) have no node to sit
  // on; they are skipped here rather than crashing the lookup.
  const map = diagnosticsByNode(
    [diag({ message: 'file is unparseable' })],
    'graphs/main.graph.yaml',
  );
  assert.equal(map.size, 0);
});

test('an empty diagnostic set yields an empty map', () => {
  const map = diagnosticsByNode([], 'graphs/main.graph.yaml');
  assert.ok(map instanceof Map);
  assert.equal(map.size, 0);
});
