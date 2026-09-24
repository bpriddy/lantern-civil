import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { applyOps } from '../dist/manifest/apply.js';

/**
 * ops.test.ts already covers applyOps thoroughly — every op kind, comment/quote
 * preservation, and most refusals. This file adds ONLY the gaps left after that:
 * error paths and one style path that ops.test.ts does not reach. Anything already
 * exercised there is deliberately not repeated.
 */

function reparse(source: string, what: string): any {
  try {
    return parse(source);
  } catch (error) {
    return assert.fail(`${what} produced unparseable YAML: ${(error as Error).message}`);
  }
}

const WITH_LAYOUT = [
  'apiVersion: civil/v1',
  'kind: Composition',
  'metadata:',
  '  id: demo',
  'spec:',
  '  nodes:',
  '    - id: a',
  '      type: service',
  '      impl: { entrypoint: a.py }',
  '    - id: b',
  '      type: service',
  '      impl: { entrypoint: b.py }',
  '  edges:',
  '    - { id: c1, kind: flow, from: { node: a }, to: { node: b } }',
  'layout:',
  '  nodes:',
  '    a: { x: 1, y: 2 }',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Missing-id refusals for the add ops. ops.test covers addNode's, not addEdge's.

test('an edge with no id is refused', () => {
  assert.throws(
    () => applyOps(WITH_LAYOUT, [{ op: 'addEdge', edge: { kind: 'flow', from: { node: 'a' }, to: { node: 'b' } } }]),
    /an edge needs an id/,
  );
});

// ---------------------------------------------------------------------------
// setLayout onto a manifest that has no layout block at all.

test('setLayout is refused when the manifest has no layout.nodes block', () => {
  const noLayout = ['apiVersion: civil/v1', 'kind: Composition', 'spec:', '  nodes: []', '  edges: []', ''].join('\n');
  assert.throws(
    () => applyOps(noLayout, [{ op: 'setLayout', id: 'a', x: 1, y: 2 }]),
    /no layout.nodes block/,
  );
});

// ---------------------------------------------------------------------------
// updateNode / updateEdge refusals ops.test does not reach.

test('an empty patch is refused', () => {
  assert.throws(
    () => applyOps(WITH_LAYOUT, [{ op: 'updateNode', id: 'a', patch: {} }]),
    /an empty patch changes nothing/,
  );
});

test('a patch that only nulls a field the node lacks is refused', () => {
  // nulling an absent key removes nothing and sets nothing, so there is no edit to make.
  assert.throws(
    () => applyOps(WITH_LAYOUT, [{ op: 'updateNode', id: 'a', patch: { doesNotExist: null } }]),
    /nothing in that patch applies to/,
  );
});

test('updating a node that is not there is refused', () => {
  assert.throws(
    () => applyOps(WITH_LAYOUT, [{ op: 'updateNode', id: 'ghost', patch: { name: 'X' } }]),
    /no item with id "ghost"/,
  );
});

test('patching an edge id is refused, with an edge-specific message', () => {
  // The node path says "use renameNode"; the edge path has no rename, so its message
  // differs — and only the node message is checked in ops.test.
  assert.throws(
    () => applyOps(WITH_LAYOUT, [{ op: 'updateEdge', id: 'c1', patch: { id: 'c2' } }]),
    /an edge id cannot be patched/,
  );
});

// ---------------------------------------------------------------------------
// renameNode with references left alone — the non-default branch.

test('renameNode with updateReferences:false renames only the node itself', () => {
  const { source: after, summary } = applyOps(WITH_LAYOUT, [
    { op: 'renameNode', from: 'a', to: 'z', updateReferences: false },
  ]);

  const parsed = reparse(after, 'rename without reference updates') as {
    spec: { nodes: { id: string }[]; edges: { from: { node: string }; to: { node: string } }[] };
    layout: { nodes: Record<string, unknown> };
  };
  assert.ok(parsed.spec.nodes.some((n) => n.id === 'z'), 'the node id was not changed');
  assert.ok(!parsed.spec.nodes.some((n) => n.id === 'a'));
  // References are intentionally left dangling: the edge and layout still say "a".
  assert.equal(parsed.spec.edges[0]!.from.node, 'a', 'an edge endpoint was rewritten anyway');
  assert.ok('a' in parsed.layout.nodes, 'the layout key was rewritten anyway');
  // With nothing else touched, the summary reports no reference count.
  assert.ok(!/reference/.test(summary), `summary claimed references were updated: ${summary}`);
});

// ---------------------------------------------------------------------------
// Adding into an inline flow `[ ... ]` list — the itemPrefix === ', ' path. ops.test
// removes from inline lists but never adds to one, so this join style is untested.

test('addEdge appends into an inline flow list and stays inline', () => {
  const source = [
    'spec:',
    '  nodes: []',
    '  edges: [{ id: e1, kind: flow, from: { node: a }, to: { node: b } }]',
    '',
  ].join('\n');
  const { source: after } = applyOps(source, [
    { op: 'addEdge', edge: { id: 'e2', kind: 'flow', from: { node: 'b' }, to: { node: 'c' } } },
  ]);
  const parsed = reparse(after, 'addEdge into an inline flow list') as { spec: { edges: { id: string }[] } };
  assert.deepEqual(parsed.spec.edges.map((e) => e.id), ['e1', 'e2']);
  // It joined the existing brackets rather than breaking out into a block dash item.
  assert.ok(/edges: \[\{ id: e1.*\}, \{ id: e2.*\}\]/.test(after), `not appended inline:\n${after}`);
  assert.ok(!/\n\s+- /.test(after.slice(after.indexOf('edges:'))), 'a block dash item was introduced');
});

test('addNode appends into an inline flow list and stays inline', () => {
  const source = ['spec:', '  nodes: [{ id: a, type: service }]', '  edges: []', ''].join('\n');
  const { source: after } = applyOps(source, [
    { op: 'addNode', node: { id: 'b', type: 'service' } },
  ]);
  const parsed = reparse(after, 'addNode into an inline flow list') as { spec: { nodes: { id: string }[] } };
  assert.deepEqual(parsed.spec.nodes.map((n) => n.id), ['a', 'b']);
  assert.ok(/nodes: \[\{ id: a, type: service \}, \{ id: b, type: service \}\]/.test(after), `not inline:\n${after}`);
});
