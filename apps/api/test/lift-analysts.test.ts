import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { AREA_LIMIT, AREA_MAX_FILES, buildAreas, normalizeClaims, validateAnswer } from '../dist/lift/analysts.js';
import { liftRepository } from '../dist/lift/index.js';

/**
 * The agent stage adds voices to the reader's, and every one is weighed by the same
 * rules. What is pinned here is everything around the model: how the repository is
 * split for analysts, that nothing the runner returns is trusted as-is, that a new
 * entity is built only from its own claim, and that agreement, disagreement, and
 * failure each land on the graph the way docs/lift-repo.md says.
 */

test('areas follow directories: big ones split, small siblings join, infrastructure stands alone', () => {
  const many = (dir: string, n: number) => Array.from({ length: n }, (_, i) => `${dir}/f${i}.ts`);
  const listed = [
    ...many('apps/api/src/billing', 30),
    ...many('apps/api/src/search', 20),
    ...many('apps/api/src/tiny-a', 3),
    ...many('apps/api/src/tiny-b', 4),
    ...many('apps/api/src/huge', AREA_MAX_FILES + 40).map((p, i) => p.replace('/f', `/${i % 2 ? 'left' : 'right'}/f`)),
    'apps/api/src/main.ts',
    'apps/api/src/billing/billing.spec.ts',
    'apps/api/src/testing/fake-clock.ts',
    'infra/main.tf',
    'apps/api/Dockerfile',
    'README.md',
  ];
  const areas = buildAreas(listed);
  const covers = (path: string) => areas.filter((a) => a.prefixes.some((p) => path.startsWith(p)));
  assert.ok(areas.length <= AREA_LIMIT);
  for (const path of listed.filter((p) => p.endsWith('.ts') && !p.includes('spec') && !p.includes('testing'))) {
    assert.equal(covers(path).length, 1, `${path} is in exactly one area`);
  }
  assert.equal(covers('apps/api/src/testing/fake-clock.ts').length, 0, 'test support is nobody\'s area');
  const huge = areas.filter((a) => a.prefixes.some((p) => p.includes('/huge/')));
  assert.ok(huge.length >= 2, 'a directory past the limit is split by its subdirectories');
  const tiny = areas.find((a) => a.prefixes.includes('apps/api/src/tiny-a/'));
  assert.ok(tiny?.prefixes.includes('apps/api/src/tiny-b/'), 'small siblings share an analyst');
  const infra = areas.find((a) => a.title === 'Infrastructure and deployment');
  assert.deepEqual(infra?.prefixes, ['apps/api/Dockerfile', 'infra/main.tf']);
  assert.equal(new Set(areas.map((a) => a.id)).size, areas.length, 'ids are unique');
  assert.deepEqual(buildAreas(listed), areas, 'deterministic');
});

test('nothing the runner returns is trusted as-is', () => {
  const listed = new Set(['src/a.ts']);
  const { claims, issues } = validateAnswer(
    {
      claims: [
        { kind: 'agent', subject: 'pricing', by: 'analyst:a', stance: 'assert', evidence: [{ file: 'src/a.ts', line: 2, quote: 'x' }] },
        { kind: 'service', subject: 'tasks', by: 'reader', stance: 'assert', evidence: [{ file: 'src/a.ts' }] },
        { kind: 'service', subject: 'ghost', by: 'analyst:a', stance: 'assert', evidence: [{ file: 'src/invented.ts' }] },
        { kind: 'depends-on', subject: 'a', by: 'verifier:a', stance: 'assert', evidence: [{ file: 'src/a.ts' }] },
        { kind: 'route', subject: 'get-x', by: 'analyst:a', stance: 'assert', evidence: [{ file: 'src/a.ts' }] },
      ],
    },
    listed,
  );
  assert.deepEqual(claims.map((c: { subject: string }) => c.subject), ['pricing']);
  assert.equal(issues.length, 4, 'a voice posing as the reader, invented files, half relations, and below-altitude kinds are refused');
});

test('a new entity is built only from its own claim', () => {
  const reader = { servers: [{ id: 'api' }], clients: [], services: [{ id: 'orders' }], agents: [], processes: [] };
  const [agent, process, known] = normalizeClaims(
    [
      { kind: 'agent', subject: 'pricing', by: 'analyst:a', stance: 'assert', evidence: [{ file: 'src/pricing.agent.ts', line: 3 }], attrs: { tools: [{ name: 'quote', file: 'src/quote.ts' }, { bad: 1 }] } },
      { kind: 'process', subject: 'digest', by: 'analyst:a', stance: 'assert', evidence: [{ file: 'src/digest.ts', line: 1 }] },
      { kind: 'service', subject: 'orders', by: 'analyst:a', stance: 'assert', evidence: [{ file: 'src/orders.ts' }], attrs: { group: 'Commerce' } },
    ] as never,
    reader as never,
  );
  assert.deepEqual(agent.attrs, {
    tools: [{ name: 'quote', file: 'src/quote.ts' }],
    files: ['src/pricing.agent.ts'],
    source: { file: 'src/pricing.agent.ts', line: 3 },
  });
  assert.equal(process.attrs.schedule, '@unknown', 'no voice gave a schedule, so none is guessed');
  assert.deepEqual(known.attrs, { group: 'Commerce' }, 'an entity the reader found keeps the reader\'s fields; analysts only add');
});

