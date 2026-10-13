import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildContainment, MAX_CHILDREN } from '../dist/lift/containment.js';
import { skeleton, files } from './fixtures-shop.ts';

/**
 * Containment (docs/lift-repo.md, "Levels"): the domains a lifted graph is drawn in,
 * found by what the code reaches. A synthetic shop: a web client with one directory per
 * feature, an API with a module per service, and a contracts package both sides import.
 */

test('a surface and the service it shares a contract with are one capability, with what only it uses', () => {
  const c = buildContainment(skeleton(), files);
  const byName = Object.fromEntries(c.domains.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(byName).sort(), ['Catalog', 'Foundation', 'Orders', 'Users']);
  // Reviews is used only by catalog, so it is inside it; the schedule that runs catalog's code goes with it.
  assert.deepEqual(byName['Catalog']!.members, ['catalog', 'reindex', 'reviews']);
  assert.deepEqual(byName['Catalog']!.surfaces, ['apps/web/src/features/catalog']);
  // The checkout screen talks to orders: shared reach, not a shared name, makes them one.
  assert.deepEqual(byName['Orders']!.members, ['orders', 'payments']);
  assert.deepEqual(byName['Orders']!.surfaces, ['apps/web/src/features/checkout']);
  // What several capabilities use is the shared foundation.
  assert.deepEqual(byName['Foundation']!.members, ['audit', 'auth', 'mail', 'storage']);
  assert.equal(byName['Foundation']!.foundation, true);
  // A capability of one service is still a capability (the mapper draws it as the
  // service). A store several use stays at the top, beside the client and the API.
  assert.deepEqual(byName['Users']!.members, ['users']);
  assert.deepEqual(byName['Users']!.surfaces, ['apps/web/src/features/account']);
  assert.deepEqual(c.members, ['api', 'db', 'web']);
});

test('a domain id never takes an entity id, and every member knows its domain', () => {
  const c = buildContainment(skeleton(), files);
  const catalog = c.domains.find((d) => d.name === 'Catalog')!;
  assert.equal(catalog.id, 'catalog-domain');
  assert.equal(c.parentOf['reviews'], 'catalog-domain');
  assert.equal(c.parentOf['db'], undefined);
});

test('a capability spanning two services is named for its surface', () => {
  const s = skeleton();
  // The account screen reaches users and audit equally: one capability over both.
  const twoWay = { ...files, 'apps/api/src/modules/audit/index.ts': "import { users } from '@acme/contracts/users';\nexport const m = users;\n" };
  s.services.find((x) => x.id === 'users')!.dependsOn = ['auth', 'storage', 'db'];
  s.services.find((x) => x.id === 'payments')!.dependsOn = ['db'];
  const c = buildContainment(s, twoWay);
  const account = c.domains.find((d) => d.surfaces.includes('apps/web/src/features/account'))!;
  assert.equal(account.name, 'Account');
  assert.deepEqual(account.members, ['audit', 'users']);
});

test('a system that fits on one level is drawn on one', () => {
  const s = skeleton();
  s.services = s.services.slice(0, 3);
  const c = buildContainment(s, files);
  assert.deepEqual(c.domains, []);
  assert.ok(c.members.length <= MAX_CHILDREN);
});

test('without feature directories, capabilities are the served services nothing else depends on', () => {
  const s = skeleton();
  s.clients = [];
  s.processes.push({ id: 'sweep', schedule: '0 3 * * *', calls: ['audit'], source: { file: 'apps/api/src/modules/audit/index.ts' } });
  const c = buildContainment(s, files);
  const names = c.domains.map((d) => d.name).sort();
  // orders and users are served and used by nothing; catalog is used only by orders, so
  // it is inside Orders.
  assert.deepEqual(names, ['Foundation', 'Orders', 'Users']);
  assert.ok(c.domains.find((d) => d.name === 'Orders')!.members.includes('catalog'));
  assert.match(c.notes.join(' '), /no frontend feature directories/);
});
