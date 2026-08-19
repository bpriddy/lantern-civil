import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
  node('web', 'client', { client: 'frontend', path: 'web' }),
  node('api', 'client', { client: 'api', exposes: [] }),
  node('classify', 'service', { impl: { entrypoint: 'a.py' } }),
  node('store', 'service', { impl: { entrypoint: 'b.py' } }),
  node('nightly', 'process', { trigger: { kind: 'schedule', cron: '0 3 * * *' } }),
];

test('a client routing to a service is routes-to', () => {
  assert.equal(proposeCompositionEdge(composition, { source: 'api', target: 'classify' }).kind, 'routes-to');
});

test('a frontend routing to a boundary is routes-to', () => {
  assert.equal(proposeCompositionEdge(composition, { source: 'web', target: 'api' }).kind, 'routes-to');
});

test('one service depending on another is depends-on', () => {
  assert.equal(proposeCompositionEdge(composition, { source: 'classify', target: 'store' }).kind, 'depends-on');
});

test('a process depending on a service is depends-on', () => {
  assert.equal(proposeCompositionEdge(composition, { source: 'nightly', target: 'classify' }).kind, 'depends-on');
});

test('a service may not point at a client', () => {
  const { kind, refusal } = proposeCompositionEdge(composition, { source: 'classify', target: 'api' });
  assert.equal(kind, '');
  assert.match(refusal!, /never edge targets/);
});

test('nothing routes to a process, because it has a trigger', () => {
  const { refusal } = proposeCompositionEdge(composition, { source: 'api', target: 'nightly' });
  assert.match(refusal!, /trigger, not a caller/);
});

test('only a service can be depended on', () => {
  const { refusal } = proposeCompositionEdge(composition, { source: 'classify', target: 'nightly' });
  assert.match(refusal!, /Only a service can be depended on/);
});

// --- dataflow (PRD 5) ------------------------------------------------------

const graph = [
  node('document', 'io', { direction: 'in' }),
  node('record', 'io', { direction: 'out' }),
  node('normalize', 'code', { include: [], entrypoint: 'a.py' }),
  node('tools', 'code', { include: [] }),
  node('classifier', 'agent', { ref: 'agents/c/agent.yaml' }),
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
