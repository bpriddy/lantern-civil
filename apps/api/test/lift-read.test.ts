import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRepo, selectLiftPaths, selectLiftPathsReport, LIFT_PATH_CAP } from '../dist/lift/read.js';
import { cronExpressionName, intervalToCron } from '../dist/lift/nest.js';
import { skeletonToDocuments } from '../dist/lift/to-documents.js';
import { parse } from 'yaml';

/**
 * The deterministic reader over synthetic repos written as in-memory file maps — no
 * filesystem, exactly as the server path runs it. The fixture is a small NestJS +
 * Vite monorepo that exercises each thing the reader claims to understand: a global
 * prefix from a workspace constant with an exclusion, a path alias, a barrel, a
 * forwardRef cycle, an array route path, an agent with a tool, an infrastructure
 * module, a cron job, and a provider list the reader must admit it cannot read.
 */

const json = (v: unknown) => JSON.stringify(v, null, 2);

const repo: Record<string, string> = {
  'package.json': json({ name: 'acme', private: true, workspaces: ['apps/*', 'packages/*'] }),
  'README.md': '# Acme\n\nA notes app.\n',

  // The shared package both apps import: the prefix lives here.
  'packages/contracts/package.json': json({ name: '@acme/contracts', type: 'module' }),
  'packages/contracts/src/index.ts': `export * from './routes.js';\n`,
  'packages/contracts/src/routes.ts': `export const API_ROOT = 'api';\nexport const ROUTES = { notes: 'notes' } as const;\n`,

  'apps/server/package.json': json({
    name: '@acme/server',
    scripts: { start: 'node dist/main.js' },
    dependencies: {
      '@acme/contracts': '*',
      '@nestjs/common': '^11.0.0',
      '@nestjs/core': '^11.0.0',
      '@nestjs/config': '^4.0.0',
      '@nestjs/schedule': '^6.0.0',
      '@anthropic-ai/sdk': '^0.60.0',
    },
  }),
  'apps/server/tsconfig.json': `{
  // comments are allowed here, as in any tsconfig
  "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"] } }
}`,
  'apps/server/src/main.ts': `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configure } from './configure.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configure(app);
  await app.listen(3000);
}
void bootstrap();
`,
  // The prefix is set in a helper, not beside NestFactory.create, and comes from
  // the shared package — both have to be followed.
  'apps/server/src/configure.ts': `import type { INestApplication } from '@nestjs/common';
import { API_ROOT } from '@acme/contracts';

export function configure(app: INestApplication) {
  app.setGlobalPrefix(\`/\${API_ROOT}/\`, { exclude: ['health'] });
}
`,
  'apps/server/src/app.module.ts': `import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health.controller.js';
import { NotesModule } from './notes/index.js';
import { ProjectsModule } from './projects/projects.module.js';

@Module({
  imports: [ConfigModule.forRoot(), ScheduleModule.forRoot(), DatabaseModule, ProjectsModule, NotesModule],
  controllers: [HealthController],
})
export class AppModule {}
`,
  'apps/server/src/health.controller.ts': `import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  check() {
    return { ok: true };
  }
}
`,

  // Infrastructure: global, provides the database to everyone.
  'apps/server/src/database/database.module.ts': `import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service.js';

@Global()
@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
`,
  'apps/server/src/database/database.service.ts': `import { Injectable } from '@nestjs/common';

@Injectable()
export class DatabaseService {
  query(sql: string) {
    return [sql];
  }
}
`,

  // Projects: forwardRef to notes (they import each other), an array route path, and
  // a provider list partly computed by a call the reader must report, not guess.
  'apps/server/src/projects/projects.module.ts': `import { Module, forwardRef } from '@nestjs/common';
import { NotesModule } from '../notes/index.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { extraProviders } from './extras.js';

@Module({
  imports: [forwardRef(() => NotesModule)],
  controllers: [ProjectsController],
  providers: [ProjectsService, ...extraProviders()],
  exports: [ProjectsService],
})
export class ProjectsModule {}
`,
  'apps/server/src/projects/extras.ts': `export const extraProviders = () => [];\n`,
  'apps/server/src/projects/projects.controller.ts': `import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list() {
    return this.projects.list();
  }

  @Get(['archive', 'archived'])
  archived() {
    return [];
  }

  @Post()
  create(@Body() body: unknown) {
    return body;
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return id;
  }
}
`,
  'apps/server/src/projects/projects.service.ts': `import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@app/database/database.service';

@Injectable()
export class ProjectsService {
  constructor(private readonly db: DatabaseService) {}
  list() {
    return this.db.query('select * from projects');
  }
}
`,

  // Notes: reached through a barrel; uses the summarizer agent; runs a cron job.
  'apps/server/src/notes/index.ts': `export { NotesModule } from './notes.module.js';\n`,
  'apps/server/src/notes/notes.module.ts': `import { Module, forwardRef } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module.js';
import { SummarizerAgent } from '../agents/summarizer/agent.js';
import { NotesController } from './notes.controller.js';
import { NotesDigest } from './notes.digest.js';
import { NotesService } from './notes.service.js';

@Module({
  imports: [forwardRef(() => ProjectsModule)],
  controllers: [NotesController],
  providers: [NotesService, NotesDigest, SummarizerAgent],
})
export class NotesModule {}
`,
  'apps/server/src/notes/notes.controller.ts': `import { Controller, Get, Param, Patch } from '@nestjs/common';
import { ROUTES } from '@acme/contracts';
import { NotesService } from './notes.service.js';

@Controller({ path: ROUTES.notes })
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get(':id/summary')
  summary(@Param('id') id: string) {
    return this.notes.summarize(id);
  }

  @Patch(':id')
  update(@Param('id') id: string) {
    return id;
  }
}
`,
  'apps/server/src/notes/notes.service.ts': `import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { SummarizerAgent } from '../agents/summarizer/agent.js';
import { ProjectsService } from '../projects/projects.service.js';

@Injectable()
export class NotesService {
  constructor(
    private readonly summarizer: SummarizerAgent,
    @Inject(forwardRef(() => ProjectsService)) private readonly projects: ProjectsService,
  ) {}
  summarize(id: string) {
    return this.summarizer.run(id);
  }
}
`,
  'apps/server/src/notes/notes.digest.ts': `import { Injectable } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { NotesService } from './notes.service.js';

@Injectable()
export class NotesDigest {
  constructor(private readonly notes: NotesService) {}

  @Cron('0 7 * * *', { name: 'morning-digest' })
  sendDigest() {}

  @Cron(CronExpression.EVERY_HOUR)
  compact() {}

  @Interval(300000)
  refreshCache() {}
}
`,
  'apps/server/src/agents/summarizer/agent.ts': `import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { SYSTEM_PROMPT } from './prompt.js';
import { lookupNote } from './tools/lookup-note.js';

@Injectable()
export class SummarizerAgent {
  private readonly client = new Anthropic();
  run(id: string) {
    return this.client.messages.create({
      model: 'm',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools: [lookupNote],
      messages: [{ role: 'user', content: id }],
    });
  }
}
`,
  'apps/server/src/agents/summarizer/prompt.ts': `export const SYSTEM_PROMPT = 'Summarize the note.';\n`,
  'apps/server/src/agents/summarizer/tools/lookup-note.ts': `export const lookupNote = { name: 'lookup_note', input_schema: { type: 'object' } };\n`,
  // A spec beside the code is never read (selectLiftPaths drops it anyway).
  'apps/server/src/notes/notes.service.spec.ts': `throw new Error('not read');\n`,

  'apps/web/package.json': json({
    name: '@acme/web',
    scripts: { dev: 'vite', build: 'vite build' },
    dependencies: { '@acme/contracts': '*', react: '^19.0.0' },
    devDependencies: { vite: '^7.0.0' },
  }),
  'apps/web/vite.config.ts': `import { defineConfig } from 'vite';\nexport default defineConfig({});\n`,
  'apps/web/src/main.tsx': `export const App = () => <h1>Notes</h1>;\n`,
};

