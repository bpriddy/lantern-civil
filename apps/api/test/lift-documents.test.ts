import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  MemoryFiles,
  validateComposition,
  validateGraph,
  validateProject,
  zProject,
} from '@civil/schema';
import { skeletonToDocuments } from '../dist/lift/to-documents.js';
import { applyRefinement } from '../dist/lift/refine.js';
import { applyOps } from '../dist/manifest/apply.js';
import { deriveUnits } from '../dist/project/registry.js';
import type { Refinement, Skeleton } from '../src/lift/skeleton.ts';

/**
 * The mapper is where a read repository becomes the documents an author reviews and
 * commits, so its two promises are pinned here: what it writes is valid Civil with no
 * errors, and an Update never loses what the author did — their ids, their layout,
 * their additions — and is no diff at all when the repository has not changed.
 *
 * Everything is synthetic: a small task-tracker monorepo (a NestJS server, a Vite
 * web app) written for these tests.
 */

const SERVER = 'apps/server/src';
const REPO: Record<string, string> = {
  'apps/web/package.json': '{ "name": "web", "scripts": { "dev": "vite" } }',
  'apps/web/src/main.tsx': 'export {};',
  'apps/server/package.json': '{ "name": "server" }',
  [`${SERVER}/main.ts`]: 'bootstrap();',
  [`${SERVER}/app.module.ts`]: 'export class AppModule {}',
  [`${SERVER}/tasks/tasks.module.ts`]: 'export class TasksModule {}',
  [`${SERVER}/tasks/tasks.service.ts`]: 'export class TasksService {}',
  [`${SERVER}/tasks/tasks.controller.ts`]: 'export class TasksController {}',
  [`${SERVER}/notes/notes.module.ts`]: 'export class NotesModule {}',
  [`${SERVER}/notes/notes.service.ts`]: 'export class NotesService {}',
  [`${SERVER}/notes/notes.controller.ts`]: 'export class NotesController {}',
  [`${SERVER}/notes/agents/summarizer.agent.ts`]: 'export const summarizer = {};',
  [`${SERVER}/notes/agents/summarizer.prompt.ts`]: 'export const prompt = "";',
  [`${SERVER}/notes/tools/search.ts`]: 'export function searchNotes() {}',
  [`${SERVER}/notes/tools/tag.ts`]: 'export function tagNote() {}',
  [`${SERVER}/users/users.module.ts`]: 'export class UsersModule {}',
  [`${SERVER}/users/users.service.ts`]: 'export class UsersService {}',
  [`${SERVER}/users/users.controller.ts`]: 'export class UsersController {}',
  [`${SERVER}/config/config.module.ts`]: 'export class ConfigModule {}',
  [`${SERVER}/config/config.service.ts`]: 'export class ConfigService {}',
  [`${SERVER}/database/database.module.ts`]: 'export class DatabaseModule {}',
  [`${SERVER}/database/prisma.service.ts`]: 'export class PrismaService {}',
  [`${SERVER}/health/health.module.ts`]: 'export class HealthModule {}',
  [`${SERVER}/health/health.controller.ts`]: 'export class HealthController {}',
  [`${SERVER}/digest/digest.cron.ts`]: 'export class DigestCron {}',
};

const route = (method: 'GET' | 'POST', path: string, controller: string, handler: string, file: string) => ({
  method,
  path,
  controller,
  handler,
  source: { file: `${SERVER}/${file}`, line: 10 },
});

const service = (
  id: string,
  extra: Partial<Skeleton['services'][number]> = {},
): Skeleton['services'][number] => {
  const Name = id[0]!.toUpperCase() + id.slice(1);
  return {
    id,
    server: 'server',
    moduleClass: `${Name}Module`,
    source: { file: `${SERVER}/${id}/${id}.module.ts` },
    controllers: [{ name: `${Name}Controller`, file: `${SERVER}/${id}/${id}.controller.ts` }],
    providers: [{ name: `${Name}Service`, file: `${SERVER}/${id}/${id}.service.ts` }],
    dependsOn: [],
    agents: [],
    infrastructure: false,
    ...extra,
  };
};

