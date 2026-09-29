import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  exposesSync,
  nextEdgeId,
  proposeCompositionEdge,
  proposeGraphEdge,
} from '../src/canvas/edges.ts';

/**
 * PRD 7: "edge kind inferred from endpoint types". These rules are the inference, and
 * they decide what a drawn connection means — so a mistake here writes the wrong
 * relation into someone's manifest and the canvas draws a lie.
 *
 * They mirror the validator in packages/schema deliberately: the validator refuses a
 * bad edge after the fact, and this refuses the gesture that would create one. The
 * gesture is the better place to say no.
 */

const node = (id: string, type: string, extra: Record<string, unknown> = {}) =>
  ({ id, type, ...extra }) as never;

// --- composition (PRD 4) ---------------------------------------------------

const composition = [
  node('web', 'client', { client: 'web', path: 'web' }),
  node('api', 'boundary', { boundary: 'api', exposes: [] }),
  node('tools', 'boundary', { boundary: 'mcp', exposes: [] }),
  node('classify', 'service', { impl: { entrypoint: 'a.py' } }),
  node('store', 'service', { impl: { entrypoint: 'b.py' } }),
  node('nightly', 'process', { trigger: { kind: 'schedule', cron: '0 3 * * *' } }),
];

test('a client routing to a boundary is routes-to', () => {
  assert.equal(proposeCompositionEdge(composition, { source: 'web', target: 'api' }).kind, 'routes-to');
});

test('a boundary routing to a service is routes-to', () => {
  assert.equal(proposeCompositionEdge(composition, { source: 'api', target: 'classify' }).kind, 'routes-to');
});

test('one service depending on another is depends-on', () => {
  assert.equal(proposeCompositionEdge(composition, { source: 'classify', target: 'store' }).kind, 'depends-on');
});

test('a process depending on a service is depends-on', () => {
  assert.equal(proposeCompositionEdge(composition, { source: 'nightly', target: 'classify' }).kind, 'depends-on');
});

test('nothing points at a client, whatever the source', () => {
  const { kind, refusal } = proposeCompositionEdge(composition, { source: 'classify', target: 'web' });
  assert.equal(kind, '');
  assert.match(refusal!, /nothing routes to it/);
});

test('a client may not skip the boundary', () => {
  const { refusal } = proposeCompositionEdge(composition, { source: 'web', target: 'classify' });
  assert.match(refusal!, /through a boundary, not directly/);
});

test('a boundary exposes services, not other boundaries', () => {
  const { refusal } = proposeCompositionEdge(composition, { source: 'api', target: 'tools' });
  assert.match(refusal!, /not other boundaries/);
});

test('nothing routes to a process, because it has a trigger', () => {
  const { refusal } = proposeCompositionEdge(composition, { source: 'api', target: 'nightly' });
  assert.match(refusal!, /trigger, not a caller/);
});

test('depending on a process is refused too', () => {
  const { refusal } = proposeCompositionEdge(composition, { source: 'classify', target: 'nightly' });
  assert.match(refusal!, /trigger, not a caller/);
});

// --- dataflow (PRD 5) ------------------------------------------------------

const graph = [
  node('document', 'io', { direction: 'in' }),
  node('record', 'io', { direction: 'out' }),
  node('normalize', 'code', { include: [], entrypoint: 'a.py' }),
  node('tools', 'code', { include: [] }),
  node('classifier', 'agent', { name: 'Classifier' }),
  node('enrich', 'subgraph', { ref: 'graphs/e.graph.yaml' }),
];

test('an agent reaching a code node is a capability', () => {
  assert.equal(proposeGraphEdge(graph, { source: 'classifier', target: 'tools' }).kind, 'capability');
});

test('everything else on the dataflow canvas is flow', () => {
  assert.equal(proposeGraphEdge(graph, { source: 'document', target: 'normalize' }).kind, 'flow');
  assert.equal(proposeGraphEdge(graph, { source: 'normalize', target: 'classifier' }).kind, 'flow');
  assert.equal(proposeGraphEdge(graph, { source: 'enrich', target: 'record' }).kind, 'flow');
});

test('an output is a sink and an input is a source', () => {
  // PRD 5 makes io directional precisely so the runner never meets a node that is
  // both, so the canvas must not let one be drawn.
  assert.match(proposeGraphEdge(graph, { source: 'record', target: 'normalize' }).refusal!, /sink/);
  assert.match(proposeGraphEdge(graph, { source: 'normalize', target: 'document' }).refusal!, /source/);
});

