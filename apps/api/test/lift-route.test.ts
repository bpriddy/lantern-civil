import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { parse } from 'yaml';
import { registerLiftRoutes } from '../dist/http/lift-routes.js';
import { RunnerError, registerTranspileRoutes, transpileProject } from '../dist/http/transpile-routes.js';
import { applyState, generationRefusal } from '../dist/project/registry.js';

/**
 * POST /api/projects/:id/lift-repo (docs/lift-repo.md): reads the repository's code
 * and proposes civil/ documents. The contract pinned here is the one CLAUDE.md cares
 * about — owner-scoped, and every document lands as a pending change and nothing else
 * (no commit, no other table touched) — plus the other half of the feature: a project
 * whose civil.yaml says typescript is never generated for.
 *
 * The repository is a synthetic NestJS + Vite monorepo written to a temp directory and
 * opened as a local project; the pool is a fake that records every statement.
 */

const OWNER = 'owner-1';
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

const tmpRoots: string[] = [];
after(() => {
  for (const root of tmpRoots) fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a repo to a fresh temp directory and returns its path. */
function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'civil-lift-route-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A small, invented bookshelf app: one Nest server, one Vite client. */
const MONOREPO: Record<string, string> = {
  'package.json': json({ name: 'shelf', private: true, workspaces: ['apps/*'] }),
  'README.md': '# Shelf\n\nKeeps a list of books and who borrowed them.\n',
  'apps/server/package.json': json({
    name: '@shelf/server',
    scripts: { start: 'nest start' },
    dependencies: { '@nestjs/common': '^10.0.0', '@nestjs/core': '^10.0.0' },
  }),
  'apps/server/src/main.ts': [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    '',
    'async function bootstrap() {',
    '  const app = await NestFactory.create(AppModule);',
    "  app.setGlobalPrefix('api');",
    '  await app.listen(3000);',
    '}',
    'void bootstrap();',
    '',
  ].join('\n'),
  'apps/server/src/app.module.ts': [
    "import { Module } from '@nestjs/common';",
    "import { BooksModule } from './books/books.module';",
    '',
    '@Module({ imports: [BooksModule] })',
    'export class AppModule {}',
    '',
  ].join('\n'),
  'apps/server/src/books/books.module.ts': [
    "import { Module } from '@nestjs/common';",
    "import { BooksController } from './books.controller';",
    "import { BooksService } from './books.service';",
    '',
    '@Module({ controllers: [BooksController], providers: [BooksService] })',
    'export class BooksModule {}',
    '',
  ].join('\n'),
  'apps/server/src/books/books.controller.ts': [
    "import { Controller, Get, Param, Post } from '@nestjs/common';",
    "import { BooksService } from './books.service';",
    '',
    "@Controller('books')",
    'export class BooksController {',
    '  constructor(private readonly books: BooksService) {}',
    '',
    '  @Get()',
    '  list() {',
    '    return this.books.list();',
    '  }',
    '',
    "  @Post(':id/borrow')",
    "  borrow(@Param('id') id: string) {",
    '    return this.books.borrow(id);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'apps/server/src/books/books.service.ts': [
    "import { Injectable } from '@nestjs/common';",
    '',
    '@Injectable()',
    'export class BooksService {',
    '  list() {',
    '    return [];',
    '  }',
    '  borrow(id: string) {',
    '    return { id };',
    '  }',
    '}',
    '',
  ].join('\n'),
  'apps/web/package.json': json({
    name: '@shelf/web',
    scripts: { dev: 'vite' },
    dependencies: { react: '^18.0.0' },
    devDependencies: { vite: '^5.0.0' },
  }),
  'apps/web/vite.config.ts': [
    "import { defineConfig } from 'vite';",
    "export default defineConfig({ server: { proxy: { '/api': 'http://localhost:3000' } } });",
    '',
  ].join('\n'),
  'apps/web/src/main.tsx': [
    'export async function load() {',
    "  const response = await fetch('/api/books');",
    '  return response.json();',
    '}',
    '',
  ].join('\n'),
};

interface Recorded {
  sql: string;
  params: unknown[];
}

/**
 * A pool that knows one project (owned by OWNER, opened from `root`) and keeps
 * pending_changes in memory, so a second request sees what the first one saved.
 */
function fakePool(root: string, pending = new Map<string, Record<string, unknown>>()) {
  const statements: Recorded[] = [];
  const pool = {
    pending,
    statements,
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (sql.includes('FROM projects')) {
        const [id, owner] = params;
        if (id !== PROJECT_ID || owner !== OWNER) return { rows: [] };
        return {
          rows: [{
            id: PROJECT_ID,
            name: 'Shelf',
            sourceKind: 'local',
            localPath: root,
            exampleSlug: null,
            repoOwner: null,
            repoName: null,
            defaultBranch: 'main',
            branch: 'main',
            headSha: null,
            baseBranch: null,
            prNumber: null,
          }],
        };
      }
      if (sql.includes('INSERT INTO pending_changes')) {
        const [, , , p, kind, content] = params as string[];
        const row = {
          path: p, kind, fromPath: null, content, contentRef: null,
          sizeBytes: Buffer.byteLength(content!), baseBlobSha: null, baseCommitSha: null, updatedAt: 'now',
        };
        pending.set(p!, row);
        return { rows: [row] };
      }
      if (sql.includes('DELETE FROM pending_changes')) {
        const removed = pending.delete(params[3] as string);
        return { rows: [], rowCount: removed ? 1 : 0 };
      }
      if (sql.includes('FROM pending_changes')) {
        return { rows: [...pending.values()].sort((a, b) => String(a['path']).localeCompare(String(b['path']))) };
      }
      return { rows: [] };
    },
    // The route lands its writes in one transaction on a checked-out client; the fake
    // client is the pool itself, so BEGIN/COMMIT are recorded like any statement.
    connect: async () => ({ query: pool.query, release: () => {} }),
  };
  return pool;
}

async function serve(
  register: (app: ReturnType<typeof Fastify>, deps: { config: never; pool: never }) => void,
  pool: unknown,
  config: Record<string, unknown> = {},
  owner = OWNER,
) {
  const app = Fastify();
  app.decorateRequest('identity', null as never);
  app.addHook('onRequest', async (request) => {
    (request as unknown as { identity: { id: string } }).identity = { id: owner };
  });
  register(app, { config: { runnerUrl: undefined, ...config } as never, pool: pool as never });
  await app.ready();
  return app;
}

/** True for any statement that changes state outside pending_changes. */
const writesElsewhere = (statements: Recorded[]) =>
  statements.filter(
    (s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s.sql) && !/\bpending_changes\b/.test(s.sql),
  );

test('lift-repo lands every proposed document as a pending change, and nothing else', async () => {
  const pool = fakePool(repo(MONOREPO));
  const app = await serve(registerLiftRoutes, pool);
  const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/lift-repo` });
  await app.close();

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    files: string[]; summary: string; note: string | null; diagnostics: string[];
    counts: Record<string, number>;
  };

  assert.ok(body.files.length > 0, 'something was proposed');
  assert.ok(body.files.every((p) => p.startsWith('civil/')), `only civil/ documents: ${body.files}`);
  assert.deepEqual([...pool.pending.keys()].sort(), [...body.files].sort(), 'every file is a pending row');
  for (const row of pool.pending.values()) assert.equal(row['kind'], 'add', 'none exists at HEAD');
  assert.deepEqual(writesElsewhere(pool.statements), [], 'no commit, no other table');
  // Every pending write is scoped to the owner.
  for (const s of pool.statements.filter((s) => s.sql.includes('pending_changes'))) {
    assert.equal(s.params[0], OWNER);
  }

  // The settled decision: a lifted NestJS project is a typescript project.
  const civil = parse(pool.pending.get('civil/civil.yaml')!['content'] as string) as {
    spec: { language?: string };
  };
  assert.equal(civil.spec.language, 'typescript');

  // No runner configured: the deterministic result stands, and the note says why.
  assert.match(body.note ?? '', /runner/i);
  assert.equal(body.counts['servers'], 1);
  assert.equal(body.counts['clients'], 1);
  assert.equal(body.counts['written'], body.files.length);
  assert.ok(body.counts['filesRead']! > 0 && body.counts['filesRead']! <= body.counts['filesListed']!);
  assert.match(body.summary, /pending/);
});

test('running it again over its own unreviewed proposal changes nothing', async () => {
  const root = repo(MONOREPO);
  const pool = fakePool(root);
  const first = await serve(registerLiftRoutes, pool);
  await first.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/lift-repo` });
  await first.close();
  const before = new Map(pool.pending);

  // Update reads the pending documents as the existing ones and merges with them.
  const again = fakePool(root, pool.pending);
  const second = await serve(registerLiftRoutes, again);
  const response = await second.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/lift-repo` });
  await second.close();

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as { files: string[]; summary: string; counts: Record<string, number> };
  assert.deepEqual(body.files, [], 'an unchanged repo proposes no diff');
  // Said once: the mapper's sentence, with no second "nothing changed" after it.
  assert.equal(body.summary, 'civil/ already matches the repository — nothing to change.');
  assert.equal(body.counts['unchanged'], before.size);
  assert.deepEqual(
    [...again.pending.entries()].map(([p, r]) => [p, r['content']]),
    [...before.entries()].map(([p, r]) => [p, r['content']]),
  );
});

test("someone else's project is not found, and nothing is read or written", async () => {
  const pool = fakePool(repo(MONOREPO));
  const app = await serve(registerLiftRoutes, pool, {}, 'stranger');
  const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/lift-repo` });
  await app.close();

  assert.equal(response.statusCode, 404);
  assert.equal(pool.pending.size, 0);
  assert.ok(pool.statements.every((s) => s.sql.includes('FROM projects')), 'only the ownership lookup ran');
});