function skeleton(): Skeleton {
  return {
    clients: [
      { id: 'web', path: 'apps/web', framework: 'vite', devScript: 'vite', calls: ['server'], source: { file: 'apps/web/package.json' } },
    ],
    servers: [
      {
        id: 'server',
        path: 'apps/server',
        framework: 'nestjs',
        globalPrefix: '/api',
        routes: [
          route('GET', '/api/tasks', 'TasksController', 'list', 'tasks/tasks.controller.ts'),
          route('POST', '/api/tasks', 'TasksController', 'create', 'tasks/tasks.controller.ts'),
          route('POST', '/api/notes/:id/summary', 'NotesController', 'summarize', 'notes/notes.controller.ts'),
          route('GET', '/api/users/me', 'UsersController', 'me', 'users/users.controller.ts'),
          route('GET', '/api/health', 'HealthController', 'check', 'health/health.controller.ts'),
        ],
        exposes: ['health', 'notes', 'tasks', 'users'],
        source: { file: `${SERVER}/main.ts` },
      },
    ],
    services: [
      service('tasks', { dependsOn: ['users', 'database', 'config'] }),
      service('notes', { dependsOn: ['database'], agents: ['summarizer'] }),
      service('users', { dependsOn: ['database'] }),
      service('config', { controllers: [], infrastructure: true }),
      service('database', {
        controllers: [],
        providers: [{ name: 'PrismaService', file: `${SERVER}/database/prisma.service.ts` }],
        infrastructure: true,
      }),
      service('health', { providers: [], infrastructure: true }),
    ],
    agents: [
      {
        id: 'summarizer',
        files: [`${SERVER}/notes/agents/summarizer.agent.ts`, `${SERVER}/notes/agents/summarizer.prompt.ts`],
        tools: [
          { name: 'searchNotes', file: `${SERVER}/notes/tools/search.ts` },
          { name: 'tagNote', file: `${SERVER}/notes/tools/tag.ts` },
        ],
        source: { file: `${SERVER}/notes/agents/summarizer.agent.ts`, line: 3 },
      },
    ],
    processes: [
      { id: 'nightly-digest', schedule: '0 6 * * *', calls: ['notes', 'database'], source: { file: `${SERVER}/digest/digest.cron.ts`, line: 8 } },
    ],
    unresolved: [{ file: `${SERVER}/app.module.ts`, line: 12, reason: 'dynamic module import could not be resolved' }],
    frameworks: ['nestjs', 'vite'],
  };
}

const lift = (s: Skeleton, existing: Record<string, string> = {}, refinement: Refinement | null = null) =>
  skeletonToDocuments(s, { projectName: 'Task Tracker', existing, refinement, repo: REPO });

/** The schema's verdict on a set of civil/ documents over the synthetic repository. */
function validate(files: Record<string, string>, repo: Record<string, string> = REPO) {
  const view = MemoryFiles.from({ ...repo, ...files });
  const project = zProject.safeParse(parse(files['civil/civil.yaml']!));
  assert.ok(project.success, `civil.yaml: ${JSON.stringify(!project.success && project.error.issues)}`);
  const compositionPath = project.data.spec.composition;
  const result = validateProject(compositionPath, {
    files: view,
    loadDoc: (p) => (files[p] === undefined ? undefined : parse(files[p]!)),
  });
  const composition = validateComposition(parse(files[compositionPath]!), compositionPath, view);
  const graphs = Object.keys(files)
    .filter((p) => p.endsWith('.graph.yaml'))
    .map((p) => validateGraph(parse(files[p]!), p, view));
  const errors = [...result.diagnostics, ...composition.diagnostics, ...graphs.flatMap((g) => g.diagnostics)].filter(
    (d) => d.severity === 'error',
  );
  return { project: project.data, composition: composition.doc!, graphFiles: result.graphFiles, errors };
}

const compositionOf = (files: Record<string, string>) =>
  parse(files['civil/app.yaml']!) as {
    spec: { nodes: Record<string, any>[]; edges: { id: string; kind: string; from: { node: string }; to: { node: string } }[] };
    layout: { nodes: Record<string, { x: number; y: number }> };
  };

