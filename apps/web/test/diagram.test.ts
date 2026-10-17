import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagramToFlow } from '../src/canvas/diagram.ts';

/**
 * A flow or architecture diagram on the canvas (docs/interpretation.md): roles and
 * pieces are faces of their kind, a door descends, a line says what passes, and a
 * loop is drawn like any other line.
 */

const diagram = {
  apiVersion: 'civil/v1',
  kind: 'Diagram',
  metadata: { id: 'overview' },
  spec: {
    nodes: [
      { id: 'user', kind: 'actor', name: 'Shopper', realizedBy: [], evidence: [], decisions: [] },
      { id: 'writer', kind: 'agent', name: 'Digest writer', summary: 'One call; no check.', realizedBy: ['digest'], evidence: ['a.ts:3'], decisions: [{ statement: 'Structured output.', evidence: [] }], confidence: 'high' },
      { id: 'orders', kind: 'flow', name: 'Orders', ref: 'orders', realizedBy: [], evidence: [], decisions: [] },
    ],
    edges: [
      { id: 'e1', from: 'user', to: 'writer', kind: 'next', label: 'a request', evidence: [] },
      { id: 'e2', from: 'writer', to: 'user', kind: 'next', label: 'a draft to confirm', evidence: [], confidence: 'low' },
      { id: 'e3', from: 'writer', to: 'orders', kind: 'uses', evidence: [] },
    ],
  },
  layout: { nodes: { writer: { x: 300, y: 40 } } },
} as never;

test('roles are faces of their kind; a door descends; decisions are counted on the face', () => {
  const { nodes } = diagramToFlow(diagram, 'civil/views/flow/overview.yaml', 'flow', []);
  assert.deepEqual(nodes.map((n) => n.type), ['role', 'role', 'role']);
  const writer = nodes.find((n) => n.id === 'writer')!;
  assert.deepEqual(writer.position, { x: 300, y: 40 });
  assert.equal(writer.data.badge, '1 decision');
  assert.equal(writer.data.detail, 'One call; no check.');
  assert.equal(nodes.find((n) => n.id === 'orders')!.data.descent?.into, 'canvas');
  assert.equal(nodes.find((n) => n.id === 'user')!.data.descent, undefined);
});

test('lines carry what passes for the chip, their kind, and whether they are unsure', () => {
  const { edges } = diagramToFlow(diagram, 'civil/views/flow/overview.yaml', 'flow', []);
  assert.ok(edges.every((e) => e.type === 'labelled'));
  assert.equal(edges.find((e) => e.id === 'e1')!.data!['label'], 'a request');
  assert.ok(edges.some((e) => e.source === 'writer' && e.target === 'user'), 'the loop back is there');
  assert.equal(edges.find((e) => e.id === 'e3')!.data!['kind'], 'uses');
  assert.equal(edges.find((e) => e.id === 'e2')!.data!['uncertain'], true);
});
