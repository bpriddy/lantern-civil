import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { validateView } from '@civil/schema';
import { buildContainment, toSkeletonDomains } from '../dist/lift/containment.js';
import { buildFacts } from '../dist/lift/facts.js';
import { ANGLES, architectureTasks, diagramId, flowIndex, flowTasks, interpretApplication, mergedAngles, partOwner, weigh } from '../dist/lift/interpret.js';
import { layoutDiagram, readingDocuments } from '../dist/lift/documents-diagrams.js';
import { skeleton, files } from './fixtures-shop.ts';

/**
 * Interpretation (docs/interpretation.md): how an application thinks and what it is
 * built on, drawn by agents and written only where the code and a verifier support it.
 * The model is faked; what is pinned is everything around it.
 */

const withDomains = () => {
  const s = skeleton();
  s.domains = toSkeletonDomains(buildContainment(s, files));
  return s;
};

const EV = (line: number, quote: string) => [{ file: 'apps/api/src/modules/orders/index.ts', line, quote }];

test('a flow task per capability, carrying its paths and parts; an architecture task per angle', () => {
  const tasks = flowTasks(withDomains());
  const orders = tasks.find((t) => t.title === 'Orders')!;
  assert.deepEqual(orders.paths, ['apps/api/src/modules/orders/', 'apps/api/src/modules/payments/', 'apps/web/src/features/checkout/']);
  assert.deepEqual(orders.parts!.map((p) => p.id), ['orders', 'payments']);
  assert.ok(!tasks.some((t) => t.id === 'overview'), 'no capability takes the overview\'s id');
  const angles = architectureTasks(withDomains(), buildFacts(files, Object.keys(files)));
  assert.deepEqual(angles.map((a) => a.id), ANGLES.map((a) => a.id));
});

test('only what the code and the verifier support is drawn', () => {
  const answer = {
    diagram: {
      nodes: [
        { id: 'shopper', kind: 'actor', name: 'Shopper' },
        { id: 'checkout', kind: 'step', name: 'Checkout', evidence: EV(1, 'contracts/orders'), realizedBy: ['orders', 'ghost'],
          decisions: [{ statement: 'Orders are validated.', evidence: EV(1, 'orders') }, { statement: 'Made up.', evidence: EV(1, 'nothing like this') }] },
        { id: 'pricer', kind: 'agent', name: 'Pricer', evidence: EV(1, 'not on that line') },
        { id: 'fraud', kind: 'guard', name: 'Fraud check', evidence: EV(1, 'orders') },
      ],
      edges: [
        { from: 'shopper', to: 'checkout', kind: 'next', label: 'a cart' },
        { from: 'checkout', to: 'pricer', kind: 'next' },
        { from: 'checkout', to: 'fraud', kind: 'next' },
      ],
    },
    verdicts: { 'node:checkout': { verdict: 'support' }, 'node:fraud': { verdict: 'refute' } },
  };
  const { diagram, dropped } = weigh('orders', 'Orders', answer, files, new Set(Object.keys(files)), new Set(['orders', 'payments']));
  assert.deepEqual(diagram.nodes.map((n) => [n.id, n.confidence]), [['shopper', 'low'], ['checkout', 'high']],
    'a refuted node and one whose evidence does not hold are not drawn; an actor names someone outside the code');
  assert.deepEqual(diagram.nodes[1]!.realizedBy, ['orders'], 'a part the reader did not find is not named');
  assert.deepEqual(diagram.nodes[1]!.decisions.map((d) => d.statement), ['Orders are validated.']);
  assert.deepEqual(diagram.edges.map((e) => `${e.from}->${e.to}`), ['shopper->checkout'], 'no line to a node not drawn');
  assert.equal(dropped, 5);
});

test('a node with no parts named is linked to the part its evidence lies in', () => {
  const s = skeleton();
  const answer = { diagram: { nodes: [{ id: 'checkout', kind: 'step', name: 'Checkout', evidence: EV(1, 'orders') }], edges: [] }, verdicts: {} };
  const { diagram } = weigh('orders', 'Orders', answer, files, new Set(Object.keys(files)), new Set(['orders', 'payments']), partOwner(s));
  assert.deepEqual(diagram.nodes[0]!.realizedBy, ['orders']);
});