test('a full mapping validates against @civil/schema with zero errors', () => {
  const out = lift(skeleton());
  const { project, composition, graphFiles, errors } = validate(out.files);
  assert.deepEqual(errors, []);
  assert.deepEqual(out.diagnostics.filter((d) => d.startsWith('error')), []);

  assert.equal(project.spec.language, 'typescript');
  assert.equal(project.spec.composition, 'civil/app.yaml');
  assert.deepEqual(Object.keys(out.files).sort(), [
    'civil/app.yaml',
    'civil/architecture.md',
    'civil/civil.yaml',
    'civil/graphs/notes.graph.yaml',
    'civil/registry.yaml',
  ]);
  assert.deepEqual(graphFiles, ['civil/graphs/notes.graph.yaml']);

  const byId = new Map(composition.spec.nodes.map((n) => [n.id, n]));
  assert.deepEqual([...byId.keys()], ['web', 'api', 'notes', 'tasks', 'users', 'nightly-digest']);
  assert.deepEqual(byId.get('web'), { id: 'web', type: 'client', client: 'web', path: 'apps/web', dev: 'npm run dev' });
  assert.deepEqual(byId.get('tasks'), { id: 'tasks', type: 'service', impl: { entrypoint: `${SERVER}/tasks/tasks.service.ts` } });
  assert.deepEqual(byId.get('notes'), { id: 'notes', type: 'service', impl: { graph: 'civil/graphs/notes.graph.yaml' } });
  assert.deepEqual(byId.get('nightly-digest'), {
    id: 'nightly-digest',
    type: 'process',
    trigger: { kind: 'schedule', cron: '0 6 * * *' },
    // The infrastructure it also calls is not on the canvas, so it is not named here.
    calls: ['notes'],
  });

  // exposes and the boundary's routes-to edges say the same thing.
  const api = byId.get('api')!;
  assert.equal(api.type, 'boundary');
  assert.deepEqual(api.type === 'boundary' && api.exposes, ['notes', 'tasks', 'users']);
  const edges = composition.spec.edges.map((e) => `${e.kind} ${e.from.node}->${e.to.node}`);
  assert.deepEqual(edges, [
    'routes-to web->api',
    'routes-to api->notes',
    'routes-to api->tasks',
    'routes-to api->users',
    'depends-on tasks->users',
    // A process is drawn to what it calls; database (infrastructure) is in neither.
    'depends-on nightly-digest->notes',
  ]);

  // Layout is a sibling of spec, one entry per node, no two on the same spot.
  const doc = compositionOf(out.files);
  assert.deepEqual(Object.keys(doc.layout.nodes).sort(), [...byId.keys()].sort());
  const spots = Object.values(doc.layout.nodes).map((p) => `${p.x},${p.y}`);
  assert.equal(new Set(spots).size, spots.length);
  assert.ok(doc.layout.nodes['web']!.x < doc.layout.nodes['api']!.x && doc.layout.nodes['api']!.x < doc.layout.nodes['tasks']!.x);

  // The registry keeps the shape registry.ts reads, with the repo's files as the code.
  const registry = parse(out.files['civil/registry.yaml']!);
  assert.equal(registry.apiVersion, 'civil/v1');
  assert.equal(registry.kind, 'Registry');
  assert.equal(registry.generated_from, undefined);
  const derived = deriveUnits({ 'civil/app.yaml': out.files['civil/app.yaml']!, 'civil/graphs/notes.graph.yaml': out.files['civil/graphs/notes.graph.yaml']! });
  assert.deepEqual(Object.keys(registry.units), derived.map((u: { id: string }) => u.id));
  assert.deepEqual(Object.keys(registry.units['app/tasks'].files), [
    `${SERVER}/tasks/tasks.controller.ts`,
    `${SERVER}/tasks/tasks.module.ts`,
    `${SERVER}/tasks/tasks.service.ts`,
  ]);
  assert.match(registry.units['app/tasks'].files[`${SERVER}/tasks/tasks.service.ts`].hash, /^sha256:[0-9a-f]{16}$/);
  assert.equal(registry.units['app/tasks'].files[`${SERVER}/tasks/tasks.service.ts`].role, 'repo');
  assert.deepEqual(registry.units['app/api'].depends_on, ['app/notes', 'app/tasks', 'app/users']);
  assert.deepEqual(Object.keys(registry.units['graph/notes/summarizer'].files), [
    `${SERVER}/notes/agents/summarizer.agent.ts`,
    `${SERVER}/notes/agents/summarizer.prompt.ts`,
    `${SERVER}/notes/tools/search.ts`,
    `${SERVER}/notes/tools/tag.ts`,
  ]);

  // Mapping the same inputs again is the same bytes.
  assert.deepEqual(lift(skeleton()).files, out.files);
  assert.match(out.summary, /1 client, 1 api boundary, 3 services \(1 drawn as an agent graph\), 1 scheduled process/);
});