test('a repository with no server or client is answered, not filled with an empty sketch', async () => {
  const pool = fakePool(repo({ 'package.json': json({ name: 'plain' }), 'src/index.ts': 'export {};\n' }));
  const app = await serve(registerLiftRoutes, pool);
  const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/lift-repo` });
  await app.close();

  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error, 'nothing_recognized');
  assert.equal(pool.pending.size, 0, 'nothing was saved');
});

// ---------------------------------------------------------------------------
// Generation refusal: Civil emits Python only, so a typescript project gets none.
// ---------------------------------------------------------------------------

const civilYaml = (language?: string) =>
  [
    'apiVersion: civil/v1',
    'kind: Project',
    'metadata:',
    '  id: shelf',
    'spec:',
    '  composition: civil/app.yaml',
    ...(language ? [`  language: ${language}`] : []),
    '',
  ].join('\n');

const memory = (files: Record<string, string>) => ({
  exists: (p: string) => p in files,
  read: (p: string) => files[p],
  list: () => Object.keys(files).sort(),
  glob: () => [] as string[],
});

test('the transpile route refuses a typescript project with a plain reason, runner or not', async () => {
  const root = repo({ ...MONOREPO, 'civil/civil.yaml': civilYaml('typescript') });
  for (const runnerUrl of [undefined, 'http://127.0.0.1:9']) {
    const pool = fakePool(root);
    const app = await serve(registerTranspileRoutes, pool, { runnerUrl });
    const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/transpile` });
    await app.close();

    assert.equal(response.statusCode, 409, response.body);
    const body = response.json() as { error: string; message: string };
    assert.equal(body.error, 'language_unsupported');
    assert.match(body.message, /TypeScript/);
    assert.match(body.message, /implementation/);
    assert.equal(pool.pending.size, 0, 'nothing generated');
  }
});