const loaded = (all: Record<string, string>) =>
  Object.fromEntries(selectLiftPaths(Object.keys(all)).map((p) => [p, all[p]!]));

test('selectLiftPaths keeps manifests, source and docs, and drops tests, builds and vendored code', () => {
  const paths = selectLiftPaths([
    ...Object.keys(repo),
    'node_modules/@nestjs/core/package.json',
    'apps/server/dist/main.js',
    'apps/server/src/types.d.ts',
    'apps/web/e2e/smoke.ts',
    'apps/web/src/app.test.tsx',
    'apps/server/scripts/seed.ts',
    'docs/architecture/overview.md',
    'docs/logo.png',
  ]);
  assert.ok(paths.includes('apps/server/src/notes/notes.module.ts'));
  assert.ok(paths.includes('apps/web/vite.config.ts'), 'a vite.config sits outside src/ and is still read');
  assert.ok(paths.includes('apps/server/tsconfig.json'), 'tsconfig is read for path aliases');
  assert.ok(paths.includes('docs/architecture/overview.md'));
  assert.ok(paths.includes('README.md'));
  for (const gone of [
    'node_modules/@nestjs/core/package.json',
    'apps/server/dist/main.js',
    'apps/server/src/types.d.ts',
    'apps/web/e2e/smoke.ts',
    'apps/web/src/app.test.tsx',
    'apps/server/src/notes/notes.service.spec.ts',
    'apps/server/scripts/seed.ts',
    'docs/logo.png',
  ])
    assert.ok(!paths.includes(gone), `${gone} is not read`);
  // Manifests first, so a cap drops prose and code before the map of the repo.
  assert.equal(paths[0], 'apps/server/package.json');
});

