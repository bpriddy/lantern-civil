import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainText, refineSkeleton, skeletonSummary, validateRefinement } from '../dist/lift/refine.js';
import type { Skeleton } from '../src/lift/skeleton.ts';

/**
 * The model pass's API side, with the runner faked: a valid refinement renames every
 * reference at once, an answer that oversteps is refused for the deterministic
 * skeleton, and no runner at all is a note, not an error. The skeleton is synthetic.
 */

const at = (file: string) => ({ file });

const skeleton = (): Skeleton => ({
  clients: [{ id: 'web', path: 'apps/web', framework: 'vite', devScript: 'vite', calls: ['srv'], source: at('apps/web/package.json') }],
  servers: [
    {
      id: 'srv',
      path: 'apps/server',
      framework: 'nestjs',
      globalPrefix: 'api',
      routes: [
        { method: 'GET', path: '/api/tasks', controller: 'TskController', handler: 'list', source: at('apps/server/src/tsk/tsk.controller.ts') },
      ],
      exposes: ['tsk'],
      source: at('apps/server/src/main.ts'),
    },
  ],
  services: [
    {
      id: 'tsk',
      server: 'srv',
      moduleClass: 'TskModule',
      source: at('apps/server/src/tsk/tsk.module.ts'),
      controllers: [{ name: 'TskController', file: 'apps/server/src/tsk/tsk.controller.ts' }],
      providers: [{ name: 'TskService', file: 'apps/server/src/tsk/tsk.service.ts' }],
      dependsOn: ['db'],
      agents: ['sum'],
      infrastructure: false,
    },
    {
      id: 'db',
      server: 'srv',
      moduleClass: 'DbModule',
      source: at('apps/server/src/db/db.module.ts'),
      controllers: [],
      providers: [{ name: 'DbService', file: 'apps/server/src/db/db.service.ts' }],
      dependsOn: [],
      agents: [],
      infrastructure: false,
    },
  ],
  agents: [{ id: 'sum', files: ['apps/server/src/tsk/sum.agent.ts'], tools: [], source: at('apps/server/src/tsk/sum.agent.ts') }],
  processes: [{ id: 'nightly', schedule: '0 3 * * *', calls: ['tsk'], source: at('apps/server/src/tsk/tsk.service.ts') }],
  unresolved: [{ file: 'apps/server/src/x.ts', reason: 'dynamic module' }],
  frameworks: ['nestjs', 'vite'],
});

const answer = (refinement: Record<string, unknown>, extra: Record<string, unknown> = {}) => async () => ({
  refinement: { renames: {}, infrastructure: [], descriptions: {}, summary: 'A task tracker.', ...refinement },
  attempts: 1,
  docsCut: [],
  promptVersion: '1',
  ...extra,
});

test('the summary is compact: routes counted and sampled, unresolved counted', () => {
  const summary = skeletonSummary(skeleton()) as { servers: { routeCount: number; routes: string[] }[]; unresolved: number; services: { files: string[] }[] };
  assert.equal(summary.servers[0]!.routeCount, 1);
  assert.deepEqual(summary.servers[0]!.routes, ['GET /api/tasks']);
  assert.equal(summary.unresolved, 1);
  assert.deepEqual(summary.services[0]!.files, [
    'apps/server/src/tsk/tsk.module.ts',
    'apps/server/src/tsk/tsk.controller.ts',
    'apps/server/src/tsk/tsk.service.ts',
  ]);
});

test('a valid refinement renames every reference and marks infrastructure', async () => {
  let sent: unknown;
  const ask = async (body: unknown) => {
    sent = body;
    return answer({
      renames: { tsk: 'tasks', sum: 'summarizer', srv: 'server' },
      infrastructure: ['db'],
      descriptions: { tasks: 'Creates and lists tasks.' },
    })();
  };
  const result = await refineSkeleton(skeleton(), { 'README.md': '# Tasks' }, ask);
  assert.deepEqual((sent as { docs: unknown }).docs, { 'README.md': '# Tasks' }, 'the docs ride the request');
  assert.equal(result.note, null);
  assert.deepEqual(result.refinement!.renames, { tsk: 'tasks', sum: 'summarizer', srv: 'server' });
  const s = result.skeleton;
  assert.deepEqual(s.clients[0]!.calls, ['server'], 'client calls follow the server rename');
  assert.equal(s.servers[0]!.id, 'server');
  assert.deepEqual(s.servers[0]!.exposes, ['tasks'], 'exposes follows the service rename');
  assert.equal(s.services[0]!.id, 'tasks');
  assert.equal(s.services[0]!.server, 'server');
  assert.deepEqual(s.services[0]!.agents, ['summarizer'], 'agent references follow');
  assert.deepEqual(s.services[0]!.dependsOn, ['db']);
  assert.equal(s.services[1]!.infrastructure, true, 'db is marked infrastructure');
  assert.equal(s.services[0]!.infrastructure, false);
  assert.equal(s.agents[0]!.id, 'summarizer');
  assert.deepEqual(s.processes[0]!.calls, ['tasks'], 'process calls follow');
});