test('transpileProject refuses before any model work, so composition Run refuses too', async () => {
  const overlay = memory({ 'civil/civil.yaml': civilYaml('typescript') });
  const queries: string[] = [];
  await assert.rejects(
    transpileProject(
      // An unreachable runner: reaching it would fail differently (502), so a 409
      // proves the refusal came first.
      { config: { runnerUrl: 'http://127.0.0.1:9' }, pool: { query: async (sql: string) => (queries.push(sql), { rows: [] }) } } as never,
      OWNER,
      { id: PROJECT_ID, branch: 'main' } as never,
      memory({}) as never,
      overlay as never,
    ),
    (error: unknown) =>
      error instanceof RunnerError && error.status === 409 && error.body['error'] === 'language_unsupported',
  );
  assert.deepEqual(queries, [], 'refused before touching the database');
});

test("generation state is 'unsupported' for typescript and unchanged for python", () => {
  const fp = 'sha256:abc';
  assert.equal(applyState(memory({ 'civil/civil.yaml': civilYaml('typescript') }) as never, fp), 'unsupported');
  assert.equal(applyState(memory({ 'civil/civil.yaml': civilYaml('python') }) as never, fp), 'never');
  // No language at all is python, as every project written before the field widened.
  assert.equal(applyState(memory({ 'civil/civil.yaml': civilYaml() }) as never, fp), 'never');
  // Legacy root civil.yaml is read too.
  assert.equal(applyState(memory({ 'civil.yaml': civilYaml('typescript') }) as never, fp), 'unsupported');
  assert.equal(generationRefusal(memory({ 'civil/civil.yaml': civilYaml() }) as never), null);
});