test('selectLiftPaths caps the load and reports what it dropped', () => {
  const many = Array.from({ length: LIFT_PATH_CAP + 10 }, (_, i) => `apps/x/src/f${String(i).padStart(5, '0')}.ts`);
  const report = selectLiftPathsReport(['apps/x/package.json', ...many]);
  assert.equal(report.paths.length, LIFT_PATH_CAP);
  assert.equal(report.dropped, 11);
  assert.equal(report.paths[0], 'apps/x/package.json', 'the manifest survives the cap');
});

test('readRepo reads the NestJS + Vite fixture into the full skeleton', () => {
  const skeleton = readRepo(loaded(repo));
  const S = 'apps/server/src';

  assert.deepEqual(skeleton.frameworks, ['nestjs', 'vite']);

  assert.deepEqual(skeleton.clients, [
    {
      id: 'web',
      path: 'apps/web',
      framework: 'vite',
      devScript: 'vite',
      devScriptName: 'dev',
      calls: ['server'],
      source: { file: 'apps/web/vite.config.ts' },
    },
  ]);

  assert.equal(skeleton.servers.length, 1);
  const server = skeleton.servers[0]!;
  // Code no module or agent owns: the bootstrap and the helper it calls.
  assert.deepEqual(server.sharedFiles, [`${S}/configure.ts`, `${S}/main.ts`]);
  assert.deepEqual(
    { ...server, routes: undefined, sharedFiles: undefined },
    {
      sharedFiles: undefined,
      id: 'server',
      path: 'apps/server',
      framework: 'nestjs',
      globalPrefix: 'api',
      routes: undefined,
      exposes: ['app', 'notes', 'projects'],
      source: { file: `${S}/main.ts`, line: 6 },
    },
  );
  assert.deepEqual(
    server.routes.map((r) => `${r.method} ${r.path} ${r.controller}.${r.handler}`),
    [
      // /health is excluded from the prefix, as setGlobalPrefix's exclude says.
      'PATCH /api/notes/:id NotesController.update',
      'GET /api/notes/:id/summary NotesController.summary',
      'GET /api/projects ProjectsController.list',
      'POST /api/projects ProjectsController.create',
      'DELETE /api/projects/:id ProjectsController.remove',
      'GET /api/projects/archive ProjectsController.archived',
      'GET /api/projects/archived ProjectsController.archived',
      'GET /health HealthController.check',
    ],
  );
  assert.deepEqual(server.routes.find((r) => r.handler === 'remove')!.source, { file: `${S}/projects/projects.controller.ts`, line: 23 });

  // Ownership, separately from the shape below: a module that is alone in its
  // directory owns all of it; the root, beside the bootstrap, owns only its own files.
  assert.deepEqual(
    Object.fromEntries(skeleton.services.map((s) => [s.id, { files: s.files, directory: s.directory ?? null, root: s.root ?? false }])),
    {
      app: { files: [`${S}/app.module.ts`, `${S}/health.controller.ts`], directory: null, root: true },
      database: {
        files: [`${S}/database/database.module.ts`, `${S}/database/database.service.ts`],
        directory: `${S}/database`,
        root: false,
      },
      notes: {
        // index.ts is a barrel nothing declares: the directory claims it all the same.
        files: [`${S}/notes/index.ts`, `${S}/notes/notes.controller.ts`, `${S}/notes/notes.digest.ts`, `${S}/notes/notes.module.ts`, `${S}/notes/notes.service.ts`],
        directory: `${S}/notes`,
        root: false,
      },
      projects: {
        files: [`${S}/projects/extras.ts`, `${S}/projects/projects.controller.ts`, `${S}/projects/projects.module.ts`, `${S}/projects/projects.service.ts`],
        directory: `${S}/projects`,
        root: false,
      },
    },
  );
  assert.deepEqual(skeleton.services.map(({ files: _f, directory: _d, root: _r, ...rest }) => rest), [
    {
      id: 'app',
      server: 'server',
      moduleClass: 'AppModule',
      source: { file: `${S}/app.module.ts`, line: 9 },
      controllers: [{ name: 'HealthController', file: `${S}/health.controller.ts` }],
      providers: [],
      dependsOn: ['database', 'notes', 'projects'],
      agents: [],
      // Only a health controller: plumbing, by its class names.
      infrastructure: true,
    },
    {
      id: 'database',
      server: 'server',
      moduleClass: 'DatabaseModule',
      source: { file: `${S}/database/database.module.ts`, line: 4 },
      controllers: [],
      providers: [{ name: 'DatabaseService', file: `${S}/database/database.service.ts` }],
      dependsOn: [],
      agents: [],
      infrastructure: true,
    },
    {
      id: 'notes',
      server: 'server',
      moduleClass: 'NotesModule',
      source: { file: `${S}/notes/notes.module.ts`, line: 8 },
      controllers: [{ name: 'NotesController', file: `${S}/notes/notes.controller.ts` }],
      providers: [
        { name: 'NotesService', file: `${S}/notes/notes.service.ts` },
        { name: 'NotesDigest', file: `${S}/notes/notes.digest.ts` },
        { name: 'SummarizerAgent', file: `${S}/agents/summarizer/agent.ts` },
      ],
      // forwardRef import + the @Inject(forwardRef(...)) injection, both to projects.
      dependsOn: ['projects'],
      agents: ['summarizer'],
      infrastructure: false,
    },
    {
      id: 'projects',
      server: 'server',
      moduleClass: 'ProjectsModule',
      source: { file: `${S}/projects/projects.module.ts`, line: 7 },
      controllers: [{ name: 'ProjectsController', file: `${S}/projects/projects.controller.ts` }],
      providers: [{ name: 'ProjectsService', file: `${S}/projects/projects.service.ts` }],
      // notes by forwardRef; database by injection, through the @app/* path alias.
      dependsOn: ['database', 'notes'],
      agents: [],
      infrastructure: false,
    },
  ]);

  assert.deepEqual(skeleton.agents, [
    {
      id: 'summarizer',
      files: [
        `${S}/agents/summarizer/agent.ts`,
        `${S}/agents/summarizer/prompt.ts`,
        `${S}/agents/summarizer/tools/lookup-note.ts`,
      ],
      tools: [{ name: 'lookup-note', file: `${S}/agents/summarizer/tools/lookup-note.ts` }],
      source: { file: `${S}/agents/summarizer/agent.ts` },
    },
  ]);

  assert.deepEqual(skeleton.processes, [
    { id: 'morning-digest', schedule: '0 7 * * *', calls: ['notes'], source: { file: `${S}/notes/notes.digest.ts`, line: 9 } },
    { id: 'compact', schedule: '0 * * * *', calls: ['notes'], source: { file: `${S}/notes/notes.digest.ts`, line: 12 } },
    { id: 'refresh-cache', schedule: '*/5 * * * *', calls: ['notes'], source: { file: `${S}/notes/notes.digest.ts`, line: 15 } },
  ]);

  // The one thing it could not read is reported, with where.
  assert.deepEqual(skeleton.unresolved, [
    {
      file: `${S}/projects/projects.module.ts`,
      line: 10,
      reason: 'ProjectsModule.providers: "extraProviders()" is computed by a call',
    },
  ]);
});