test('an answer that oversteps is refused for the deterministic skeleton', async () => {
  for (const [label, refinement] of [
    ['an invented id', { renames: { billing: 'payments' } }],
    ['a collision', { renames: { tsk: 'db' } }],
    ['an invalid id', { renames: { tsk: 'Tasks Module' } }],
    ['a non-service as infrastructure', { infrastructure: ['web'] }],
    ['a paragraph as a description', { descriptions: { tsk: 'One. Two. Three.' } }],
  ] as const) {
    const original = skeleton();
    const result = await refineSkeleton(original, {}, answer(refinement as Record<string, unknown>));
    assert.equal(result.refinement, null, label);
    assert.equal(result.skeleton, original, `${label}: the reader's skeleton, untouched`);
    assert.match(result.note!, /answer was refused/, label);
    assert.match(result.note!, /deterministic result/, label);
  }
});

test('a runner failure is a note, with the runner’s own reason', async () => {
  const fail = async () => {
    throw Object.assign(new Error('validation failed'), {
      status: 422,
      body: { error: 'validation failed', issues: ["renames: 'ghost' is not an entity"], attempts: 3 },
    });
  };
  const result = await refineSkeleton(skeleton(), {}, fail);
  assert.equal(result.refinement, null);
  assert.match(result.note!, /'ghost' is not an entity/);
});

test('no runner means the deterministic result and a note saying so', async () => {
  const original = skeleton();
  const result = await refineSkeleton(original, {}, undefined);
  assert.equal(result.skeleton, original);
  assert.equal(result.refinement, null);
  assert.match(result.note!, /no runner is configured/);
});

test('docs the model could not read are named in the note', async () => {
  const result = await refineSkeleton(skeleton(), {}, answer({}, { docsCut: ['docs/huge.md'] }));
  assert.ok(result.refinement);
  assert.match(result.note!, /docs\/huge\.md/);
});

test('a summary that arrives JSON-encoded lands as prose, not one line of escapes', async () => {
  const encoded = JSON.stringify('A task tracker.\n\nIt keeps tasks and digests them.');
  const result = await refineSkeleton(skeleton(), {}, answer({ summary: encoded }));
  assert.equal(result.refinement!.summary, 'A task tracker.\n\nIt keeps tasks and digests them.');
  // Literal backslash-n in text with no real line breaks is an encoding too.
  assert.equal(plainText('One.\\n\\nTwo.'), 'One.\n\nTwo.');
  // Real prose is left exactly as written, quotes inside it included.
  assert.equal(plainText('It says "hello".\nThen stops.'), 'It says "hello".\nThen stops.');
});

test('the model cannot file a service that serves routes or runs agents under infrastructure', async () => {
  // tsk serves a route and runs an agent; db does neither and may be plumbing.
  const result = await refineSkeleton(skeleton(), {}, answer({ infrastructure: ['tsk', 'db'] }));
  assert.ok(result.refinement, 'the rest of the answer stands');
  assert.deepEqual(result.refinement!.infrastructure, ['db']);
  assert.equal(result.skeleton.services.find((s) => s.id === 'tsk')!.infrastructure, false);
  assert.equal(result.skeleton.services.find((s) => s.id === 'db')!.infrastructure, true);
  assert.match(result.note ?? '', /"tsk" serves routes or runs agents/);
  // And the model is told what makes a service product: its route count and root.
  const summary = skeletonSummary(skeleton()) as { services: { id: string; routes: number; root: boolean }[] };
  assert.deepEqual(summary.services.map((s) => [s.id, s.routes, s.root]), [['tsk', 1, false], ['db', 0, false]]);
});

test('a recorded answer is reused leniently: an entry that no longer fits costs only itself', () => {
  const recorded = {
    renames: { tsk: 'tasks', gone: 'whatever' },
    infrastructure: ['db', 'gone'],
    descriptions: { tasks: 'Keeps tasks.', gone: 'Was here once.' },
    summary: '"A task tracker.\\n\\nStill."',
  };
  const strict = validateRefinement(recorded, skeleton());
  assert.equal(strict.refinement, null, 'strict validation refuses the whole answer');
  const lenient = validateRefinement(recorded, skeleton(), { lenient: true });
  assert.deepEqual(lenient.refinement, {
    renames: { tsk: 'tasks' },
    infrastructure: ['db'],
    descriptions: { tasks: 'Keeps tasks.' },
    summary: 'A task tracker.\n\nStill.',
  });
  assert.equal(lenient.dropped.length, 3);
});