test('an agent-backed service becomes a graph: its code hands to the agent, which is given its tools', () => {
  const out = lift(skeleton());
  const graph = parse(out.files['civil/graphs/notes.graph.yaml']!);
  assert.equal(graph.kind, 'Graph');
  assert.equal(graph.metadata.id, 'notes');
  assert.deepEqual(graph.spec.nodes, [
    {
      id: 'notes-service',
      type: 'code',
      name: 'NotesService',
      include: [`${SERVER}/notes/**/*.ts`],
      entrypoint: `${SERVER}/notes/notes.service.ts`,
    },
    { id: 'summarizer', type: 'agent', name: 'Summarizer' },
    { id: 'search-notes', type: 'code', name: 'searchNotes', include: [`${SERVER}/notes/tools/search.ts`], entrypoint: `${SERVER}/notes/tools/search.ts` },
    { id: 'tag-note', type: 'code', name: 'tagNote', include: [`${SERVER}/notes/tools/tag.ts`], entrypoint: `${SERVER}/notes/tools/tag.ts` },
  ]);
  assert.deepEqual(
    graph.spec.edges.map((e: { kind: string; from: { node: string }; to: { node: string; function?: string } }) =>
      `${e.kind} ${e.from.node}->${e.to.node}${e.to.function ? `#${e.to.function}` : ''}`),
    ['flow notes-service->summarizer', 'capability summarizer->search-notes#searchNotes', 'capability summarizer->tag-note#tagNote'],
  );
  assert.deepEqual(Object.keys(graph.layout.nodes).sort(), ['notes-service', 'search-notes', 'summarizer', 'tag-note']);
  // Left to right: code, agent, tools.
  assert.ok(graph.layout.nodes['notes-service'].x < graph.layout.nodes.summarizer.x);
  assert.ok(graph.layout.nodes.summarizer.x < graph.layout.nodes['search-notes'].x);
});

const REFINEMENT: Refinement = {
  renames: { tasks: 'task-board', summarizer: 'note-summarizer', server: 'backend' },
  infrastructure: ['users'],
  descriptions: {
    'task-board': 'Creates and lists the tasks on a board.',
    'note-summarizer': 'Summarises a note.',
  },
  summary: 'A task tracker with an AI note summariser.',
};

test('refinement renames apply everywhere an id is said, and infrastructure moves off the canvas', () => {
  const out = lift(skeleton(), {}, REFINEMENT);
  const { composition, errors } = validate(out.files);
  assert.deepEqual(errors, []);

  const ids = composition.spec.nodes.map((n) => n.id);
  assert.ok(ids.includes('task-board') && !ids.includes('tasks'));
  // Classified as infrastructure by the model: off the canvas, out of exposes and edges.
  assert.ok(!ids.includes('users'));
  const api = composition.spec.nodes.find((n) => n.id === 'api')!;
  assert.deepEqual(api.type === 'boundary' && api.exposes, ['notes', 'task-board']);
  const edges = composition.spec.edges.map((e) => `${e.id}:${e.from.node}->${e.to.node}`);
  assert.deepEqual(edges, [
    'web-to-api:web->api',
    'api-to-notes:api->notes',
    'api-to-task-board:api->task-board',
    'nightly-digest-needs-notes:nightly-digest->notes',
  ]);
  assert.ok(compositionOf(out.files).layout.nodes['task-board']);
  assert.equal(compositionOf(out.files).layout.nodes['tasks'], undefined);

  const graph = parse(out.files['civil/graphs/notes.graph.yaml']!);
  const agent = graph.spec.nodes.find((n: { type: string }) => n.type === 'agent');
  // The description is short enough to be the node's name.
  assert.deepEqual(agent, { id: 'note-summarizer', type: 'agent', name: 'Summarises a note.' });

  const registry = parse(out.files['civil/registry.yaml']!);
  assert.ok(registry.units['app/task-board'].files[`${SERVER}/tasks/tasks.service.ts`]);
  assert.ok(registry.units['graph/notes/note-summarizer']);
  assert.equal(registry.units['app/tasks'], undefined);
  assert.ok(registry.shared.files[`${SERVER}/users/users.service.ts`], 'users is now shared infrastructure');

  const md = out.files['civil/architecture.md']!;
  assert.match(md, /A task tracker with an AI note summariser\./);
  assert.match(md, /\*\*task-board\*\* — `TasksModule`\. Creates and lists the tasks on a board\./);
  assert.match(md, /\*\*users\*\* — `UsersModule`/);

  // Handing over the skeleton refineSkeleton returns — already renamed — is the same.
  const prerenamed = lift(applyRefinement(skeleton(), REFINEMENT), {}, REFINEMENT);
  assert.deepEqual(prerenamed.files, out.files);
});

test('infrastructure modules are left off the canvas and described in architecture.md', () => {
  const out = lift(skeleton());
  const composition = compositionOf(out.files);
  const ids = composition.spec.nodes.map((n) => n.id);
  for (const infra of ['config', 'database', 'health']) {
    assert.ok(!ids.includes(infra), `${infra} is not drawn`);
    assert.ok(!composition.spec.edges.some((e) => e.to.node === infra || e.from.node === infra));
  }
  const md = out.files['civil/architecture.md']!;
  assert.match(md, /## Infrastructure/);
  assert.match(md, /- \*\*database\*\* — `DatabaseModule`\. Files: `apps\/server\/src\/database\/database\.module\.ts`, `apps\/server\/src\/database\/prisma\.service\.ts`\./);
  // The health route is still in the boundary's routes table, attributed honestly.
  assert.match(md, /\| GET \| `\/api\/health` \| HealthController\.check .* \| health \(infrastructure\) \|/);
  assert.match(md, /dynamic module import could not be resolved/);
  const registry = parse(out.files['civil/registry.yaml']!);
  assert.deepEqual(Object.keys(registry.shared.files), [
    `${SERVER}/config/config.module.ts`,
    `${SERVER}/config/config.service.ts`,
    `${SERVER}/database/database.module.ts`,
    `${SERVER}/database/prisma.service.ts`,
    `${SERVER}/health/health.controller.ts`,
    `${SERVER}/health/health.module.ts`,
  ]);
});

test('re-running over its own output is no diff at all', () => {
  const first = lift(skeleton());
  const again = lift(skeleton(), first.files);
  assert.deepEqual(again.files, first.files);
  assert.equal(again.summary, 'civil/ already matches the repository — nothing to change.');
  assert.deepEqual(again.diagnostics.filter((d) => !d.startsWith('note:')), []);
});

test('Update keeps the author’s ids, layout, and additions, flags what is gone, and is stable', () => {
  const first = lift(skeleton());

  // The author works on the canvas: renames a node, moves one, adds their own service
  // and a connection, and comments the file. All through the op layer, as the UI would.
  let app = `# Our product, drawn by hand from here on.\n${first.files['civil/app.yaml']!}`;
  app = applyOps(app, [
    { op: 'renameNode', from: 'tasks', to: 'todo' },
    { op: 'setLayout', id: 'web', x: 999, y: 7 },
    { op: 'addNode', node: { id: 'billing', type: 'service', impl: { entrypoint: `${SERVER}/app.module.ts` } } },
    { op: 'setLayout', id: 'billing', x: 560, y: 520 },
    { op: 'addEdge', edge: { id: 'e1', kind: 'depends-on', from: { node: 'todo' }, to: { node: 'billing' } } },
    { op: 'updateNode', id: 'api', patch: { exposes: ['notes', 'todo', 'users', 'billing'] } },
  ]).source;
  const authored = { ...first.files, 'civil/app.yaml': app };

  // Meanwhile the repository changed: users is gone, a reports module appeared.
  const next = skeleton();
  next.services = next.services.filter((s) => s.id !== 'users').map((s) =>
    s.id === 'tasks' ? { ...s, dependsOn: ['database', 'reports'] } : s);
  next.services.push(service('reports'));
  next.servers[0]!.exposes = ['health', 'notes', 'reports', 'tasks'];
  const repo = { ...REPO, [`${SERVER}/reports/reports.module.ts`]: 'x', [`${SERVER}/reports/reports.service.ts`]: 'x', [`${SERVER}/reports/reports.controller.ts`]: 'x' };
  const update = skeletonToDocuments(next, { projectName: 'Task Tracker', existing: authored, refinement: null, repo });

  const text = update.files['civil/app.yaml']!;
  assert.ok(text.startsWith('# Our product, drawn by hand from here on.\n'), 'the author’s comment survives');
  const doc = compositionOf(update.files);
  const ids = doc.spec.nodes.map((n) => n.id);
  // The author's rename holds: the lift found tasks again and called it todo.
  assert.ok(ids.includes('todo') && !ids.includes('tasks'));
  assert.ok(ids.includes('billing'), 'the author’s own node is kept');
  assert.ok(ids.includes('users'), 'what the repository no longer shows is kept, not deleted');
  assert.ok(ids.includes('reports'), 'what is new is added');
  assert.deepEqual(doc.layout.nodes['web'], { x: 999, y: 7 });
  assert.deepEqual(doc.layout.nodes['billing'], { x: 560, y: 520 });
  const placed = doc.layout.nodes['reports']!;
  assert.ok(placed, 'a new node is placed');
  for (const [id, p] of Object.entries(doc.layout.nodes)) {
    if (id !== 'reports') assert.ok(!(Math.abs(p.x - placed.x) < 200 && Math.abs(p.y - placed.y) < 90), `reports overlaps ${id}`);
  }
  const api = doc.spec.nodes.find((n) => n.id === 'api')!;
  assert.deepEqual(api['exposes'], ['notes', 'todo', 'users', 'billing', 'reports']);
  const edges = doc.spec.edges.map((e) => `${e.kind} ${e.from.node}->${e.to.node}`);
  assert.ok(edges.includes('depends-on todo->billing'), 'the author’s edge is kept');
  assert.ok(edges.includes('depends-on todo->reports'), 'the new dependency is drawn from the author’s id');
  assert.ok(edges.includes('routes-to api->reports'));
  assert.ok(edges.includes('depends-on todo->users'), 'a connection the code dropped is kept');

  assert.match(update.summary, /added reports/);
  assert.match(update.summary, /Kept 1 node you added \(billing\)/);
  assert.match(update.summary, /1 node the repository no longer shows is kept and flagged \(users\)/);
  assert.ok(update.diagnostics.some((d) => d.includes('"users" was lifted before and is no longer found')));

  // The registry follows the author's ids.
  const registry = parse(update.files['civil/registry.yaml']!);
  assert.ok(registry.units['app/todo'].files[`${SERVER}/tasks/tasks.service.ts`]);
  assert.equal(registry.units['app/todo'].files[`${SERVER}/tasks/tasks.module.ts`].role, 'repo');
  assert.equal(registry.units['app/billing'].files, undefined, 'the author’s node has no lifted files');
  assert.equal(registry.units['app/users'].files, undefined, 'a node no longer found has no files');

  // Kept nodes still point at real files here, so the merged documents validate clean.
  const { errors } = validate(update.files, repo);
  assert.deepEqual(errors, []);

  // And running it again changes nothing.
  const again = skeletonToDocuments(next, { projectName: 'Task Tracker', existing: update.files, refinement: null, repo });
  assert.deepEqual(again.files, update.files);
  assert.equal(again.summary, 'civil/ already matches the repository — nothing to change.');
});

test('Update recognises a renamed graph and merges into it, keeping the author’s graph edits', () => {
  const first = lift(skeleton());
  let app = applyOps(first.files['civil/app.yaml']!, [{ op: 'renameNode', from: 'notes', to: 'notebook' }]).source;
  let graph = applyOps(first.files['civil/graphs/notes.graph.yaml']!, [
    { op: 'renameNode', from: 'summarizer', to: 'writer' },
    { op: 'updateNode', id: 'writer', patch: { name: 'The writer' } },
    { op: 'setLayout', id: 'writer', x: 5, y: 5 },
  ]).source;
  const existing = { ...first.files, 'civil/app.yaml': app, 'civil/graphs/notes.graph.yaml': graph };

  const next = skeleton();
  next.agents[0]!.tools.push({ name: 'linkNote', file: `${SERVER}/notes/tools/tag.ts` });
  const out = lift(next, existing);
  const doc = parse(out.files['civil/graphs/notes.graph.yaml']!);
  assert.equal(out.files['civil/graphs/notebook.graph.yaml'], undefined, 'no second graph for the renamed service');
  const nodes = new Map(doc.spec.nodes.map((n: { id: string }) => [n.id, n]));
  assert.ok(nodes.has('writer') && !nodes.has('summarizer'), 'the author’s agent id holds');
  assert.equal((nodes.get('writer') as { name: string }).name, 'The writer');
  assert.deepEqual(doc.layout.nodes.writer, { x: 5, y: 5 });
  assert.ok(nodes.has('link-note'));
  assert.ok(doc.spec.edges.some((e: { from: { node: string }; to: { node: string; function?: string } }) =>
    e.from.node === 'writer' && e.to.node === 'link-note' && e.to.function === 'linkNote'));
  const registry = parse(out.files['civil/registry.yaml']!);
  assert.ok(registry.units['graph/notes/writer'].files);
  assert.ok(registry.units['app/notebook']);
  assert.deepEqual(validate(out.files).errors, []);
  assert.deepEqual(lift(next, out.files).files, out.files);
});

test('an existing python civil.yaml is switched to typescript and otherwise kept', () => {
  const existing = {
    'civil/civil.yaml': 'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: tt\n  name: TT # ours\nspec:\n  composition: civil/app.yaml\n  language: python\n',
  };
  const out = lift(skeleton(), existing);
  assert.equal(
    out.files['civil/civil.yaml'],
    'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: tt\n  name: TT # ours\nspec:\n  composition: civil/app.yaml\n  language: typescript\n',
  );
  const bare = lift(skeleton(), { 'civil/civil.yaml': 'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: tt\nspec:\n  composition: civil/app.yaml\n' });
  assert.match(bare.files['civil/civil.yaml']!, /composition: civil\/app\.yaml\n  language: typescript\n/);
});

test('a later model pass that renames ids civil/ already has does not churn them', () => {
  // The first lift had no runner (reader ids); a later one does, and the model renames
  // tasks → task-board. The author's documents say `tasks`, so the merge keeps `tasks`
  // — found through the registry's files for that unit — rather than adding a second
  // node and flagging the first as stale.
  const first = lift(skeleton());
  const renaming: Refinement = { renames: { tasks: 'task-board' }, infrastructure: [], descriptions: {}, summary: 'x' };
  const later = lift(applyRefinement(skeleton(), renaming), first.files, renaming);
  const ids = compositionOf(later.files).spec.nodes.map((n) => n.id);
  assert.ok(ids.includes('tasks'), `kept the existing id: ${ids.join(', ')}`);
  assert.ok(!ids.includes('task-board'), 'no duplicate under the model’s name');
  assert.deepEqual(validate(later.files).errors, []);
  assert.deepEqual(later.diagnostics.filter((d) => /stale/i.test(d)), []);
});

test('a client is run by the script the reader found, by name', () => {
  const s = skeleton();
  s.clients[0] = { ...s.clients[0]!, devScript: 'vite --port 3000', devScriptName: 'start' };
  const web = compositionOf(lift(s).files).spec.nodes.find((n) => n.id === 'web')!;
  assert.equal(web['dev'], 'npm run start');
  // A skeleton without the name (the field is additive) keeps the convention.
  const plain = compositionOf(lift(skeleton()).files).spec.nodes.find((n) => n.id === 'web')!;
  assert.equal(plain['dev'], 'npm run dev');
});

test('a service later read as infrastructure is flagged as reclassified, not as gone', () => {
  const first = lift(skeleton());
  const marking: Refinement = { renames: {}, infrastructure: ['users'], descriptions: {}, summary: 'x' };
  const later = lift(skeleton(), first.files, marking);
  const flagged = later.diagnostics.filter((d) => d.includes('"users"'));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0]!, /now read as infrastructure/);
  assert.doesNotMatch(later.summary, /no longer shows/);
  assert.match(later.summary, /now read as infrastructure .*\(users\)/);
});

