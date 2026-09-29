import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { once } from 'node:events';
import pino from 'pino';
import { loadConfig } from '../dist/config.js';
import { createServer } from '../dist/http/server.js';
import {
  SESSION_PORT_BASE,
  SESSION_PORT_BLOCKS,
  SESSION_PORTS_PER_SESSION,
  SESSION_PYTHON,
  deriveProcesses,
  gatherSessionFiles,
  sessionPortBase,
} from '../dist/project/session.js';
import { findMemo, shapeOutput } from '../dist/project/transpile.js';
import { assembleSessionFiles } from '../dist/http/session-routes.js';

/**
 * The session layer's three seams, each of which fails silently rather than loudly
 * when wrong: process derivation (a bad spec starts the wrong app on the wrong
 * port), the memo's roles compatibility (an old row must not strand a project that
 * transpiled before roles existed), and the route shapes the IDE depends on.
 */

// --- process derivation ------------------------------------------------------

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT_ID = '33333333-3333-4333-8333-333333333333';
/** Where this project's ports start; the offsets below are what the tests pin. */
const PORT_BASE = sessionPortBase(PROJECT_ID);

const composition = (nodes: unknown[]) => ({
  apiVersion: 'civil/v1',
  kind: 'Composition',
  metadata: { id: 'app' },
  spec: { nodes, edges: [] },
});

const clients = [
  { id: 'zeta', type: 'client', client: 'web', path: 'apps/zeta', dev: 'npm run dev' },
  { id: 'alpha', type: 'client', client: 'web', path: 'web', dev: 'vite' },
];
const boundaryNodes = [
  { id: 'public-api', type: 'boundary', boundary: 'api', exposes: ['classify'] },
  { id: 'agent-tools', type: 'boundary', boundary: 'mcp', exposes: ['classify'] },
];

test('the port base is a stable per-project offset, and two projects diverge', () => {
  // Pinned literally on purpose: this function readdresses every running preview
  // if it ever changes, and this test is where that change has to announce itself.
  assert.equal(sessionPortBase(PROJECT_ID), 47780);
  assert.equal(sessionPortBase(OTHER_PROJECT_ID), 43180);
  assert.notEqual(sessionPortBase(PROJECT_ID), sessionPortBase(OTHER_PROJECT_ID));
  for (const id of [PROJECT_ID, OTHER_PROJECT_ID]) {
    const base = sessionPortBase(id);
    assert.ok(base >= SESSION_PORT_BASE);
    assert.ok(base < SESSION_PORT_BASE + SESSION_PORT_BLOCKS * SESSION_PORTS_PER_SESSION);
    assert.equal((base - SESSION_PORT_BASE) % SESSION_PORTS_PER_SESSION, 0);
  }
});

test('clients become dev processes with per-project deterministic ports in node-id order', () => {
  const files = { 'web/package.json': '{}', 'web/index.html': '<div/>' };
  const derive = () =>
    deriveProcesses(PROJECT_ID, composition([...clients, ...boundaryNodes]) as never, files, {});
  const derived = derive();

  assert.deepEqual(derived.processes, [
    {
      name: 'alpha',
      cwd: 'web',
      setup: [['npm', 'install']],
      cmd: ['sh', '-c', 'vite'],
      port: PORT_BASE,
    },
    // No apps/zeta/package.json in the file set, so no npm install setup step.
    { name: 'zeta', cwd: 'apps/zeta', cmd: ['sh', '-c', 'npm run dev'], port: PORT_BASE + 1 },
  ]);
  assert.deepEqual(derived.previews, [
    { name: 'alpha', port: PORT_BASE },
    { name: 'zeta', port: PORT_BASE + 1 },
  ]);
  assert.deepEqual(derived.boundaries, []);
  // The same project derives the same addresses every time — restarts included.
  assert.deepEqual(derive(), derived);
});

