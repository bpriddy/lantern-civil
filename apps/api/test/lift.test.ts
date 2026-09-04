import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { emittedHistory } from '../dist/project/transpile.js';
import { liftEdgesToOps } from '../dist/http/transpile-routes.js';

/**
 * Lift's two pure seams: the provenance the drift check reads (every content ever
 * emitted, not just the latest), and the edge diff that turns a lifted flow set
 * into ops — idempotent, capability-preserving, collision-free ids.
 */

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

test('emittedHistory unions content hashes across all rows, per path', async () => {
  const pool = {
    query: async () => ({
      rows: [
        { output: { files: { 'graphs/x.py': 'A', 'src/h.py': 'H' } } },
        { output: { files: { 'graphs/x.py': 'B' } } }, // x cycled A -> B
      ],
    }),
  } as never;
  const history = await emittedHistory(pool, 'o', 'p');
  assert.deepEqual(history.get('graphs/x.py'), new Set([hash('A'), hash('B')]), 'x carries both emissions');
  assert.deepEqual(history.get('src/h.py'), new Set([hash('H')]), 'h carries its one emission');
  // A file matching an OLDER emission is still Civil's own, not drift.
  assert.ok(history.get('graphs/x.py')!.has(hash('A')), 'the return-to-A content is recognized');
});

const flowEdge = (id: string, from: string, to: string) =>
  ({ id, kind: 'flow', from: { node: from }, to: { node: to } }) as never;
const capEdge = (id: string, from: string, to: string, fn: string) =>
  ({ id, kind: 'capability', from: { node: from }, to: { node: to, function: fn } }) as never;

test('lifting the current flow set is a no-op', () => {
  const edges = [flowEdge('e1', 'a', 'b'), flowEdge('e2', 'b', 'c')];
  const { ops, added, removed } = liftEdgesToOps(edges, [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
  ]);
  assert.equal(ops.length, 0, 'no ops for an unchanged graph');
  assert.equal(added, 0);
  assert.equal(removed, 0);
});

test('a reordered/edited run() adds the new edges and removes the gone ones', () => {
  // Code now goes a -> c -> b instead of a -> b -> c.
  const edges = [flowEdge('e1', 'a', 'b'), flowEdge('e2', 'b', 'c')];
  const { ops, added, removed } = liftEdgesToOps(edges, [
    { from: 'a', to: 'c' },
    { from: 'c', to: 'b' },
  ]);
  assert.equal(removed, 2, 'both old flow edges go');
  assert.equal(added, 2, 'both new flow edges arrive');
  const addIds = ops.filter((o) => o.op === 'addEdge').map((o) => (o as { edge: { id: string } }).edge.id);
  assert.ok(!addIds.includes('e1') && !addIds.includes('e2'), 'new ids avoid the existing ones');
});

test('capability edges are never touched', () => {
  const edges = [flowEdge('e1', 'a', 'b'), capEdge('e2', 'agent', 'tools', 'search')];
  // Lift returns only flow; the capability edge must survive with no op about it.
  const { ops } = liftEdgesToOps(edges, [{ from: 'a', to: 'b' }]);
  assert.equal(ops.length, 0, 'the flow edge matches and the capability edge is left alone');
});

test('minted ids skip every id in the document, flow or capability', () => {
  const edges = [capEdge('e1', 'agent', 'tools', 'search')]; // e1 taken by a capability edge
  const { ops } = liftEdgesToOps(edges, [{ from: 'a', to: 'b' }]);
  const addId = (ops.find((o) => o.op === 'addEdge') as { edge: { id: string } }).edge.id;
  assert.notEqual(addId, 'e1', 'a new flow id does not collide with the capability edge');
});