test('Update merges into a composition with no layout block instead of failing', () => {
  // Schema-valid: layout defaults to empty. Hand-written and older documents omit it.
  const existing = {
    'civil/civil.yaml': 'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: task-tracker\nspec:\n  composition: civil/app.yaml\n',
    'civil/app.yaml': [
      'apiVersion: civil/v1',
      'kind: Composition',
      'metadata:',
      '  id: task-tracker',
      'spec:',
      '  nodes:',
      '    - id: mine',
      '      type: service',
      `      impl: { entrypoint: ${SERVER}/tasks/tasks.service.ts }`,
      '  edges: []',
      '',
    ].join('\n'),
  };
  const out = lift(skeleton(), existing);
  const doc = compositionOf(out.files);
  assert.ok(doc.spec.nodes.some((n) => n['id'] === 'mine'), "the author's node stands");
  assert.ok(doc.layout.nodes['notes'], 'new nodes are placed in the block the merge added');
  assert.ok(out.files['civil/app.yaml']!.startsWith(existing['civil/app.yaml'].split('\n  edges')[0]!), 'the existing text is kept');
  assert.deepEqual(validate(out.files).errors, []);
});

test('civil.yaml naming a composition the project lacks is pointed at the one written', () => {
  const existing = {
    'civil/civil.yaml': 'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: task-tracker\nspec:\n  composition: civil/main.yaml\n  language: typescript\n',
  };
  const out = lift(skeleton(), existing);
  assert.match(out.files['civil/civil.yaml']!, /composition: civil\/app\.yaml/);
  assert.ok(out.files['civil/app.yaml']);
  assert.ok(out.diagnostics.some((d) => /named the composition "civil\/main\.yaml", which the project does not have/.test(d)));
  assert.deepEqual(validate(out.files).errors, []);
});