test('a boundary-server file becomes a $CIVIL_PYTHON process named after the api boundary', () => {
  const roles = {
    'src/server.py': 'boundary-server',
    'src/flows/classify.py': 'orchestration',
    'src/agents/label.py': 'agent',
  } as const;
  const derived = deriveProcesses(
    PROJECT_ID,
    composition([...clients, ...boundaryNodes]) as never,
    { 'web/package.json': '{}' },
    roles as never,
  );

  const server = derived.processes.find((p) => p.cmd[0] === SESSION_PYTHON);
  assert.deepEqual(server, {
    name: 'public-api', // one server, one api boundary: the pairing is unambiguous
    cwd: '.',
    cmd: ['$CIVIL_PYTHON', 'src/server.py'],
    env: {
      PYTHONPATH: '.',
      // Every client's origin, both loopback spellings, so the preview's fetch is admitted.
      CORS_ORIGINS: [PORT_BASE, PORT_BASE + 1]
        .flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`])
        .join(','),
    },
    port: PORT_BASE + 2, // ports continue after the two clients
  });
  // And each client is told where the api is — what the generated boundary client reads.
  for (const name of ['alpha', 'zeta']) {
    const client = derived.processes.find((p) => p.name === name);
    assert.deepEqual(client?.env, { VITE_API_URL: `http://127.0.0.1:${PORT_BASE + 2}` });
  }
  assert.deepEqual(derived.boundaries, [{ name: 'public-api', port: PORT_BASE + 2 }]);
  // Only boundary-server files run; orchestration and agent files are imported, not started.
  assert.equal(derived.processes.length, 3);
});

test('with several servers, clients reach only the one named for the api boundary', () => {
  const roles = { 'src/mcp_server.py': 'boundary-server', 'src/public-api.py': 'boundary-server' };
  const derived = deriveProcesses(PROJECT_ID, composition([...clients, ...boundaryNodes]) as never, {}, roles as never);
  const alpha = derived.processes.find((p) => p.name === 'alpha');
  // Servers sort as mcp_server, public-api → the api server is the second one.
  assert.deepEqual(alpha?.env, { VITE_API_URL: `http://127.0.0.1:${PORT_BASE + 3}` });
});

test('an unpairable server is not advertised to clients, and no clients means no CORS', () => {
  const roles = { 'src/a.py': 'boundary-server', 'src/b.py': 'boundary-server' };
  const derived = deriveProcesses(PROJECT_ID, composition([...clients, ...boundaryNodes]) as never, {}, roles as never);
  assert.equal(derived.processes.find((p) => p.name === 'alpha')?.env, undefined);

  const bare = deriveProcesses(PROJECT_ID, composition(boundaryNodes) as never, {}, { 'src/server.py': 'boundary-server' } as never);
  assert.deepEqual(bare.processes[0]?.env, { PYTHONPATH: '.' });
});

test('two boundary servers fall back to file stems rather than guess a pairing', () => {
  const roles = { 'src/server.py': 'boundary-server', 'src/mcp_server.py': 'boundary-server' };
  const derived = deriveProcesses(PROJECT_ID, composition(boundaryNodes) as never, {}, roles as never);
  assert.deepEqual(
    derived.boundaries,
    [
      { name: 'mcp_server', port: PORT_BASE },
      { name: 'server', port: PORT_BASE + 1 },
    ],
  );
});

test('clients without a dev script, and mobile clients, derive nothing', () => {
  const nodes = [
    { id: 'static', type: 'client', client: 'web', path: 'web' },
    { id: 'phone', type: 'client', client: 'mobile', path: 'app', dev: 'expo start' },
  ];
  const derived = deriveProcesses(PROJECT_ID, composition(nodes) as never, {}, {});
  assert.deepEqual(derived.processes, []);
  assert.deepEqual(derived.previews, []);
});

test("a client at '.' or './web' still finds its package.json for npm install", () => {
  const nodes = [
    { id: 'root', type: 'client', client: 'web', path: '.', dev: 'vite' },
    { id: 'web', type: 'client', client: 'web', path: './web', dev: 'vite' },
  ];
  const files = { 'package.json': '{}', 'web/package.json': '{}' };
  const derived = deriveProcesses(PROJECT_ID, composition(nodes) as never, files, {});
  assert.equal(derived.processes.length, 2);
  for (const proc of derived.processes) {
    assert.deepEqual(proc.setup, [['npm', 'install']], `${proc.name} missed its package.json`);
  }
});

// --- the session file set ----------------------------------------------------

test('the session file set skips node_modules, .git, and binary-looking files', async () => {
  const files: Record<string, string> = {
    'web/index.html': '<div/>',
    'web/node_modules/vite/index.js': 'module',
    '.git/HEAD': 'ref: refs/heads/main',
    'assets/logo.png': 'not really a png',
    'data/blob.bin': 'text\x00with a nul byte',
    'src/main.py': 'def main(): ...',
  };
  const source = {
    exists: (p: string) => p in files,
    read: (p: string) => files[p],
    list: () => Object.keys(files).sort(),
    glob: () => [] as string[],
  };
  const gathered = await gatherSessionFiles(source as never);
  assert.deepEqual(Object.keys(gathered).sort(), ['src/main.py', 'web/index.html']);
});

// --- roles in the memo -------------------------------------------------------

test('memo rows stored before roles existed load with every file as "other"', async () => {
  const pool = {
    query: async () => ({
      rows: [{ output: { files: { 'src/server.py': 'code', 'src/flow.py': 'code' }, attempts: 2 } }],
    }),
  };
  const output = await findMemo(pool as never, 'owner', 'project', 'hash');
  assert.ok(output);
  assert.deepEqual(output.roles, { 'src/server.py': 'other', 'src/flow.py': 'other' });
  assert.equal(output.attempts, 2);
});

test('shapeOutput keeps known roles, defaults missing ones, and refuses invented ones', () => {
  const files = { 'a.py': '', 'b.py': '', 'c.py': '' };
  const output = shapeOutput(files, { 'a.py': 'boundary-server', 'c.py': 'load-bearing' }, 1);
  assert.deepEqual(output.roles, { 'a.py': 'boundary-server', 'b.py': 'other', 'c.py': 'other' });
});

// --- route shapes, session service faked -------------------------------------

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'dev@example.com',
  name: 'Local Developer',
  avatarUrl: null,
};

/** Answers the queries the session routes reach; everything else returns nothing. */
const fakePool = (projects: Record<string, unknown>) => ({
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO users')) return { rows: [USER] };
    if (sql.includes('FROM projects WHERE id')) {
      const row = projects[String(params[0])];
      return { rows: row ? [row] : [] };
    }
    return { rows: [] };
  },
});

