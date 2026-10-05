import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { LiftRefusal, liftFingerprint, liftRefusal, liftRepository, liftStatus } from '../dist/lift/index.js';
import { readRepo } from '../dist/lift/read.js';

/**
 * liftRepository end to end over an in-memory source: the decisions that sit between
 * the reader and the mapper — when the model is asked, what happens when it fails on
 * an Update, which projects are refused before anything is read into them, and which
 * existing documents an Update merges with. The repository is a small invented ledger
 * app: one Nest server, one Vite client.
 */

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const S = 'apps/server/src';

const REPO: Record<string, string> = {
  'package.json': json({ name: 'ledger', private: true }),
  'README.md': '# Ledger\n\nTracks accounts and the entries posted to them.\n',
  'apps/server/package.json': json({ name: 'server', dependencies: { '@nestjs/core': '10', '@nestjs/common': '10' } }),
  [`${S}/main.ts`]: "import { NestFactory } from '@nestjs/core';\nimport { AppModule } from './app.module';\nNestFactory.create(AppModule);\n",
  [`${S}/app.module.ts`]: [
    "import { Module } from '@nestjs/common';",
    "import { AccountsModule } from './accounts/accounts.module';",
    "import { EntriesModule } from './entries/entries.module';",
    '@Module({ imports: [AccountsModule, EntriesModule] })',
    'export class AppModule {}',
    '',
  ].join('\n'),
  [`${S}/accounts/accounts.module.ts`]: [
    "import { Module, Controller, Get } from '@nestjs/common';",
    "@Controller('accounts') export class AccountsController { @Get() all() {} }",
    '@Module({ controllers: [AccountsController] })',
    'export class AccountsModule {}',
    '',
  ].join('\n'),
  [`${S}/entries/entries.module.ts`]: [
    "import { Module, Controller, Get } from '@nestjs/common';",
    "@Controller('entries') export class EntriesController { @Get() all() {} }",
    '@Module({ controllers: [EntriesController] })',
    'export class EntriesModule {}',
    '',
  ].join('\n'),
  'apps/web/package.json': json({ name: 'web', scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }),
  'apps/web/src/main.tsx': 'export {};\n',
};

/** A project source over a plain map, as the route's overlay looks to the lift. */
const source = (files: Record<string, string>, unreadable: string[] = []) => ({
  list: () => Object.keys(files).sort(),
  read: (p: string) => (unreadable.includes(p) ? undefined : files[p]),
  exists: (p: string) => p in files,
  glob: () => [],
  ensure: async () => {},
});

const nodeIds = (yaml: string) => (parse(yaml).spec.nodes as { id: string }[]).map((n) => n.id);

const answer = (extra: Record<string, unknown> = {}) => async () => ({
  refinement: {
    renames: {},
    infrastructure: [],
    descriptions: { accounts: 'Holds the accounts entries are posted to.' },
    summary: 'Ledger keeps accounts.\n\nEntries are posted to them.',
    ...extra,
  },
  docsCut: [],
});

test('a model failure on Update keeps the answer the last lift recorded', async () => {
  const first = await liftRepository(source(REPO), { projectName: 'Ledger', ask: answer() });
  assert.match(first.files['civil/architecture.md']!, /Ledger keeps accounts\./);

  // The README changes (so the model would be asked again) and the runner is down.
  const changed = { ...REPO, ...first.files, 'README.md': '# Ledger\n\nNow with budgets.\n' };
  const second = await liftRepository(source(changed), {
    projectName: 'Ledger',
    ask: async () => {
      throw new Error('runner down');
    },
  });
  assert.match(second.files['civil/architecture.md']!, /Ledger keeps accounts\./, "the reviewed words stay");
  assert.match(second.files['civil/architecture.md']!, /Holds the accounts entries are posted to\./);
  assert.match(second.note ?? '', /runner down.*The answer from the last lift was reused\./);
  const provenance = parse(second.files['civil/registry.yaml']!).lifted_from;
  assert.ok(provenance.refinement, 'still recorded');
  // Recorded under the fingerprint it was given for, so the next Update asks again.
  assert.equal(provenance.fingerprint, parse(first.files['civil/registry.yaml']!).lifted_from.fingerprint);

  let asked = 0;
  await liftRepository(source({ ...changed, ...second.files }), {
    projectName: 'Ledger',
    ask: async () => {
      asked += 1;
      return answer()();
    },
  });
  assert.equal(asked, 1, 'the model is asked again once it can be');
});