test('an agent reaching something that is not code is flow, not capability', () => {
  // A capability edge terminates at a code node (PRD 6.4). Agent → subgraph is
  // ordinary flow.
  assert.equal(proposeGraphEdge(graph, { source: 'classifier', target: 'enrich' }).kind, 'flow');
});

test('a connection to a node that is not there is refused', () => {
  assert.match(proposeGraphEdge(graph, { source: 'ghost', target: 'record' }).refusal!, /not a node/);
});

// --- ids -------------------------------------------------------------------

test('a new edge id does not collide', () => {
  assert.equal(nextEdgeId(['c1', 'c2'], 'c'), 'c3');
  assert.equal(nextEdgeId([], 'e'), 'e1');
  // Gaps are filled rather than skipped past — ids are labels, not a sequence.
  assert.equal(nextEdgeId(['e1', 'e3'], 'e'), 'e2');
});

// --- exposesSync: drawing boundary → service is what exposes it ---------------

const shape = (
  nodes: unknown[],
  edges: { id: string; kind: string; from: string; to: string }[] = [],
) =>
  ({
    spec: {
      nodes,
      edges: edges.map((e) => ({ id: e.id, kind: e.kind, from: { node: e.from }, to: { node: e.to } })),
    },
  }) as never;

const routes = (from: string, to: string) => ({ kind: 'routes-to', from: { node: from }, to: { node: to } });

test('drawing boundary → service appends the service to exposes', () => {
  const ops = exposesSync(shape(composition), { added: [routes('api', 'classify')] });
  assert.deepEqual(ops, [{ op: 'updateNode', id: 'api', patch: { exposes: ['classify'] } }]);
});

test('an already-exposed service produces no op', () => {
  const nodes = [node('api', 'boundary', { boundary: 'api', exposes: ['classify'] }), node('classify', 'service')];
  assert.deepEqual(exposesSync(shape(nodes), { added: [routes('api', 'classify')] }), []);
});

test('edges that are not boundary → service routes-to change nothing', () => {
  assert.deepEqual(exposesSync(shape(composition), { added: [routes('web', 'api')] }), []);
  assert.deepEqual(
    exposesSync(shape(composition), { added: [{ kind: 'depends-on', from: { node: 'classify' }, to: { node: 'store' } }] }),
    [],
  );
  assert.deepEqual(exposesSync(undefined, { added: [routes('api', 'classify')] }), []);
});

test('removing the edge withdraws the service, keeping entries no edge accounts for', () => {
  const nodes = [
    node('api', 'boundary', { boundary: 'api', exposes: ['typed', 'classify'] }),
    node('typed', 'service'),
    node('classify', 'service'),
  ];
  const ops = exposesSync(shape(nodes, [{ id: 'e1', kind: 'routes-to', from: 'api', to: 'classify' }]), {
    removedIds: ['e1'],
  });
  assert.deepEqual(ops, [{ op: 'updateNode', id: 'api', patch: { exposes: ['typed'] } }]);
});

test('a service still reached by another edge stays exposed', () => {
  const nodes = [node('api', 'boundary', { boundary: 'api', exposes: ['classify'] }), node('classify', 'service')];
  const edges = [
    { id: 'e1', kind: 'routes-to', from: 'api', to: 'classify' },
    { id: 'e2', kind: 'routes-to', from: 'api', to: 'classify' },
  ];
  assert.deepEqual(exposesSync(shape(nodes, edges), { removedIds: ['e1'] }), []);
});

test('withdrawing a service drops its invocation override, and the key when it empties', () => {
  const nodes = [
    node('api', 'boundary', { boundary: 'api', exposes: ['a', 'b'], invocation: { a: 'async', b: 'sync' } }),
    node('a', 'service'),
    node('b', 'service'),
  ];
  const edges = [
    { id: 'e1', kind: 'routes-to', from: 'api', to: 'a' },
    { id: 'e2', kind: 'routes-to', from: 'api', to: 'b' },
  ];
  assert.deepEqual(exposesSync(shape(nodes, edges), { removedIds: ['e1'] }), [
    { op: 'updateNode', id: 'api', patch: { exposes: ['b'], invocation: { b: 'sync' } } },
  ]);
  assert.deepEqual(exposesSync(shape(nodes, edges), { removedIds: ['e1', 'e2'] }), [
    { op: 'updateNode', id: 'api', patch: { exposes: [], invocation: null } },
  ]);
});