test('ids are unique across kinds: an agent named like its service takes a suffix', () => {
  const files = { ...repo };
  for (const [path, content] of Object.entries(repo)) {
    if (!path.includes('/agents/summarizer/')) continue;
    delete files[path];
    files[path.replace('/agents/summarizer/', '/agents/notes/')] = content;
  }
  files[`apps/server/src/notes/notes.module.ts`] = repo['apps/server/src/notes/notes.module.ts']!.replace('agents/summarizer', 'agents/notes');
  files[`apps/server/src/notes/notes.service.ts`] = repo['apps/server/src/notes/notes.service.ts']!.replace('agents/summarizer', 'agents/notes');
  const skeleton = readRepo(loaded(files));
  assert.deepEqual(skeleton.agents.map((a) => a.id), ['notes-agent']);
  assert.deepEqual(skeleton.services.find((s) => s.id === 'notes')!.agents, ['notes-agent']);
  // Same code, same ids: reading twice is identical.
  assert.deepEqual(readRepo(loaded(files)), skeleton);
});

test('a repo with neither NestJS nor Vite reads to an empty skeleton that says why', () => {
  const skeleton = readRepo({
    'package.json': json({ name: 'tool', dependencies: { express: '^5.0.0' } }),
    'src/index.ts': 'export const x = 1;\n',
  });
  assert.deepEqual(
    { ...skeleton, unresolved: [] },
    { clients: [], servers: [], services: [], agents: [], processes: [], unresolved: [], frameworks: [] },
  );
  assert.equal(skeleton.unresolved.length, 1);
  assert.match(skeleton.unresolved[0]!.reason, /no supported framework found/);

  const nothing = readRepo({ 'README.md': '# hi\n' });
  assert.match(nothing.unresolved[0]!.reason, /no package\.json found/);

  // A broken manifest is reported, not thrown.
  const broken = readRepo({ 'package.json': '{ nope' });
  assert.ok(broken.unresolved.some((u) => /does not parse/.test(u.reason)));
});