const exampleProject = {
  id: PROJECT_ID,
  name: 'Doc Pipeline',
  sourceKind: 'example',
  localPath: null,
  exampleSlug: 'doc-pipeline',
  repoOwner: null,
  repoName: null,
  defaultBranch: 'main',
  headSha: null,
};

const testConfig = (overrides: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost:5432/civil_test',
    CIVIL_DEV_IDENTITY: 'dev@example.com',
    ...overrides,
  });

const buildServer = async (
  config: ReturnType<typeof testConfig>,
  projects: Record<string, unknown> = { [PROJECT_ID]: exampleProject },
) =>
  createServer({
    config,
    logger: pino({ level: 'silent' }),
    pool: fakePool(projects) as never,
  });

/** The session service per the seam contract, minus everything these routes ignore. */
const fakeSessionService = async () => {
  const seen: string[] = [];
  const service = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? '';
    if (!url.startsWith(`/sessions/${PROJECT_ID}`)) {
      return respond(404, { error: 'unknown session' });
    }
    if (req.method === 'GET' && url.includes('/logs')) {
      return respond(200, { lines: [{ seq: 8, proc: 'web', line: 'ready' }], last: 8 });
    }
    if (req.method === 'GET') {
      return respond(200, {
        processes: [
          { name: 'web', running: true, exitCode: null, port: 42000 },
          { name: 'public-api', running: true, exitCode: null, port: 42001 },
          { name: 'nightly', running: false, exitCode: 0, port: null },
        ],
        workspace: '/tmp/civil-sessions/x',
      });
    }
    if (req.method === 'DELETE') return respond(200, { stopped: true });
    return respond(400, { error: 'bad request' });
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const { port } = service.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, seen, close: () => service.close() };
};

test('session routes are behind the auth guard', async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost:5432/civil_test',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    CIVIL_SESSION_URL: 'http://127.0.0.1:1',
  });
  const app = await buildServer(config);
  const reply = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/session` });
  assert.equal(reply.statusCode, 401);
  assert.equal(reply.json().error, 'unauthenticated');
  await app.close();
});

test('an unknown project is a 404 before the session service is consulted', async () => {
  const app = await buildServer(testConfig({ CIVIL_SESSION_URL: 'http://127.0.0.1:1' }), {});
  const reply = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/session` });
  assert.equal(reply.statusCode, 404);
  assert.equal(reply.json().error, 'not_found');
  await app.close();
});

