import assert from 'node:assert/strict';
import { test } from 'node:test';
import { domainSummary, projectLevel } from '../src/canvas/levels.ts';

/**
 * A level is a projection of the composition (§21): every edge is stored once,
 * between the units it connects, and each level draws it the way it reads from there —
 * as itself, rolled up to a domain, or ending at a stub for what lies outside.
 */

const composition = {
  spec: {
    nodes: [
      { id: 'web', type: 'client', client: 'web', path: 'web' },
      { id: 'api', type: 'boundary', boundary: 'api', exposes: ['orders', 'billing'] },
      { id: 'shop', type: 'domain', name: 'Shop' },
      { id: 'orders', type: 'service', parent: 'shop', impl: { entrypoint: 'o.ts' } },
      { id: 'carts', type: 'service', parent: 'shop', impl: { entrypoint: 'c.ts' } },
      { id: 'base', type: 'domain', name: 'Foundation' },
      { id: 'auth', type: 'domain', name: 'Auth', parent: 'base' },
      { id: 'identity', type: 'service', parent: 'auth', impl: { entrypoint: 'i.ts' } },
      { id: 'billing', type: 'service', parent: 'base', impl: { entrypoint: 'b.ts' } },
      { id: 'db', type: 'datastore', engine: 'postgres' },
    ],
    edges: [
      { id: 'e1', kind: 'routes-to', from: { node: 'web' }, to: { node: 'api' } },
      { id: 'e2', kind: 'routes-to', from: { node: 'api' }, to: { node: 'orders' } },
      { id: 'e3', kind: 'depends-on', from: { node: 'orders' }, to: { node: 'carts' } },
      { id: 'e4', kind: 'depends-on', from: { node: 'orders' }, to: { node: 'db' } },
      { id: 'e5', kind: 'depends-on', from: { node: 'carts' }, to: { node: 'db' } },
      { id: 'e6', kind: 'depends-on', from: { node: 'orders' }, to: { node: 'identity' } },
      { id: 'e7', kind: 'depends-on', from: { node: 'billing' }, to: { node: 'identity' } },
      { id: 'e8', kind: 'routes-to', from: { node: 'api' }, to: { node: 'billing' } },
    ],
  },
} as never;

test('the top level draws its own nodes, and rolls edges up to the domains holding their ends', () => {
  const level = projectLevel(composition);
  assert.deepEqual(level.nodes.map((n: { id: string }) => n.id), ['web', 'api', 'shop', 'base', 'db']);
  const lines = Object.fromEntries(level.edges.map((e) => [`${e.from}->${e.to}`, [e.kind, e.count, e.stored]]));
  assert.deepEqual(lines, {
    'web->api': ['routes-to', 1, true],
    'api->shop': ['routes-to', 1, false],
    'shop->db': ['depends-on', 2, false],
    'shop->base': ['depends-on', 1, false],
    'api->base': ['routes-to', 1, false],
  });
  assert.deepEqual(level.outside, [], 'nothing is outside the top');
});

test('inside a domain: its own edges as they are, and stubs for what lies outside', () => {
  const level = projectLevel(composition, 'shop');
  assert.deepEqual(level.nodes.map((n: { id: string }) => n.id), ['orders', 'carts']);
  const lines = Object.fromEntries(level.edges.map((e) => [`${e.from}->${e.to}`, [e.count, e.stored]]));
  assert.deepEqual(lines, {
    'outside:api->orders': [1, false],
    'orders->carts': [1, true],
    'orders->outside:db': [1, false],
    'carts->outside:db': [1, false],
    // identity is two domains down on the other side: the stub is the highest thing
    // there that does not hold this level.
    'orders->outside:base': [1, false],
  });
  const base = level.outside.find((o) => o.target === 'base')!;
  assert.deepEqual(base.path, ['Foundation']);
  assert.equal(level.outside.find((o) => o.target === 'api')!.side, 'in');
});

test('a nested domain names its stubs through the shared ancestor', () => {
  const level = projectLevel(composition, 'auth');
  assert.deepEqual(level.nodes.map((n: { id: string }) => n.id), ['identity']);
  const targets = level.outside.map((o) => o.target).sort();
  assert.deepEqual(targets, ['billing', 'shop'], 'billing is a sibling inside Foundation; shop is beside it');
  assert.deepEqual(level.outside.find((o) => o.target === 'billing')!.path, ['Foundation', 'billing']);
});

test('a parent that is not a node leaves its child at the level above, never lost', () => {
  const broken = { spec: { nodes: [{ id: 'x', type: 'service', parent: 'ghost', impl: { entrypoint: 'x.ts' } }], edges: [] } } as never;
  assert.deepEqual(projectLevel(broken).nodes.map((n: { id: string }) => n.id), ['x']);
});

test('a domain face counts what it holds directly', () => {
  assert.equal(domainSummary(composition, 'shop'), '2 services');
  assert.equal(domainSummary(composition, 'base'), '1 domain · 1 service');
  assert.equal(domainSummary(composition, 'auth'), '1 service');
});