test('a server without a bootstrap still reads, and says the bootstrap is missing', () => {
  const files = { ...repo };
  delete files['apps/server/src/main.ts'];
  const skeleton = readRepo(loaded(files));
  assert.ok(skeleton.unresolved.some((u) => /no NestFactory\.create/.test(u.reason)));
  assert.equal(skeleton.servers[0]!.source.file, 'apps/server/package.json');
  assert.deepEqual(skeleton.services.map((s) => s.id), ['app', 'database', 'notes', 'projects']);
});

test('schedules: CronExpression names and intervals become cron', () => {
  assert.equal(cronExpressionName('EVERY_10_MINUTES'), '*/10 * * * *');
  assert.equal(cronExpressionName('EVERY_DAY_AT_6PM'), '0 18 * * *');
  assert.equal(cronExpressionName('EVERY_DAY_AT_12AM'), '0 0 * * *');
  assert.equal(cronExpressionName('NOT_A_THING'), null);
  assert.equal(intervalToCron(30_000), '* * * * *');
  assert.equal(intervalToCron(2 * 3_600_000), '0 */2 * * *');
});

test('an agent another agent calls is used by the service that runs the first', () => {
  const files = { ...repo };
  const A = 'apps/server/src/agents/summarizer';
  files[`${A}/critic-agent.ts`] = `import Anthropic from '@anthropic-ai/sdk';
export class CriticAgent {
  private readonly client = new Anthropic();
  review(text: string) {
    return this.client.messages.create({ model: 'm', max_tokens: 64, messages: [{ role: 'user', content: text }] });
  }
}
`;
  files[`${A}/critic-prompt.ts`] = `export const CRITIC_PROMPT = 'Be critical.';\n`;
  files[`${A}/agent.ts`] = repo[`${A}/agent.ts`]!
    .replace(`import { lookupNote }`, `import { CriticAgent } from './critic-agent.js';\nimport { lookupNote }`)
    .replace('private readonly client', 'private readonly critic = new CriticAgent();\n  private readonly client');
  const skeleton = readRepo(loaded(files));
  assert.deepEqual(
    skeleton.agents.map((a) => [a.id, a.files.map((f) => f.slice(A.length + 1))]),
    [
      ['critic', ['critic-agent.ts', 'critic-prompt.ts']],
      ['summarizer', ['agent.ts', 'prompt.ts', 'tools/lookup-note.ts']],
    ],
  );
  assert.deepEqual(skeleton.services.find((s) => s.id === 'notes')!.agents, ['critic', 'summarizer']);
});

test('outside agents/, a file is an agent only if it imports a model SDK and generates', () => {
  const files = { ...repo };
  const S = 'apps/server/src/projects';
  files[`${S}/classifier.service.ts`] = `import OpenAI from 'openai';
export class ClassifierService {
  private readonly ai = new OpenAI();
  classify(text: string) {
    return this.ai.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: text }] });
  }
}
`;
  files[`${S}/embedder.ts`] = `import OpenAI from 'openai';
export const embed = (t: string) => new OpenAI().embeddings.create({ model: 'e', input: t });
`;
  files['apps/server/package.json'] = files['apps/server/package.json']!.replace('"@nestjs/common"', '"openai": "^5.0.0",\n    "@nestjs/common"');
  files[`${S}/projects.service.ts`] = repo[`${S}/projects.service.ts`]!.replace(
    `import { Injectable }`,
    `import { ClassifierService } from './classifier.service.js';\nimport { Injectable }`,
  ).replace('list() {', 'readonly classifier = new ClassifierService();\n  list() {');
  const skeleton = readRepo(loaded(files));
  assert.deepEqual(skeleton.agents.map((a) => [a.id, a.files]), [
    ['classifier', [`${S}/classifier.service.ts`]],
    ['summarizer', skeleton.agents[1]!.files],
  ]);
  assert.deepEqual(skeleton.services.find((s) => s.id === 'projects')!.agents, ['classifier']);
});