test('a recorded summary that was stored JSON-encoded is cleaned when it is reused', async () => {
  const first = await liftRepository(source(REPO), { projectName: 'Ledger', ask: answer() });
  // What an earlier version of the lift recorded: the summary as a quoted JSON string.
  const registry = parse(first.files['civil/registry.yaml']!);
  registry.lifted_from.refinement.summary = JSON.stringify('Ledger keeps accounts.\n\nEntries are posted to them.');
  const { stringify } = await import('yaml');
  const existing = { ...REPO, ...first.files, 'civil/registry.yaml': stringify(registry) };
  const again = await liftRepository(source(existing), { projectName: 'Ledger', ask: answer() });
  const md = again.files['civil/architecture.md']!;
  assert.match(md, /\n\nLedger keeps accounts\.\n\nEntries are posted to them\.\n/);
  assert.doesNotMatch(md, /\\n|"Ledger/);
});

test('the fingerprint ignores line numbers: moving code down a line asks nothing new', () => {
  const skeleton = readRepo(REPO);
  const shifted = readRepo({ ...REPO, [`${S}/accounts/accounts.module.ts`]: `\n\n${REPO[`${S}/accounts/accounts.module.ts`]}` });
  assert.notDeepEqual(skeleton.services[0]!.source, shifted.services[0]!.source);
  assert.equal(liftFingerprint(skeleton, {}), liftFingerprint(shifted, {}));
});

const PYTHON_PROJECT = {
  'civil/civil.yaml': 'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: shop\nspec:\n  composition: civil/app.yaml\n',
  'civil/app.yaml': [
    'apiVersion: civil/v1',
    'kind: Composition',
    'metadata:',
    '  id: shop',
    'spec:',
    '  nodes:',
    '    - id: orders',
    '      type: service',
    '      impl: { entrypoint: src/orders.py }',
    '  edges: []',
    'layout:',
    '  nodes: {}',
    '',
  ].join('\n'),
  'civil/registry.yaml': 'apiVersion: civil/v1\nkind: Registry\ngenerated_from: sha256:abc\nunits: {}\n',
};

test('a Python project Civil generates for is refused, with the reason, before anything is read into it', async () => {
  await assert.rejects(
    liftRepository(source({ ...REPO, ...PYTHON_PROJECT }), { projectName: 'Shop' }),
    (error: unknown) => error instanceof LiftRefusal && error.code === 'python_project' && /switch it to TypeScript/.test(error.message),
  );
  // An empty composition is a project with no design yet: offered.
  const empty = { ...PYTHON_PROJECT, 'civil/app.yaml': PYTHON_PROJECT['civil/app.yaml'].replace(/  nodes:\n[\s\S]*?  edges/, '  nodes: []\n  edges') };
  assert.equal(liftRefusal(empty, undefined), null);
  // And one a lift wrote (its registry says so) is an Update, not a refusal.
  const lifted = { ...PYTHON_PROJECT, 'civil/registry.yaml': 'apiVersion: civil/v1\nkind: Registry\nlifted_from:\n  fingerprint: sha256:x\nunits: {}\n' };
  assert.equal(liftRefusal(lifted, undefined), null);
});

test('documents still at the repository root are refused rather than shadowed', async () => {
  const legacy = {
    ...REPO,
    'civil.yaml': 'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: ledger\nspec:\n  composition: app.yaml\n',
    'app.yaml': 'apiVersion: civil/v1\nkind: Composition\nmetadata:\n  id: ledger\nspec:\n  nodes: []\n  edges: []\n',
  };
  await assert.rejects(
    liftRepository(source(legacy), { projectName: 'Ledger' }),
    (error: unknown) => error instanceof LiftRefusal && error.code === 'legacy_layout' && /Move them into civil\//.test(error.message),
  );
  const status = await liftStatus(source(legacy) as never);
  assert.equal(status.refusal?.error, 'legacy_layout');
});

test('a composition civil.yaml names outside civil/ is the one an Update merges into', async () => {
  const project = {
    ...REPO,
    'civil/civil.yaml': 'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: ledger\nspec:\n  composition: design/app.yaml\n  language: typescript\n',
    'design/app.yaml': [
      'apiVersion: civil/v1',
      'kind: Composition',
      'metadata:',
      '  id: ledger',
      'spec:',
      '  nodes:',
      '    - id: books',
      '      type: service',
      `      impl: { entrypoint: ${S}/accounts/accounts.module.ts }`,
      '  edges: []',
      'layout:',
      '  nodes:',
      '    books: { x: 1, y: 2 }',
      '',
    ].join('\n'),
  };
  const out = await liftRepository(source(project), { projectName: 'Ledger' });
  assert.ok(out.files['design/app.yaml'], 'written where civil.yaml points');
  assert.equal(out.files['civil/app.yaml'], undefined);
  const ids = nodeIds(out.files['design/app.yaml']!);
  assert.ok(ids.includes('books') && !ids.includes('accounts'), "the author's id for the accounts module holds");
  assert.match(out.files['design/app.yaml']!, /books: \{ x: 1, y: 2 \}/);
});

test('a selected file that could not be read is reported, not skipped silently', async () => {
  const out = await liftRepository(source(REPO, ['README.md']), { projectName: 'Ledger' });
  assert.ok(out.diagnostics.some((d) => /1 selected file could not be read.*README\.md/.test(d)));
});

test('liftStatus tells the canvas what a lifted node stands for', async () => {
  const first = await liftRepository(source(REPO), { projectName: 'Ledger', ask: answer() });
  const status = await liftStatus(source({ ...REPO, ...first.files }) as never);
  assert.equal(status.refusal, null);
  assert.equal(status.lifted, true);
  assert.deepEqual(status.units['accounts'], {
    files: [`${S}/accounts/accounts.module.ts`],
    description: 'Holds the accounts entries are posted to.',
  });
  // A Python project is told why, so the command is not offered and then refused.
  const python = await liftStatus(source({ ...REPO, ...PYTHON_PROJECT }) as never);
  assert.equal(python.refusal?.error, 'python_project');
  assert.equal(python.lifted, false);
});
