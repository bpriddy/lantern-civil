import assert from 'node:assert/strict';
import { test } from 'node:test';
import { domainSummary, projectLevel, type LoadedView } from '../src/canvas/levels.ts';

/**
 * A level is a projection of the composition through a view (§21): every edge is
 * stored once, between the parts it connects, and each level of each view draws it the
 * way it reads from there — as itself, rolled up to a domain, ending at a stub for what
 * lies outside, or not at all when the view hides an end.
 */

const composition = {
  spec: {
    nodes: [
      { id: 'web', type: 'client', client: 'web', path: 'web' },
      { id: 'api', type: 'boundary', boundary: 'api', exposes: ['orders', 'billing'] },
      { id: 'orders', type: 'service', impl: { entrypoint: 'o.ts' } },
      { id: 'carts', type: 'service', impl: { entrypoint: 'c.ts' } },
      { id: 'identity', type: 'service', impl: { entrypoint: 'i.ts' } },
      { id: 'billing', type: 'service', impl: { entrypoint: 'b.ts' } },
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
  layout: { nodes: { web: { x: 1, y: 2 } } },
} as never;

const domain = (id: string, name: string, members: string[], parent?: string) => ({
  path: `civil/views/concept/${id}.yaml`,
  doc: {
    apiVersion: 'civil/v1', kind: 'Domain', metadata: { id, name },
    spec: { members, ...(parent ? { parent } : {}) }, layout: { nodes: { [members[0] ?? 'x']: { x: 5, y: 6 } } },
  },
});

const view = (unplaced: 'hide' | 'top', members: string[] = ['db']): LoadedView => ({
  path: 'civil/views/concept/view.yaml',
  view: { apiVersion: 'civil/v1', kind: 'View', metadata: { id: 'concept', name: 'Concept' }, spec: { members, unplaced }, layout: { nodes: { shop: { x: 9, y: 9 } } } },
  domains: {
    shop: domain('shop', 'Shop', ['orders', 'carts']),
    base: domain('base', 'Foundation', ['billing']),
    auth: domain('auth', 'Auth', ['identity'], 'base'),
  },
} as never);

const ids = (level: ReturnType<typeof projectLevel>) =>
  level.items.map((i) => (i.kind === 'domain' ? i.domain.id : i.node.id)).sort();
const lines = (level: ReturnType<typeof projectLevel>) =>
  Object.fromEntries(level.edges.map((e) => [`${e.from}->${e.to}`, [e.kind, e.count, e.stored]]));

test('without a view, every part is at the top, placed by the composition', () => {
  const level = projectLevel(composition, 'civil/app.yaml');
  assert.equal(level.items.length, 7);
  assert.equal(level.layoutPath, 'civil/app.yaml');
  assert.deepEqual(level.layout, { web: { x: 1, y: 2 } });
});

test('a view that hides what it does not place: domains and its own members at the top, lines rolled up', () => {
  const level = projectLevel(composition, 'civil/app.yaml', view('hide'));
  assert.deepEqual(ids(level), ['base', 'db', 'shop'], 'web and api are not placed, so not drawn');
  assert.deepEqual(lines(level), {
    'shop->db': ['depends-on', 2, false],
    'shop->base': ['depends-on', 1, false],
  }, 'lines to hidden parts are not drawn');
  assert.equal(level.layoutPath, 'civil/views/concept/view.yaml');
  assert.deepEqual(level.layout, { shop: { x: 9, y: 9 } });
});

test('a view that shows what it does not place puts it at the top', () => {
  const level = projectLevel(composition, 'civil/app.yaml', view('top'));
  assert.deepEqual(ids(level), ['api', 'base', 'db', 'shop', 'web']);
  assert.deepEqual(lines(level)['api->shop'], ['routes-to', 1, false]);
  assert.deepEqual(lines(level)['web->api'], ['routes-to', 1, true]);
});

test('inside a domain: its own edges as they are, and stubs for what lies outside', () => {
  const level = projectLevel(composition, 'civil/app.yaml', view('top'), 'shop');
  assert.deepEqual(ids(level), ['carts', 'orders']);
  assert.deepEqual(lines(level), {
    'outside:api->orders': ['routes-to', 1, false],
    'orders->carts': ['depends-on', 1, true],
    'orders->outside:db': ['depends-on', 1, false],
    'carts->outside:db': ['depends-on', 1, false],
    'orders->outside:base': ['depends-on', 1, false],
  });
  assert.deepEqual(level.outside.find((o) => o.target === 'base')!.path, ['Foundation']);
  assert.equal(level.outside.find((o) => o.target === 'api')!.side, 'in');
  assert.equal(level.layoutPath, 'civil/views/concept/shop.yaml', 'a domain places its own inside');
});

test('a nested domain names its stubs through the shared ancestor', () => {
  const level = projectLevel(composition, 'civil/app.yaml', view('top'), 'auth');
  assert.deepEqual(ids(level), ['identity']);
  assert.deepEqual(level.outside.map((o) => o.target).sort(), ['billing', 'shop']);
  assert.deepEqual(level.outside.find((o) => o.target === 'billing')!.path, ['Foundation', 'billing']);
});

test('a domain face counts what it holds directly', () => {
  assert.equal(domainSummary(composition, view('top'), 'shop'), '2 services');
  assert.equal(domainSummary(composition, view('top'), 'base'), '1 domain · 1 service');
});