// --- one package, two deployments ---------------------------------------------------

/**
 * A second synthetic repo, "kiln": the bootstrap picks AppModule or JobsModule by an
 * environment variable — one package deployed twice, a public app and an internal
 * jobs service a cloud scheduler posts to. The app queues work for the jobs service by
 * naming its route; the jobs service runs a grader agent that hands part of its work
 * to a critic agent. pnpm runs the workspace.
 */
const K = 'apps/kiln/src';
const kiln: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'kiln', private: true, packageManager: 'pnpm@9.1.0' }),
  'pnpm-workspace.yaml': "packages: ['apps/*']\n",
  'apps/web/package.json': JSON.stringify({ name: '@kiln/web', scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }),
  'apps/web/vite.config.ts': 'export default {};',
  'apps/web/src/main.tsx': 'export {};',
  'apps/kiln/package.json': JSON.stringify({ name: '@kiln/kiln', dependencies: { '@nestjs/core': '10', '@nestjs/common': '10' } }),
  [`${K}/main.ts`]: [
    "import { NestFactory } from '@nestjs/core';",
    "import { AppModule } from './app.module';",
    "import { JobsModule } from './jobs.module';",
    "import { tidy } from './shared/clock';",
    'const app = await NestFactory.create(process.env.MODE === "jobs" ? JobsModule : AppModule);',
    "app.setGlobalPrefix('api', { exclude: ['healthz', 'internal/{*splat}'] });",
    'tidy();',
  ].join('\n'),
  [`${K}/shared/clock.ts`]: 'export const tidy = () => 0;',
  [`${K}/health.controller.ts`]: [
    "import { Controller, Get } from '@nestjs/common';",
    '@Controller()',
    'export class HealthController { @Get(\'healthz\') check() {} }',
  ].join('\n'),
  [`${K}/app.module.ts`]: [
    "import { Module } from '@nestjs/common';",
    "import { HealthController } from './health.controller';",
    "import { KilnsModule } from './kilns/kilns.module';",
    '@Module({ imports: [KilnsModule], controllers: [HealthController] })',
    'export class AppModule {}',
  ].join('\n'),
  [`${K}/jobs.module.ts`]: [
    "import { Module } from '@nestjs/common';",
    "import { HealthController } from './health.controller';",
    "import { JobsController } from './jobs.controller';",
    "import { graderProvider } from './agents';",
    '@Module({ controllers: [HealthController, JobsController], providers: [graderProvider] })',
    'export class JobsModule {}',
  ].join('\n'),
  [`${K}/jobs.controller.ts`]: [
    "import { Controller, Post } from '@nestjs/common';",
    "import { summarize } from './jobs.summary';",
    "@Controller('internal')",
    'export class JobsController {',
    "  @Post('fire') fire() { return summarize(); }",
    "  @Post('nightly') nightly() {}",
    '}',
  ].join('\n'),
  [`${K}/jobs.summary.ts`]: 'export const summarize = () => 1;',
  [`${K}/agents/index.ts`]: [
    "import { GraderAgent } from './grader/grader-agent';",
    "export const graderProvider = { provide: 'GRADER', useFactory: () => new GraderAgent() };",
  ].join('\n'),
  [`${K}/agents/grader/grader-agent.ts`]: [
    "import { CriticAgent } from '../critic/critic-agent';",
    'export class GraderAgent { critic = new CriticAgent(); }',
  ].join('\n'),
  [`${K}/agents/critic/critic-agent.ts`]: 'export class CriticAgent {}',
  [`${K}/kilns/kilns.module.ts`]: [
    "import { Module } from '@nestjs/common';",
    "import { KilnsController } from './kilns.controller';",
    "import { KilnsService } from './kilns.service';",
    '@Module({ controllers: [KilnsController], providers: [KilnsService] })',
    'export class KilnsModule {}',
  ].join('\n'),
  [`${K}/kilns/kilns.controller.ts`]: [
    "import { Controller, Get } from '@nestjs/common';",
    "@Controller('kilns')",
    'export class KilnsController { @Get() list() {} }',
  ].join('\n'),
  [`${K}/kilns/kilns.service.ts`]: [
    "import { FIRE_PATH } from './paths';",
    'export class KilnsService { start(queue: { push(p: string): void }) { queue.push(FIRE_PATH); } }',
  ].join('\n'),
  [`${K}/kilns/paths.ts`]: "export const FIRE_PATH = '/internal/fire';",
  [`${K}/kilns/firing.ts`]: 'export const temperature = 1200;',
  'infra/scheduler.tf': [
    'resource "google_cloud_scheduler_job" "this" {',
    '  schedule = "0 2 * * *"',
    '  http_target {',
    '    http_method = "POST"',
    '    uri         = "${google_cloud_run_v2_service.jobs.uri}${local.nightly_path}"',
    '  }',
    '}',
    '',
    'resource "google_cloud_scheduler_job" "orphan" {',
    '  schedule = "* * * * *"',
    '  http_target {',
    '    uri = "https://jobs.example/internal/missing"',
    '  }',
    '}',
  ].join('\n'),
  'infra/locals.tf': 'locals {\n  nightly_path = "/internal/nightly" # pinned by the scheduler\n}\n',
};