test('a flow reads left to right in the order work passes, and a loop is drawn back', () => {
  const at = layoutDiagram(
    {
      id: 'x', name: 'X',
      nodes: ['user', 'intent', 'plan', 'check'].map((id) => ({ id, kind: id === 'user' ? 'actor' : 'step', name: id, realizedBy: [], evidence: [], decisions: [], confidence: 'high' as const })),
      edges: [
        { from: 'user', to: 'intent', kind: 'next', evidence: [], confidence: 'high' as const },
        { from: 'intent', to: 'plan', kind: 'next', evidence: [], confidence: 'high' as const },
        { from: 'plan', to: 'check', kind: 'next', evidence: [], confidence: 'high' as const },
        { from: 'check', to: 'intent', kind: 'next', evidence: [], confidence: 'high' as const },
      ],
    },
    'flow',
  );
  const xs = ['user', 'intent', 'plan', 'check'].map((id) => at.get(id)!.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'each step right of the one before');
  assert.ok(new Set(xs).size === 4, 'the loop back does not fold the flow up');
});

test('the written views name the composition\'s parts, keep the author\'s positions, and validate', () => {
  const reading = {
    shape: 'flow' as const,
    entry: 'overview',
    diagrams: [
      { id: 'overview', name: 'How it works', nodes: [{ id: 'orders-flow', kind: 'flow', name: 'Orders', ref: 'orders', realizedBy: [], evidence: [], decisions: [], confidence: 'low' as const }], edges: [] },
      { id: 'orders', name: 'Orders', nodes: [{ id: 'checkout', kind: 'step', name: 'Checkout', realizedBy: ['orders'], evidence: ['apps/api/src/modules/orders/index.ts:1'], decisions: [], confidence: 'high' as const }], edges: [] },
    ],
  };
  const first = readingDocuments(reading, new Map([['orders', 'orders-svc']]), {});
  assert.deepEqual(Object.keys(first).sort(), ['civil/views/flow/orders.yaml', 'civil/views/flow/overview.yaml', 'civil/views/flow/view.yaml']);
  assert.deepEqual(parse(first['civil/views/flow/orders.yaml']!).spec.nodes[0].realizedBy, ['orders-svc']);
  const result = validateView(
    { path: 'civil/views/flow/view.yaml', raw: parse(first['civil/views/flow/view.yaml']!), domains: ['overview', 'orders'].map((d) => ({ path: `civil/views/flow/${d}.yaml`, raw: parse(first[`civil/views/flow/${d}.yaml`]!) })) },
    new Set(['orders-svc']),
  );
  assert.deepEqual(result.diagnostics, []);

  const moved = { ...first, 'civil/views/flow/orders.yaml': first['civil/views/flow/orders.yaml']!.replace(/checkout:\n\s+x: -?\d+\n\s+y: -?\d+/, 'checkout:\n      x: 999\n      y: 7') };
  const again = readingDocuments(reading, new Map([['orders', 'orders-svc']]), moved);
  assert.deepEqual(parse(again['civil/views/flow/orders.yaml']!).layout.nodes.checkout, { x: 999, y: 7 }, 'a position the author set is kept');
  const older = { ...moved, 'civil/views/flow/orders.yaml': moved['civil/views/flow/orders.yaml']!.replace(/by: \S+/, 'by: civil-dagre-1') };
  const relaid = readingDocuments(reading, new Map([['orders', 'orders-svc']]), older);
  assert.notDeepEqual(parse(relaid['civil/views/flow/orders.yaml']!).layout.nodes.checkout, { x: 999, y: 7 }, 'one an older layout wrote is laid out again');
  assert.equal(readingDocuments(reading, new Map([['orders', 'orders-svc']]), {})['civil/views/flow/orders.yaml'], first['civil/views/flow/orders.yaml'], 'the same reading writes the same bytes');
});