test('no configured session service is an honest 503, on every session route', async () => {
  // NODE_ENV=test gets no development default, so the URL is genuinely unset.
  const app = await buildServer(testConfig());
  for (const [method, url] of [
    ['POST', `/api/projects/${PROJECT_ID}/session`],
    ['GET', `/api/projects/${PROJECT_ID}/session`],
    ['GET', `/api/projects/${PROJECT_ID}/session/logs`],
    ['DELETE', `/api/projects/${PROJECT_ID}/session`],
  ] as const) {
    const reply = await app.inject({ method, url });
    assert.equal(reply.statusCode, 503, `${method} ${url}`);
    assert.equal(reply.json().error, 'session_not_configured');
  }
  await app.close();
});

test('POST without a runner is the runner 503, not a session error', async () => {
  const app = await buildServer(testConfig({ CIVIL_SESSION_URL: 'http://127.0.0.1:1' }));
  const reply = await app.inject({ method: 'POST', url: `/api/projects/${PROJECT_ID}/session` });
  assert.equal(reply.statusCode, 503);
  assert.equal(reply.json().error, 'runner_not_configured');
  await app.close();
});

test('status passes through and splits previews from boundaries by the composition', async () => {
  const service = await fakeSessionService();
  const app = await buildServer(testConfig({ CIVIL_SESSION_URL: service.url }));

  const reply = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/session` });
  assert.equal(reply.statusCode, 200);
  const body = reply.json();
  assert.equal(body.workspace, '/tmp/civil-sessions/x');
  assert.equal(body.processes.length, 3);
  // doc-pipeline's composition names one client, "web"; the ported non-client is a
  // boundary server, and the portless process is neither.
  assert.deepEqual(body.previews, [{ name: 'web', url: 'http://127.0.0.1:42000' }]);
  assert.deepEqual(body.boundaries, [{ name: 'public-api', url: 'http://127.0.0.1:42001' }]);

  await app.close();
  service.close();
});

test('logs and delete pass through, offset included', async () => {
  const service = await fakeSessionService();
  const app = await buildServer(testConfig({ CIVIL_SESSION_URL: service.url }));

  const logs = await app.inject({
    method: 'GET',
    url: `/api/projects/${PROJECT_ID}/session/logs?after=7`,
  });
  assert.equal(logs.statusCode, 200);
  assert.deepEqual(logs.json(), { lines: [{ seq: 8, proc: 'web', line: 'ready' }], last: 8 });
  assert.ok(service.seen.includes(`GET /sessions/${PROJECT_ID}/logs?after=7`));

  const del = await app.inject({ method: 'DELETE', url: `/api/projects/${PROJECT_ID}/session` });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json(), { stopped: true });

  await app.close();
  service.close();
});

test('the session service saying "no such session" passes through as the 404 it is', async () => {
  const service = await fakeSessionService();
  const otherId = OTHER_PROJECT_ID;
  const app = await buildServer(testConfig({ CIVIL_SESSION_URL: service.url }), {
    [otherId]: { ...exampleProject, id: otherId },
  });

  const reply = await app.inject({ method: 'GET', url: `/api/projects/${otherId}/session` });
  assert.equal(reply.statusCode, 404);
  assert.equal(reply.json().error, 'unknown session');

  await app.close();
  service.close();
});

test('an unreachable session service is a 502 the client can name', async () => {
  // Grab a port that answers, then close it, so the address is known-dead.
  const service = await fakeSessionService();
  service.close();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const app = await buildServer(testConfig({ CIVIL_SESSION_URL: service.url }));
  const reply = await app.inject({ method: 'GET', url: `/api/projects/${PROJECT_ID}/session` });
  assert.equal(reply.statusCode, 502);
  assert.equal(reply.json().error, 'session_unreachable');
  await app.close();
});

// --- write-through -----------------------------------------------------------

import { writeThroughToSession } from '../dist/http/session-routes.js';

test('a file save writes through to a live session', async () => {
  const patches: { url: string; body: unknown }[] = [];
  const service = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      patches.push({ url: req.url ?? '', body: JSON.parse(raw) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ written: 1 }));
    });
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const port = (service.address() as { port: number }).port;

  await writeThroughToSession(`http://127.0.0.1:${port}`, 'p-1', 'web/src/main.ts', 'code');
  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.url, '/sessions/p-1/files');
  assert.deepEqual(patches[0]!.body, { files: { 'web/src/main.ts': 'code' } });
  service.close();
});