test('a lifted node the author deleted is not added back, on this Update or the next', () => {
  const first = lift(skeleton());
  // The author removes "users" on the canvas: the node and its edges go, and the
  // boundary stops exposing it.
  const exposes = (compositionOf(first.files).spec.nodes.find((n) => n['id'] === 'api')!['exposes'] as string[]).filter((x) => x !== 'users');
  const app = applyOps(first.files['civil/app.yaml']!, [
    { op: 'removeNode', id: 'users' },
    { op: 'updateNode', id: 'api', patch: { exposes } },
  ]).source;
  const afterDelete = { ...first.files, 'civil/app.yaml': app };

  const update = lift(skeleton(), afterDelete);
  const doc = compositionOf(update.files);
  assert.ok(!doc.spec.nodes.some((n) => n['id'] === 'users'), 'not re-added');
  assert.ok(!doc.spec.edges.some((e) => e.from.node === 'users' || e.to.node === 'users'), 'no edge to it either');
  assert.ok(!(doc.spec.nodes.find((n) => n['id'] === 'api')!['exposes'] as string[]).includes('users'));
  assert.match(update.summary, /Not added back, because you removed it: users\./);
  assert.deepEqual(validate(update.files).errors, []);
  // Remembered in the registry, since the registry is rebuilt from the documents.
  assert.deepEqual(parse(update.files['civil/registry.yaml']!).lifted_from, undefined, 'no provenance without liftedFrom');

  const withProvenance = (existing: Record<string, string>) =>
    skeletonToDocuments(skeleton(), {
      projectName: 'Task Tracker',
      existing,
      refinement: null,
      repo: REPO,
      liftedFrom: { fingerprint: 'sha256:x', refinement: null },
    });
  const second = withProvenance(afterDelete);
  assert.deepEqual(parse(second.files['civil/registry.yaml']!).lifted_from.removed, ['app/users']);
  const third = withProvenance(second.files);
  assert.ok(!compositionOf(third.files).spec.nodes.some((n) => n['id'] === 'users'), 'still not re-added');
  assert.deepEqual(third.files, second.files, 'and nothing else moves');

  // Putting it back by hand makes it the author's again: the memory lets go.
  const restored = applyOps(third.files['civil/app.yaml']!, [
    { op: 'addNode', node: { id: 'users', type: 'service', impl: { entrypoint: `${SERVER}/users/users.service.ts` } } },
  ]).source;
  const fourth = withProvenance({ ...third.files, 'civil/app.yaml': restored });
  assert.equal(parse(fourth.files['civil/registry.yaml']!).lifted_from.removed, undefined);
});