test('selection takes Terraform and the workspace file, not lockfiles', () => {
  const paths = selectLiftPaths([...Object.keys(kiln), 'pnpm-lock.yaml', 'infra/.terraform/modules/x/main.tf']);
  assert.ok(paths.includes('infra/scheduler.tf') && paths.includes('infra/locals.tf'));
  assert.ok(paths.includes('pnpm-workspace.yaml'));
  assert.ok(!paths.includes('pnpm-lock.yaml'), 'a lockfile is too big to be worth reading');
  assert.ok(!paths.includes('infra/.terraform/modules/x/main.tf'), 'vendored Terraform modules are not the repo');
});

test('a bootstrap that picks its root module is read as one server per deployment', () => {
  const skeleton = readRepo(loaded(kiln));

  assert.deepEqual(
    skeleton.servers.map((s) => ({ id: s.id, root: s.rootModule, internal: s.internal ?? false, exposes: s.exposes, source: s.source.file })),
    [
      // The public one first: it serves under the global prefix.
      { id: 'kiln', root: 'AppModule', internal: false, exposes: ['app', 'kilns'], source: `${K}/app.module.ts` },
      { id: 'kiln-jobs', root: 'JobsModule', internal: true, exposes: ['jobs'], source: `${K}/jobs.module.ts` },
    ],
  );
  const routes = (id: string) => skeleton.servers.find((s) => s.id === id)!.routes.map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(routes('kiln'), ['GET /api/kilns', 'GET /healthz']);
  // The health check both roots declare is served by each.
  assert.deepEqual(routes('kiln-jobs'), ['GET /healthz', 'POST /internal/fire', 'POST /internal/nightly']);

  // The browser reaches the public deployment only, and runs dev the repo's way.
  assert.deepEqual(skeleton.clients[0]!.calls, ['kiln']);
  assert.equal(skeleton.clients[0]!.packageManager, 'pnpm');

  const svc = (id: string) => skeleton.services.find((s) => s.id === id)!;
  // A root whose own declarations are plumbing stays plumbing; the other root is work.
  assert.equal(svc('app').root, true);
  assert.equal(svc('app').infrastructure, true);
  assert.equal(svc('jobs').root, true);
  assert.equal(svc('jobs').infrastructure, false);
  assert.equal(svc('jobs').server, 'kiln-jobs');
  assert.equal(svc('kilns').server, 'kiln');

  // Ownership: a module alone in its directory owns all of it; a root beside the
  // bootstrap owns its own file, its controllers, and the helper they import.
  assert.equal(svc('kilns').directory, `${K}/kilns`);
  assert.deepEqual(svc('kilns').files, [`${K}/kilns/firing.ts`, `${K}/kilns/kilns.controller.ts`, `${K}/kilns/kilns.module.ts`, `${K}/kilns/kilns.service.ts`, `${K}/kilns/paths.ts`]);
  assert.equal(svc('jobs').directory, undefined);
  assert.deepEqual(svc('jobs').files, [`${K}/jobs.controller.ts`, `${K}/jobs.module.ts`, `${K}/jobs.summary.ts`]);
  // Code nobody owns is shared, and said.
  assert.deepEqual(skeleton.servers[0]!.sharedFiles, [`${K}/agents/index.ts`, `${K}/main.ts`, `${K}/shared/clock.ts`]);

  // The grader is the jobs service's; the critic is reached only through the grader.
  assert.deepEqual(svc('jobs').agents, ['critic', 'grader']);
  assert.deepEqual(svc('jobs').agentsVia, { critic: ['grader'] });

  // The app queues work by naming the jobs deployment's route: an edge, not a guess.
  assert.deepEqual(svc('kilns').dispatchesTo, ['jobs']);
  assert.equal(svc('app').dispatchesTo, undefined, 'serving /healthz too is not dispatching');

  // The scheduler job is a process with its real schedule; the one aimed at no route is
  // reported, not drawn.
  assert.deepEqual(skeleton.processes, [
    { id: 'nightly', schedule: '0 2 * * *', calls: ['jobs'], source: { file: 'infra/scheduler.tf', line: 1 }, route: 'POST /internal/nightly' },
  ]);
  assert.ok(skeleton.unresolved.some((u) => u.file === 'infra/scheduler.tf' && /orphan.*no route/.test(u.reason)));
});

