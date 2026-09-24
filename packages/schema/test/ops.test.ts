import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  opTargetId,
  zCompositionOp,
  zCompositionOpBatch,
  zGraphOp,
  zGraphOpBatch,
} from '../dist/index.js';

// ---------------------------------------------------------------------------
// PRD 7.1 — mutations are structured ops, discriminated on `op`. The same
// vocabulary serves both canvases; only the node/edge payloads differ.
// ---------------------------------------------------------------------------

const ioNode = { id: 'in', type: 'io', direction: 'in' };
const graphEdge = { id: 'e1', kind: 'flow', from: { node: 'a' }, to: { node: 'b' } };
const boundaryNode = { id: 'api', type: 'boundary', boundary: 'api', exposes: [] };

test('every op in the graph vocabulary parses when well-formed', () => {
  const ok = (op: unknown) => {
    const r = zGraphOp.safeParse(op);
    assert.ok(r.success, `expected ${JSON.stringify(op)} to parse: ${!r.success ? JSON.stringify(r.error.issues) : ''}`);
    return r;
  };

  ok({ op: 'addNode', node: ioNode });
  ok({ op: 'addEdge', edge: graphEdge });
  ok({ op: 'updateNode', id: 'a', patch: { name: 'X' } });
  ok({ op: 'updateEdge', id: 'e1', patch: {} });
  ok({ op: 'removeEdge', id: 'e1' });
});

test('removeNode and renameNode fill in their booleans by default', () => {
  const removed = zGraphOp.parse({ op: 'removeNode', id: 'a' });
  // Without a cascade the removal would leave dangling edges, so it defaults on.
  assert.equal(removed.op === 'removeNode' && removed.cascadeEdges, true);

  const removedOff = zGraphOp.parse({ op: 'removeNode', id: 'a', cascadeEdges: false });
  assert.equal(removedOff.op === 'removeNode' && removedOff.cascadeEdges, false);

  const renamed = zGraphOp.parse({ op: 'renameNode', from: 'a', to: 'b' });
  // updateReferences defaults on so the rename is atomic.
  assert.equal(renamed.op === 'renameNode' && renamed.updateReferences, true);
});

test('setLayout carries x/y (layout only) and rejects a missing coordinate', () => {
  const laid = zGraphOp.parse({ op: 'setLayout', id: 'a', x: 12, y: -4 });
  assert.equal(laid.op, 'setLayout');
  assert.equal(laid.op === 'setLayout' && laid.x, 12);
  assert.equal(laid.op === 'setLayout' && laid.y, -4);

  const bad = zGraphOp.safeParse({ op: 'setLayout', id: 'a' });
  assert.equal(bad.success, false);
  if (!bad.success) {
    // Both coordinates are required.
    assert.deepEqual(
      bad.error.issues.map((i) => i.path.join('.')).sort(),
      ['x', 'y'],
    );
  }
});

test('an unknown op is rejected at the discriminator', () => {
  const r = zGraphOp.safeParse({ op: 'frobnicate', id: 'a' });
  assert.equal(r.success, false);
  if (!r.success) {
    assert.equal(r.error.issues[0]!.code, 'invalid_union_discriminator');
    assert.deepEqual(r.error.issues[0]!.path, ['op']);
  }
});

test('an op with no discriminator at all is rejected', () => {
  const r = zGraphOp.safeParse({ id: 'a' });
  assert.equal(r.success, false);
  if (!r.success) assert.equal(r.error.issues[0]!.code, 'invalid_union_discriminator');
});

test('the op payload is validated: a bad node id is caught under the node', () => {
  const r = zGraphOp.safeParse({ op: 'addNode', node: { id: 'NotLower', type: 'io', direction: 'in' } });
  assert.equal(r.success, false);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    // The error is scoped to the node's id, not the op as a whole.
    assert.deepEqual(issue.path, ['node', 'id']);
  }
});

test('updateNode requires a patch object', () => {
  assert.equal(zGraphOp.safeParse({ op: 'updateNode', id: 'a' }).success, false);
  assert.equal(zGraphOp.safeParse({ op: 'updateNode', id: 'a', patch: 'nope' }).success, false);
});

// ---------------------------------------------------------------------------
// The discriminated-union boundary: same op names, canvas-specific payloads.
// ---------------------------------------------------------------------------

test('graph and composition ops accept each other\'s op names but not each other\'s node payloads', () => {
  // A graph io node is not a legal composition node...
  const wrong = zCompositionOp.safeParse({ op: 'addNode', node: ioNode });
  assert.equal(wrong.success, false);
  if (!wrong.success) assert.deepEqual(wrong.error.issues[0]!.path, ['node', 'type']);

  // ...and a composition service node is not a legal graph node.
  const alsoWrong = zGraphOp.safeParse({
    op: 'addNode',
    node: { id: 'svc', type: 'service', impl: { entrypoint: 'src/s.py' } },
  });
  assert.equal(alsoWrong.success, false);
  if (!alsoWrong.success) assert.deepEqual(alsoWrong.error.issues[0]!.path, ['node', 'type']);

  // The same addNode op is fine once the payload matches the canvas.
  assert.equal(zCompositionOp.safeParse({ op: 'addNode', node: boundaryNode }).success, true);
});

// ---------------------------------------------------------------------------
// Batches: at least one op, and every member must be valid.
// ---------------------------------------------------------------------------

test('op batches require at least one op and reject any invalid member', () => {
  assert.equal(zGraphOpBatch.safeParse({ ops: [{ op: 'addNode', node: ioNode }] }).success, true);
  assert.equal(zCompositionOpBatch.safeParse({ ops: [{ op: 'addNode', node: boundaryNode }] }).success, true);

  // Empty batch.
  const empty = zGraphOpBatch.safeParse({ ops: [] });
  assert.equal(empty.success, false);
  if (!empty.success) {
    assert.equal(empty.error.issues[0]!.code, 'too_small');
    assert.deepEqual(empty.error.issues[0]!.path, ['ops']);
  }

  // One rotten op poisons the batch.
  assert.equal(
    zGraphOpBatch.safeParse({ ops: [{ op: 'addNode', node: ioNode }, { op: 'nope' }] }).success,
    false,
  );
});

// ---------------------------------------------------------------------------
// opTargetId — the node/edge id each op touches, used to attach diagnostics.
// ---------------------------------------------------------------------------

test('opTargetId reports the id each op kind touches', () => {
  assert.equal(opTargetId(zGraphOp.parse({ op: 'addNode', node: { ...ioNode, id: 'n1' } })), 'n1');
  assert.equal(opTargetId(zGraphOp.parse({ op: 'addEdge', edge: { ...graphEdge, id: 'ed1' } })), 'ed1');
  assert.equal(opTargetId(zGraphOp.parse({ op: 'renameNode', from: 'src', to: 'dst' })), 'src');
  assert.equal(opTargetId(zGraphOp.parse({ op: 'removeNode', id: 'rn1' })), 'rn1');
  assert.equal(opTargetId(zGraphOp.parse({ op: 'removeEdge', id: 're1' })), 're1');
  assert.equal(opTargetId(zGraphOp.parse({ op: 'updateNode', id: 'un1', patch: {} })), 'un1');
  assert.equal(opTargetId(zGraphOp.parse({ op: 'updateEdge', id: 'ue1', patch: {} })), 'ue1');
  assert.equal(opTargetId(zGraphOp.parse({ op: 'setLayout', id: 'sl1', x: 0, y: 0 })), 'sl1');
});