// --- end to end: the agent stage through liftRepository ---------------------------

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const S = 'apps/server/src';
const REPO: Record<string, string> = {
  'package.json': json({ name: 'shop', private: true }),
  'apps/server/package.json': json({ name: 'server', dependencies: { '@nestjs/core': '10', '@nestjs/common': '10' } }),
  [`${S}/main.ts`]: "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\nNestFactory.create(AppModule);\n",
  [`${S}/app.module.ts`]: "import { Module } from '@nestjs/common';\nimport { OrdersModule } from './orders/orders.module';\n@Module({ imports: [OrdersModule] })\nexport class AppModule {}\n",
  [`${S}/orders/orders.module.ts`]: [
    "import { Module, Controller, Get } from '@nestjs/common';",
    "import { priceOrder } from './pricing/quote';",
    "@Controller('orders') export class OrdersController { @Get() all() { return priceOrder(); } }",
    '@Module({ controllers: [OrdersController] })',
    'export class OrdersModule {}',
    '',
  ].join('\n'),
  [`${S}/orders/pricing/quote.ts`]: "import { gateway } from '../../llm/gateway';\nexport const priceOrder = () => gateway.complete(PROMPT);\nconst PROMPT = 'Price this order.';\n",
  [`${S}/llm/gateway.ts`]: 'export const gateway = { complete: (p: string) => p };\n',
};
const source = (files: Record<string, string>) => ({
  list: () => Object.keys(files).sort(),
  read: (p: string) => files[p],
  exists: (p: string) => p in files,
  glob: () => [],
  ensure: async () => {},
});

const AGENT_EVIDENCE = [{ file: `${S}/orders/pricing/quote.ts`, line: 2, quote: 'gateway.complete(PROMPT)' }];
const USES_EVIDENCE = [{ file: `${S}/orders/orders.module.ts`, line: 2, quote: "import { priceOrder } from './pricing/quote'" }];

test('an agent the reader missed is added when an analyst finds it and a verifier confirms it', async () => {
  let asked: { areas?: unknown[]; claims?: unknown[] } = {};
  const analyze = async (body: unknown) => {
    asked = body as typeof asked;
    return {
      claims: [
        { kind: 'agent', subject: 'pricing', by: 'analyst:orders', stance: 'assert', evidence: AGENT_EVIDENCE, note: 'Prices an order through the LLM gateway.' },
        { kind: 'uses-agent', subject: 'orders', object: 'pricing', by: 'analyst:orders', stance: 'assert', evidence: USES_EVIDENCE },
        { kind: 'agent', subject: 'pricing', by: 'verifier:orders', stance: 'assert', evidence: AGENT_EVIDENCE },
        { kind: 'service', subject: 'invented', by: 'analyst:orders', stance: 'assert', evidence: [{ file: `${S}/main.ts`, line: 1, quote: 'not in the file' }] },
      ],
    };
  };
  const result = await liftRepository(source(REPO) as never, { projectName: 'Shop', analyze });

  assert.ok((asked.areas?.length ?? 0) > 0 && (asked.claims?.length ?? 0) > 0, 'analysts are given areas and the reader\'s claims');
  const readerAlone = await liftRepository(source(REPO) as never, { projectName: 'Shop' });
  assert.deepEqual(readerAlone.skeleton.agents, [], 'the reader alone cannot see this agent — only an analyst can');
  assert.deepEqual(result.skeleton.agents.map((a: { id: string }) => a.id), ['pricing']);
  assert.deepEqual(result.skeleton.services.find((s: { id: string }) => s.id === 'orders')!.agents, ['pricing']);
  assert.ok(!result.skeleton.services.some((s: { id: string }) => s.id === 'invented'), 'a misquoted claim is not believed');
  assert.match(result.analysis!.disbelieved.join('\n'), /service:invented/);

  const units = parse(result.files['civil/registry.yaml']!).units as Record<string, { confidence?: string }>;
  const agentUnit = Object.keys(units).find((k) => /\/pricing$/.test(k));
  assert.ok(agentUnit, 'the agent is drawn');
  assert.equal(units[agentUnit!]!.confidence, 'high', 'an analyst and an independent verifier agreeing is high confidence');
});