test('two deployments map to two boundaries: the browser reaches one, the scheduler the other', () => {
  const files = loaded(kiln);
  const out = skeletonToDocuments(readRepo(files), { projectName: 'Kiln', existing: {}, refinement: null, repo: files, listed: Object.keys(kiln) });
  assert.deepEqual(out.diagnostics.filter((d) => d.startsWith('error')), []);

  const app = parse(out.files['civil/app.yaml']!) as {
    spec: { nodes: Record<string, unknown>[]; edges: { kind: string; from: { node: string }; to: { node: string } }[] };
  };
  const node = (id: string) => app.spec.nodes.find((n) => n['id'] === id)!;
  assert.deepEqual(app.spec.nodes.map((n) => n['id']), ['web', 'api', 'jobs-api', 'jobs', 'kilns', 'nightly']);
  assert.deepEqual(node('api')['exposes'], ['kilns']);
  assert.deepEqual(node('jobs-api')['exposes'], ['jobs']);
  assert.equal(node('web')['dev'], 'pnpm run dev');
  assert.deepEqual(node('nightly')['calls'], ['jobs']);
  const edges = app.spec.edges.map((e) => `${e.from.node} ${e.kind} ${e.to.node}`);
  assert.ok(edges.includes('web routes-to api'));
  assert.ok(!edges.some((e) => e.startsWith('web ') && e.endsWith(' jobs-api')), 'no client reaches the internal deployment');
  assert.ok(edges.includes('jobs-api routes-to jobs'));
  assert.ok(edges.includes('kilns depends-on jobs'), 'queuing work on the jobs service is a dependency');
  assert.ok(edges.includes('nightly depends-on jobs'), 'the schedule is drawn to what it calls');

  // The jobs graph's code node is the module's own files, not every file in src/; the
  // critic is handed work by the grader, not by the module.
  const graph = parse(out.files['civil/graphs/jobs.graph.yaml']!) as {
    spec: { nodes: Record<string, unknown>[]; edges: { kind: string; from: { node: string }; to: { node: string } }[] };
  };
  assert.deepEqual(graph.spec.nodes[0]!['include'], [`${K}/jobs.controller.ts`, `${K}/jobs.module.ts`, `${K}/jobs.summary.ts`]);
  assert.deepEqual(
    graph.spec.edges.filter((e) => e.kind === 'flow').map((e) => `${e.from.node} -> ${e.to.node}`),
    ['grader -> critic', 'jobs-module -> grader'],
  );

  // Every file is attributed once: a unit's, or shared. The app root's module file is
  // the api boundary's (the boundary stands for that root), so it is not shared.
  const registry = parse(out.files['civil/registry.yaml']!) as {
    units: Record<string, { files?: Record<string, unknown> }>;
    shared: { files: Record<string, unknown> };
  };
  assert.ok(registry.units['app/kilns']!.files![`${K}/kilns/firing.ts`]);
  assert.deepEqual(Object.keys(registry.shared.files).sort(), [
    `${K}/agents/index.ts`,
    `${K}/health.controller.ts`,
    `${K}/main.ts`,
    `${K}/shared/clock.ts`,
  ]);
  const md = out.files['civil/architecture.md']!;
  assert.match(md, /deployed as 2 services/);
  assert.match(md, /\*\*jobs-api\*\* .*Internal: nothing it serves is under the global prefix/);
  assert.match(md, /A scheduler job in the infrastructure code posts `POST \/internal\/nightly`/);
  assert.match(md, /\| GET \| `\/healthz` \|.*\| api \(root module AppModule\) \|/);
});