test('a repository with only a Vite client does not switch civil.yaml to TypeScript', () => {
  const vite: Skeleton = { ...skeleton(), servers: [], services: [], agents: [], processes: [], unresolved: [], frameworks: ['vite'] };
  vite.clients = [{ ...vite.clients[0]!, calls: [] }];
  const out = lift(vite);
  assert.doesNotMatch(out.files['civil/civil.yaml']!, /language/);
  const python = 'apiVersion: civil/v1\nkind: Project\nmetadata:\n  id: t\nspec:\n  composition: civil/app.yaml\n  language: python\n';
  assert.match(lift(vite, { 'civil/civil.yaml': python }).files['civil/civil.yaml']!, /language: python/);
});

test('validation sees every listed file, not only the ones the lift loaded', () => {
  const existing = {
    ...lift(skeleton()).files,
  };
  // The author's own node points at a Python module the lift never loads.
  existing['civil/app.yaml'] = applyOps(existing['civil/app.yaml']!, [
    { op: 'addNode', node: { id: 'billing', type: 'service', impl: { entrypoint: 'billing/run.py' } } },
  ]).source;
  const without = lift(skeleton(), existing);
  assert.ok(without.diagnostics.some((d) => /billing\/run\.py/.test(d)), 'unlisted, it would be reported missing');
  const listed = skeletonToDocuments(skeleton(), {
    projectName: 'Task Tracker',
    existing,
    refinement: null,
    repo: REPO,
    listed: [...Object.keys(REPO), 'billing/run.py'],
  });
  assert.ok(!listed.diagnostics.some((d) => /billing\/run\.py/.test(d)));
});