test('the analysts failing leaves exactly the reader\'s lift', async () => {
  const alone = await liftRepository(source(REPO) as never, { projectName: 'Shop' });
  const failed = await liftRepository(source(REPO) as never, {
    projectName: 'Shop',
    analyze: async () => {
      throw new Error('runner answered 502');
    },
  });
  assert.deepEqual(failed.files, alone.files);
  assert.match(failed.analysis!.note!, /could not be analysed: .*runner answered 502/);
});

// --- entity resolution and scope ---------------------------------------------------

import { resolveEntities } from '../dist/lift/analysts.js';
import { isSampleCode, selectLiftPaths } from '../dist/lift/read.js';

const voice = (kind: string, subject: string, file: string, attrs: Record<string, unknown> = {}, object?: string) =>
  ({ kind, subject, ...(object ? { object } : {}), by: 'analyst:a', stance: 'assert', evidence: [{ file, line: 1 }], attrs }) as never;

test('the same thing named twice is one thing: anchored in the same code, the earlier name wins', () => {
  const reader = { servers: [{ id: 'api', path: 'apps/api', source: { file: 'apps/api/src/main.ts' } }], clients: [], services: [], agents: [], processes: [] };
  const { claims, aliases } = resolveEntities(
    [
      voice('server', 'runner', 'runner/Dockerfile', { path: 'runner' }),
      voice('server', 'civil-runner', 'runner/server.py'),
      voice('server', 'civil-api', 'apps/api/src/http/server.ts', { path: 'apps/api' }),
      voice('depends-on', 'transpile', 'apps/api/src/x.ts', {}, 'civil-runner'),
      voice('calls', 'web', 'apps/web/src/api.ts', {}, 'api'),
    ],
    reader as never,
  );
  assert.deepEqual(aliases, { 'civil-runner': 'runner', 'civil-api': 'api' }, 'the reader\'s name, then the earliest voice\'s');
  assert.equal(claims[3].object, 'runner', 'relations follow the alias');
  assert.equal(claims[1].subject, 'runner');
});

test('an unclaimed relation end is matched by a unique whole-word name, never by a guess', () => {
  const reader = { servers: [], clients: [], services: [], agents: [], processes: [] };
  const { claims } = resolveEntities(
    [
      voice('server', 'civil-api', 'apps/api/src/main.ts'),
      voice('server', 'session-service', 'session/server.py'),
      voice('server', 'billing-service', 'billing/main.py'),
      voice('calls', 'web', 'apps/web/src/a.ts', {}, 'api'),
      voice('calls', 'web', 'apps/web/src/a.ts', {}, 'service'),
    ],
    reader as never,
  );
  assert.equal(claims[3].object, 'civil-api', 'one entity contains "api": matched');
  assert.equal(claims[4].object, 'service', 'two contain "service": ambiguous, left unknown for claims.ts to drop');
});

test('two equally good matches are ambiguous: the new name stands on its own', () => {
  const reader = {
    servers: [], clients: [], agents: [], processes: [],
    services: [
      { id: 'a', source: { file: 'src/shared/x.ts' }, controllers: [], providers: [], files: [] },
      { id: 'b', source: { file: 'src/shared/y.ts' }, controllers: [], providers: [], files: [] },
    ],
  };
  const { aliases } = resolveEntities([voice('service', 'shared-stuff', 'src/shared/z.ts', { files: ['src/shared/**'] })], reader as never);
  assert.deepEqual(aliases, {});
});

test('example and sample projects are not the product', () => {
  for (const path of ['examples/shop/web/src/main.ts', 'packages/ui/demo/app.ts', 'sandbox/x.ts']) {
    assert.ok(isSampleCode(path), path);
  }
  assert.ok(!isSampleCode('apps/api/src/examples.ts'), 'a file named like it is not a directory of it');
  const chosen = selectLiftPaths(['examples/shop/web/package.json', 'examples/shop/web/src/main.ts', 'apps/web/package.json']);
  assert.deepEqual(chosen, ['apps/web/package.json']);
});

test('two agents defined in the same file stay two agents', () => {
  const reader = { servers: [], clients: [], services: [], agents: [], processes: [] };
  const { aliases } = resolveEntities(
    [
      voice('agent', 'repo-reviewer', 'tools/review.py'),
      voice('agent', 'repo-checker', 'tools/review.py'),
      voice('agent', 'reviewer', 'tools/review.py'),
    ],
    reader as never,
  );
  assert.deepEqual(aliases, { reviewer: 'repo-reviewer' }, 'only a related name in the same code is the same agent');
});

// --- per-area memo and progress ------------------------------------------------------