/** The project as liftRepository reads it: the repo, plus civil/ documents over it. */
const memorySource = (files: Record<string, string>) => ({
  list: () => Object.keys(files).sort(),
  read: (p: string) => files[p],
  exists: (p: string) => p in files,
  glob: () => [] as string[],
});

test('Update over unchanged code reuses the recorded model answer instead of asking again', async () => {
  // docs/lift-repo.md: the model words things differently each call, so asking again
  // over the same code would make every Update a diff of rephrasings. The registry
  // records what the lift was read from (lifted_from) and the validated answer.
  const { liftRepository } = await import('../dist/lift/index.js');
  let asked = 0;
  const answer = (summary: string) => async () => {
    asked += 1;
    return {
      refinement: { renames: {}, infrastructure: [], descriptions: { books: 'Lends books.' }, summary },
      attempts: 1,
      docsCut: [],
      promptVersion: '1',
    };
  };

  const first = await liftRepository(memorySource(MONOREPO) as never, { projectName: 'Shelf', ask: answer('First wording.') });
  assert.equal(asked, 1);
  assert.match(first.files['civil/registry.yaml']!, /lifted_from:\n {2}fingerprint: sha256:/);
  assert.match(first.files['civil/architecture.md']!, /First wording\./);

  // Same code, a model that would now say something else: it is not asked, and the
  // documents come out byte for byte as they are.
  const again = await liftRepository(memorySource({ ...MONOREPO, ...first.files }) as never, {
    projectName: 'Shelf',
    ask: answer('A different wording.'),
  });
  assert.equal(asked, 1, 'the model was not asked again');
  assert.equal(again.note, null);
  for (const [p, content] of Object.entries(again.files)) assert.equal(content, first.files[p], p);

  // The code changes: the fingerprint moves, and the model is asked about the new code.
  const changed = {
    ...MONOREPO,
    ...first.files,
    'README.md': '# Shelf\n\nKeeps a list of books, who borrowed them, and when.\n',
  };
  const later = await liftRepository(memorySource(changed) as never, { projectName: 'Shelf', ask: answer('Second wording.') });
  assert.equal(asked, 2);
  assert.match(later.files['civil/architecture.md']!, /Second wording\./);
});

test('the proposal lands in one transaction', async () => {
  const pool = fakePool(repo(MONOREPO));
  const app = await serve(registerLiftRoutes, pool);
  const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/lift-repo` });
  await app.close();
  assert.equal(response.statusCode, 200, response.body);
  const sql = pool.statements.map((s) => s.sql.trim().split(/\s+/)[0]);
  const begin = sql.indexOf('BEGIN');
  const commit = sql.indexOf('COMMIT');
  const inserts = sql.flatMap((verb, i) => (verb === 'INSERT' ? [i] : []));
  assert.ok(begin >= 0 && commit > begin, 'BEGIN … COMMIT');
  assert.ok(inserts.length > 0 && inserts.every((i) => i > begin && i < commit), 'every write inside it');
});

test('a Python project Civil generates for is refused with the reason, and nothing is written', async () => {
  const python = {
    ...MONOREPO,
    'civil/civil.yaml': 'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: shelf\nspec:\n  composition: civil/app.yaml\n',
    'civil/app.yaml': [
      'apiVersion: civil/v1',
      'kind: Composition',
      'metadata:',
      '  id: shelf',
      'spec:',
      '  nodes:',
      '    - id: books',
      '      type: service',
      '      impl: { entrypoint: src/books.py }',
      '  edges: []',
      '',
    ].join('\n'),
  };
  const pool = fakePool(repo(python));
  const app = await serve(registerLiftRoutes, pool);
  const response = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/lift-repo` });
  await app.close();
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json().error, 'python_project');
  assert.match(response.json().message, /Python project Civil generates code for/);
  assert.equal(pool.pending.size, 0);
  assert.ok(!pool.statements.some((s) => /INSERT|DELETE/.test(s.sql)), 'not a single write');
});