test('the whole stage: analysts, then the overviews from what they drew; a failure costs only its task', async () => {
  const asked: { mode?: string; task?: { id: string; role: string; shape: string; inputs?: { id: string }[] } }[] = [];
  const ask = async (body: unknown) => {
    const b = JSON.parse((body as { text: string }).text) as (typeof asked)[number];
    asked.push(b);
    const t = b.task!;
    if (t.shape === 'architecture' && t.id === 'security') throw new Error('runner unreachable');
    if (t.role === 'synth') {
      return {
        diagram: { nodes: (t.inputs ?? []).map((i) => ({ id: `${i.id}-door`, kind: t.shape === 'flow' ? 'flow' : 'concern', name: i.id, ref: i.id, evidence: EV(1, 'orders') })), edges: [] },
        verdicts: {},
      };
    }
    return { diagram: { nodes: [{ id: `${t.id}-step`, kind: t.shape === 'flow' ? 'step' : 'service', name: t.id, evidence: EV(1, 'orders') }], edges: [] }, verdicts: {} };
  };
  const s = withDomains();
  const out = await interpretApplication(ask, { skeleton: s, files, listed: Object.keys(files), product: Object.keys(files), facts: buildFacts(files, Object.keys(files)) }, { concurrency: 2 });
  assert.equal(out.flow!.entry, 'overview');
  assert.deepEqual(out.flow!.diagrams.map((d) => d.id).sort(), ['catalog', 'foundation', 'orders', 'overview', 'users']);
  assert.deepEqual(out.architecture!.diagrams.map((d) => d.id), ['overview', 'stack', 'data', 'ai'], 'the angle that failed is left out, and said');
  assert.match(out.report.note ?? '', /architecture security/);
  const synth = asked.filter((a) => a.task!.role === 'synth');
  assert.equal(synth.length, 2, 'one overview per view, after the analysts');
  assert.ok(out.architecture!.diagrams[0]!.nodes.every((n) => n.ref && ['stack', 'data', 'ai'].includes(n.ref)), 'doors open drawn diagrams');
});

test('a diagram id is always valid and never taken twice, whatever the name', () => {
  const taken = new Set(['overview']);
  assert.equal(diagramId('2FA recovery', taken), 'f-2fa-recovery');
  assert.equal(diagramId('注文', taken), 'flow');
  assert.equal(diagramId('注文', taken), 'flow-2');
  const long = 'a very long capability name that goes on and on past every limit there is';
  const a = diagramId(long, taken);
  const b = diagramId(long, taken);
  assert.ok(a !== b && b.length <= 64 && /^[a-z][a-z0-9_-]*$/.test(b));
});

test('a task that drew nothing is not remembered, and the last good reading stands', async () => {
  const store = new Map<string, unknown>();
  const latest = new Map<string, unknown>();
  const memo = {
    get: async (f: string) => store.get(f) as never,
    put: async (f: string, area: string, claims: unknown) => { store.set(f, claims); latest.set(area, claims); },
    latest: async (area: string) => latest.get(area) as never,
  };
  const good = { diagram: { nodes: [{ id: 'step', kind: 'step', name: 'Step', evidence: EV(1, 'orders') }], edges: [] }, verdicts: {} };
  const s = withDomains();
  const input = { skeleton: s, files, listed: Object.keys(files), product: Object.keys(files), facts: buildFacts(files, Object.keys(files)) };
  await interpretApplication(async () => good, input, { memo, version: 'v1' });
  const remembered = store.size;
  const out = await interpretApplication(async () => ({ diagram: { nodes: [], edges: [] }, verdicts: {}, error: 'no answer within the turn budget' }), input, { memo, version: 'v2' });
  assert.equal(store.size, remembered, 'nothing new is stored');
  assert.ok(out.flow!.diagrams.length > 0, 'the last good reading is kept');
  assert.match(out.report.note!, /the last reading was kept/);
});

test('without the model\'s overviews, Civil draws its own from what the analysts drew', () => {
  const node = (id: string, kind: string, decisions: string[] = []) => ({ id, kind, name: id, realizedBy: [], evidence: [], decisions: decisions.map((statement) => ({ statement, evidence: [] })), confidence: 'high' as const });
  const index = flowIndex([
    { id: 'orders', name: 'Orders', nodes: [node('a', 'step')], edges: [] },
    { id: 'catalog', name: 'Catalog', nodes: [node('b', 'step')], edges: [] },
  ]);
  assert.deepEqual(index.nodes.map((n) => [n.kind, n.ref]), [['flow', 'orders'], ['flow', 'catalog']]);
  const merged = mergedAngles([
    { id: 'stack', name: 'Stack', nodes: [node('api', 'service', ['NestJS']), node('db', 'datastore')], edges: [{ from: 'api', to: 'db', kind: 'uses', evidence: [], confidence: 'high' as const }] },
    { id: 'security', name: 'Security', nodes: [node('api', 'service', ['Origin guard']), node('auth', 'concern')], edges: [{ from: 'auth', to: 'api', kind: 'governs', evidence: [], confidence: 'high' as const }] },
  ]);
  assert.deepEqual(merged.nodes.map((n) => [n.id, n.ref]), [['api', 'stack'], ['db', 'stack'], ['auth', 'security']], 'each piece once, a door to the angle it came from');
  assert.deepEqual(merged.nodes[0]!.decisions.map((d) => d.statement), ['NestJS', 'Origin guard']);
  assert.equal(merged.edges.length, 2);
});
