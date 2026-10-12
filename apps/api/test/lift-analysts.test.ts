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
  assert.match(failed.analysis!.note!, /failed \(runner answered 502\)/);
});
