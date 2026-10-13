import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { skeletonToDocuments } from '../dist/lift/to-documents.js';
import { skeleton, files } from './fixtures-shop.ts';

/**
 * Views (prd-deltas §21): the composition holds every part once; each view groups and
 * places them in its own files. Written fresh on a first lift; on Update the author's
 * arrangement wins and only what is new is placed.
 */

const lift = (existing: Record<string, string> = {}, s = skeleton()) =>
  skeletonToDocuments(s, { projectName: 'Shop', existing, refinement: null, repo: files, listed: Object.keys(files) });

test('the composition holds the parts; the concept and architecture views group them', () => {
  const out = lift();
  const errors = out.diagnostics.filter((d) => d.startsWith('error'));
  assert.deepEqual(errors, []);
  const app = parse(out.files['civil/app.yaml']!);
  assert.ok(app.spec.nodes.every((n: Record<string, unknown>) => n['type'] !== 'domain' && n['parent'] === undefined), 'app.yaml has no grouping');
  const concept = Object.keys(out.files).filter((p) => p.startsWith('civil/views/concept/')).sort();
  assert.deepEqual(concept, [
    'civil/views/concept/catalog-domain.yaml',
    'civil/views/concept/foundation.yaml',
    'civil/views/concept/orders-domain.yaml',
    'civil/views/concept/view.yaml',
  ], 'a capability of one service (users) is drawn as the service: no domain file');
  const catalog = parse(out.files['civil/views/concept/catalog-domain.yaml']!);
  assert.equal(catalog.metadata.name, 'Catalog');
  assert.deepEqual(catalog.spec.members, ['catalog', 'reindex', 'reviews']);
  assert.ok(catalog.spec.evidence.includes('apps/web/src/features/catalog'), 'the surface is the evidence');
  const view = parse(out.files['civil/views/concept/view.yaml']!);
  assert.equal(view.spec.unplaced, 'hide', 'the concept view leaves clients and boundaries to the architecture view');
  assert.deepEqual(view.spec.members, ['db', 'users']);

  // A schedule that runs no product code is how the app is run, not what it is.
  const s = skeleton();
  s.processes.push({ id: 'scale-down', schedule: '0 20 * * *', calls: [], source: { file: 'infra/main.tf' } });
  const ops = parse(lift({}, s).files['civil/views/concept/view.yaml']!);
  assert.ok(!ops.spec.members.includes('scale-down'));
  assert.ok(Object.keys(out.files).some((p) => p === 'civil/views/architecture/view.yaml'), 'the architecture view is written');
  assert.match(out.files['civil/architecture.md']!, /## Views[\s\S]*### Concept[\s\S]*\*\*Catalog\*\*/);
});

test('Update keeps the author\'s arrangement and places only what is new', () => {
  const first = lift().files;
  // The author moves reviews from Catalog to Orders.
  const moved = { ...first };
  moved['civil/views/concept/catalog-domain.yaml'] = first['civil/views/concept/catalog-domain.yaml']!.replace('members: [catalog, reindex, reviews]', 'members: [catalog, reindex]');
  moved['civil/views/concept/orders-domain.yaml'] = first['civil/views/concept/orders-domain.yaml']!.replace('members: [orders, payments]', 'members: [orders, payments, reviews]');
  const again = lift(moved).files;
  for (const path of Object.keys(moved).filter((p) => p.startsWith('civil/views/'))) {
    assert.equal(again[path], moved[path], `${path} is unchanged`);
  }

  // A new service only orders uses: placed in Orders, the rest untouched.
  const s = skeleton();
  s.services.push({ ...s.services.find((x) => x.id === 'payments')!, id: 'refunds', directory: 'apps/api/src/modules/refunds', source: { file: 'apps/api/src/modules/refunds/index.ts' }, dependsOn: [] });
  s.services.find((x) => x.id === 'orders')!.dependsOn.push('refunds');
  const grown = skeletonToDocuments(s, {
    projectName: 'Shop', existing: moved, refinement: null,
    repo: { ...files, 'apps/api/src/modules/refunds/index.ts': 'export const m = 1;\n' }, listed: [...Object.keys(files), 'apps/api/src/modules/refunds/index.ts'],
  });
  const orders = parse(grown.files['civil/views/concept/orders-domain.yaml']!);
  assert.deepEqual(orders.spec.members, ['orders', 'payments', 'reviews', 'refunds']);
  assert.ok(orders.layout.nodes.refunds, 'the new part is given a place');
  assert.equal(grown.files['civil/views/concept/catalog-domain.yaml'], moved['civil/views/concept/catalog-domain.yaml']);
  assert.ok(grown.diagnostics.some((d) => /placed 1 new part in the Concept view/.test(d)));
});