const memoStore = () => {
  const store = new Map<string, unknown[]>();
  return {
    store,
    memo: {
      get: async (k: string) => store.get(k) as never,
      put: async (k: string, area: string, v: readonly unknown[]) => {
        store.set(k, [...v]);
        store.set(`latest:${area}`, [...v]);
      },
      latest: async (area: string) => store.get(`latest:${area}`) as never,
    },
  };
};

test('an unchanged area is not asked again; a changed one is, alone', async () => {
  const { memo } = memoStore();
  let calls = 0;
  const analyze = async (body: unknown) => {
    calls += 1;
    const area = (body as { areas: { id: string }[] }).areas[0]!;
    return { claims: [{ kind: 'agent', subject: 'pricing', by: `analyst:${area.id}`, stance: 'assert', evidence: AGENT_EVIDENCE }] };
  };
  const opts = { projectName: 'Shop', analyze, analyzeOptions: { memo, version: 'v1:model' } };
  const first = await liftRepository(source(REPO) as never, opts);
  const asked = calls;
  assert.ok(asked >= 1);
  assert.equal(first.analysis!.cachedAreas, 0);

  const again = await liftRepository(source(REPO) as never, opts);
  assert.equal(calls, asked, 'nothing changed: no area is asked again');
  assert.equal(again.analysis!.cachedAreas, again.analysis!.areas);
  assert.deepEqual(again.files, first.files, 'and the documents are byte-identical');

  const edited = { ...REPO, [`${S}/llm/gateway.ts`]: 'export const gateway = { complete: (p: string) => p.trim() };\n' };
  await liftRepository(source(edited) as never, opts);
  assert.equal(calls, asked + 1, 'one area changed: that one area is asked');

  await liftRepository(source(REPO) as never, { ...opts, analyzeOptions: { memo, version: 'v2:model' } });
  assert.ok(calls > asked + 1, 'a new prompt version or model asks again');
});

test('progress is reported stage by stage, with areas counted', async () => {
  const seen: string[] = [];
  await liftRepository(source(REPO) as never, {
    projectName: 'Shop',
    analyze: async () => ({ claims: [] }),
    progress: (stage: string, _detail: string, areas?: { done: number; total: number }) =>
      seen.push(areas ? `${stage} ${areas.done}/${areas.total}` : stage),
  });
  assert.equal(seen[0], 'listing');
  assert.equal(seen[1], 'reading');
  const analysing = seen.filter((s) => s.startsWith('analysing'));
  assert.ok(analysing.length >= 2 && analysing[0]!.endsWith(' 0/' + analysing[0]!.split('/')[1]), 'starts at 0 of N');
  assert.equal(seen[seen.length - 1], 'writing');
});

test('an area that cannot be asked keeps its last answer, and says so', async () => {
  const { memo } = memoStore();
  const answer = async (body: unknown) => {
    const area = (body as { areas: { id: string }[] }).areas[0]!;
    return { claims: [{ kind: 'agent', subject: 'pricing', by: `analyst:${area.id}`, stance: 'assert', evidence: AGENT_EVIDENCE }] };
  };
  const first = await liftRepository(source(REPO) as never, { projectName: 'Shop', analyze: answer, analyzeOptions: { memo, version: 'v1' } });
  const edited = { ...REPO, [`${S}/llm/gateway.ts`]: 'export const gateway = { complete: (p: string) => p.trim() };\n' };
  const failing = async () => {
    throw new Error('runner answered 400 (credit balance is too low)');
  };
  const after = await liftRepository(source(edited) as never, { projectName: 'Shop', analyze: failing, analyzeOptions: { memo, version: 'v1' } });
  assert.deepEqual(after.skeleton.agents.map((a: { id: string }) => a.id), first.skeleton.agents.map((a: { id: string }) => a.id), 'the graph keeps what the area last said');
  assert.match(after.analysis!.note!, /could not be asked again and kept (its|their) last answer: .*credit balance/);
});

test('Civil\'s own documents are never analysed as the product', async () => {
  let sentPaths: string[] = [];
  let indexed: string[] = [];
  await liftRepository(source({ ...REPO, 'civil/app.yaml': 'apiVersion: civil/v1\nkind: Composition\nmetadata:\n  id: shop\n  name: Shop\nspec:\n  nodes: []\n  edges: []\n', 'civil/registry.yaml': 'kind: Registry\n' }) as never, {
    projectName: 'Shop',
    analyze: async (body: unknown) => {
      const b = body as { files: Record<string, string>; index: string[] };
      sentPaths = Object.keys(b.files);
      indexed = b.index;
      return { claims: [] };
    },
  });
  assert.ok(!sentPaths.some((p) => p.startsWith('civil/')) && !indexed.some((p) => p.startsWith('civil/')), 'civil/ is the lift\'s output, not its input');
});