test('write-through swallows no-session and no-service alike', async () => {
  const service = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'unknown session' }));
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const port = (service.address() as { port: number }).port;

  // A 404 (no session), a dead port, and no configured service must all be
  // invisible to the save that triggered them.
  await writeThroughToSession(`http://127.0.0.1:${port}`, 'p-1', 'a.ts', 'x');
  service.close();
  await once(service, 'close');
  await writeThroughToSession(`http://127.0.0.1:${port}`, 'p-1', 'a.ts', 'x');
  await writeThroughToSession(undefined, 'p-1', 'a.ts', 'x');
});

// --- transpile sync ----------------------------------------------------------

import { syncTranspileToSession } from '../dist/http/session-routes.js';

test('syncTranspileToSession pushes files, deletions, and boundary restarts', async () => {
  const patches: { method: string; url: string; body: unknown }[] = [];
  const service = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      patches.push({ method: req.method ?? '', url: req.url ?? '', body: JSON.parse(raw) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ written: 1, deleted: 1, restarted: ['public-api'] }));
    });
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const port = (service.address() as { port: number }).port;

  const output = {
    files: { 'src/server.py': 'code' },
    roles: { 'src/server.py': 'boundary-server' as const },
    attempts: 1,
  };
  await syncTranspileToSession(
    `http://127.0.0.1:${port}`, 'p-1', ['public-api'], output, ['src/old.py'],
  );

  assert.equal(patches.length, 1);
  assert.equal(patches[0]!.method, 'PATCH');
  assert.equal(patches[0]!.url, '/sessions/p-1/files');
  // Exactly the seam contract's body — files to write, paths to delete, procs to restart.
  assert.deepEqual(patches[0]!.body, {
    files: { 'src/server.py': 'code' },
    deletions: ['src/old.py'],
    restart: ['public-api'],
  });
  service.close();
});

test('syncTranspileToSession swallows a 404 and an unreachable port alike', async () => {
  const service = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'unknown session' }));
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const port = (service.address() as { port: number }).port;
  const output = { files: {}, roles: {}, attempts: 1 };

  // A 404 (no session) and then a dead port must both be invisible to the transpile.
  await syncTranspileToSession(`http://127.0.0.1:${port}`, 'p-1', [], output, []);
  service.close();
  await once(service, 'close');
  await syncTranspileToSession(`http://127.0.0.1:${port}`, 'p-1', [], output, []);
});

// --- the ops auto-retranspile predicate --------------------------------------

import { batchNeedsTranspile } from '../dist/http/project-routes.js';

test('a layout-only op batch does not re-transpile; any structural op does', () => {
  // Node drags are the high-frequency case and emit nothing — position is not code.
  assert.equal(batchNeedsTranspile([{ op: 'setLayout', id: 'a', x: 1, y: 2 }]), false);
  assert.equal(
    batchNeedsTranspile([
      { op: 'setLayout', id: 'a', x: 1, y: 2 },
      { op: 'setLayout', id: 'b', x: 3, y: 4 },
    ]),
    false,
  );
  // Anything that changes what the app IS triggers a re-transpile.
  assert.equal(batchNeedsTranspile([{ op: 'addNode', node: {} }]), true);
  assert.equal(batchNeedsTranspile([{ op: 'removeNode', id: 'a' }]), true);
  // A mixed batch counts as structural — one real edit rode in with the drag.
  assert.equal(
    batchNeedsTranspile([
      { op: 'setLayout', id: 'a', x: 1, y: 2 },
      { op: 'updateNode', id: 'a', patch: {} },
    ]),
    true,
  );
});

// --- cold-start materialization drops retirements ----------------------------

test('a fresh session materialises the emitted app without the retired files', () => {
  // The overlay snapshot predates the flow's retirement writes, so the base map
  // can still carry a dropped emission; assembleSessionFiles is what removes it.
  const base = {
    'web/index.html': '<!doctype html>',
    'graphs/old_boundary.py': 'stale',
    'src/keep.py': 'human',
  };
  const flow = {
    output: shapeOutput(
      { 'graphs/classify.py': 'fresh', 'web/index.html': '<!doctype html>' },
      { 'graphs/classify.py': 'orchestration' },
      1,
    ),
    cached: false,
    patternsRefreshed: false,
    retired: ['graphs/old_boundary.py'],
  };
  const files = assembleSessionFiles(base, flow);
  assert.equal(files['graphs/old_boundary.py'], undefined, 'the retired file is gone');
  assert.equal(files['graphs/classify.py'], 'fresh', 'the fresh emission is present');
  assert.equal(files['src/keep.py'], 'human', 'a human file is untouched');
});
