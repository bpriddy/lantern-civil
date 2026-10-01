import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { parse } from 'yaml';
import {
  REGISTRY_PATH,
  applyState,
  attachRegistry,
  buildRegistry,
  currentEmission,
  deriveUnits,
} from '../dist/project/registry.js';
import { shapeOutput, sketchFingerprint } from '../dist/project/transpile.js';
import { transpileProject } from '../dist/http/transpile-routes.js';

/**
 * civil/registry.yaml is the record every later step trusts: which files a unit
 * became (partial regeneration), their hashes (hand-edit detection), and what
 * depends on what. A wrong entry does not error — it quietly regenerates the wrong
 * files or misses a hand edit, so the derivation is pinned against a real project.
 */

const FP = 'sha256:00000000feedface';
const EXAMPLE = path.resolve(import.meta.dirname, '../../../examples/doc-pipeline');
const read = (rel: string) => fs.readFileSync(path.join(EXAMPLE, rel), 'utf8');
const DOCUMENTS = {
  'civil/civil.yaml': read('civil/civil.yaml'),
  'civil/app.yaml': read('civil/app.yaml'),
  'civil/graphs/classify.graph.yaml': read('civil/graphs/classify.graph.yaml'),
  'civil/graphs/enrich.graph.yaml': read('civil/graphs/enrich.graph.yaml'),
};

test('doc-pipeline derives one unit per node that matters, namespaced by altitude', () => {
  const units = deriveUnits(DOCUMENTS);
  assert.deepEqual(
    units.map((u) => [u.id, u.kind, u.dependsOn]),
    [
      ['app/agent-tools', 'boundary', ['app/classify']],
      ['app/classify', 'service', ['graph/classify']],
      ['app/nightly-reindex', 'process', ['app/classify']],
      ['app/public-api', 'boundary', ['app/classify', 'app/save-record']],
      ['app/save-record', 'service', []],
      ['app/web', 'client', ['app/public-api']],
      // The classify graph depends on its agent and the subgraph it descends into.
      ['graph/classify', 'graph', ['graph/classify/classifier', 'graph/enrich']],
      ['graph/classify/classifier', 'agent', []],
      ['graph/enrich', 'graph', []],
    ],
  );
  const byId = new Map(units.map((u) => [u.id, u]));
  assert.equal(byId.get('app/save-record')?.entrypoint, 'src/services/save_record.py');
  assert.equal(byId.get('app/public-api')?.boundary, 'api');
  assert.equal(byId.get('app/agent-tools')?.boundary, 'mcp');
  assert.equal(byId.get('graph/classify/classifier')?.source, 'civil/graphs/classify.graph.yaml');
});

test('an unparseable document contributes nothing rather than throwing', () => {
  const units = deriveUnits({ ...DOCUMENTS, 'civil/graphs/enrich.graph.yaml': 'spec: [unclosed' });
  assert.ok(!units.some((u) => u.id === 'graph/enrich'));
  // The subgraph reference now points at nothing, so it is simply not a dependency.
  assert.deepEqual(units.find((u) => u.id === 'graph/classify')?.dependsOn, ['graph/classify/classifier']);
});

const emission = () =>
  shapeOutput(
    {
      'src/graphs/classify.py': 'def run(x):\n    return x\n',
      'src/agents/classifier.py': 'engine = Engine(model="m")\n',
      'src/boundaries/public_api.py': 'app = FastAPI()\n',
      'src/__init__.py': '',
      'web/src/civil/client.ts': 'export {};\n',
    },
    {
      'src/graphs/classify.py': 'orchestration',
      'src/agents/classifier.py': 'agent',
      'src/boundaries/public_api.py': 'boundary-server',
      'web/src/civil/client.ts': 'boundary-client',
    },
    1,
    {
      'src/graphs/classify.py': 'graph/classify',
      'src/agents/classifier.py': 'graph/classify/classifier',
      'src/boundaries/public_api.py': 'app/public-api',
      'src/__init__.py': 'shared',
    },
  );

test('attachRegistry files every emitted file under its unit and never lists itself', () => {
  const output = emission();
  attachRegistry(output, deriveUnits(DOCUMENTS), FP);

  assert.equal(output.roles[REGISTRY_PATH], 'registry');
  const registry = parse(output.files[REGISTRY_PATH]!) as {
    kind: string;
    units: Record<string, { files?: Record<string, { role: string; hash: string }>; depends_on?: string[] }>;
    shared?: { files: Record<string, unknown> };
  };
  assert.equal(registry.kind, 'Registry');
  assert.deepEqual(Object.keys(registry.units['graph/classify']!.files!), ['src/graphs/classify.py']);
  assert.deepEqual(Object.keys(registry.units['graph/classify/classifier']!.files!), ['src/agents/classifier.py']);
  // The web client spans the api boundaries; with exactly one, it belongs to it.
  assert.deepEqual(Object.keys(registry.units['app/public-api']!.files!).sort(), [
    'src/boundaries/public_api.py',
    'web/src/civil/client.ts',
  ]);
  assert.equal(registry.units['app/public-api']!.files!['src/boundaries/public_api.py']!.role, 'boundary-server');
  assert.match(registry.units['app/public-api']!.files!['src/boundaries/public_api.py']!.hash, /^sha256:[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(registry.shared!.files), ['src/__init__.py']);
  assert.ok(!output.files[REGISTRY_PATH]!.includes(`${REGISTRY_PATH}:`), 'the registry never lists itself');
  // A unit with nothing emitted still appears: the registry is the architecture, not a file list.
  assert.deepEqual(registry.units['app/web']!.depends_on, ['app/public-api']);
});

test('the registry is byte-stable, and a content change moves exactly one hash', () => {
  const units = deriveUnits(DOCUMENTS);
  const a = emission();
  const b = emission();
  attachRegistry(a, units, FP);
  attachRegistry(b, units, FP);
  assert.equal(a.files[REGISTRY_PATH], b.files[REGISTRY_PATH], 'same inputs, same bytes');

  // Re-attaching (the memo-hit path) is idempotent.
  const again = a.files[REGISTRY_PATH];
  attachRegistry(a, units, FP);
  assert.equal(a.files[REGISTRY_PATH], again);

  const c = emission();
  c.files['src/graphs/classify.py'] = 'def run(x):\n    return [x]\n';
  const changed = buildRegistry(units, c, FP).split('\n');
  const base = buildRegistry(units, emission(), FP).split('\n');
  const diff = changed.filter((line, i) => line !== base[i]);
  assert.equal(diff.length, 1, 'one line moves');
  assert.match(diff[0]!, /hash: sha256:/);
});

test('an emission stored before units existed reads every file as shared', () => {
  const output = shapeOutput({ 'a.py': 'x' }, {}, 1);
  assert.deepEqual(output.units, { 'a.py': 'shared' });
});

test('transpileProject sends the unit list and lands the registry as a maintained pending file', async () => {
  let sent: { units?: unknown } = {};
  const service = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/transpile/meta') {
        res.end(JSON.stringify({ model: 'm', promptVersion: '6' }));
      } else {
        sent = JSON.parse(raw);
        res.end(JSON.stringify({
          files: { 'src/graphs/enrich.py': 'def run(x):\n    return x\n' },
          roles: { 'src/graphs/enrich.py': 'orchestration' },
          units: { 'src/graphs/enrich.py': 'graph/enrich' },
          attempts: 1,
        }));
      }
    });
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const { port } = service.address() as { port: number };

  const saved: string[] = [];
  let stored: { files: Record<string, string>; units: Record<string, string> } | undefined;
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO transpilations')) {
        stored = JSON.parse(params[3] as string);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO pending_changes') && sql.includes('RETURNING')) {
        saved.push(params[3] as string);
        return { rows: [{ path: params[3], kind: 'add', content: params[5], updatedAt: 'now' }] };
      }
      if (sql.includes('FROM projects') && sql.includes('patterns_stale')) {
        return { rows: [{ stale: false, head: null, headSha: null }] };
      }
      return { rows: [] };
    },
  };
  const files: Record<string, string> = { ...DOCUMENTS, 'civil/patterns.md': '# patterns\n' };
  const overlay = {
    exists: (p: string) => p in files,
    read: (p: string) => files[p],
    list: () => Object.keys(files).sort(),
    glob: () => [] as string[],
  };

  const flow = await transpileProject(
    { config: { runnerUrl: `http://127.0.0.1:${port}` }, pool } as never,
    'owner',
    { id: 'proj', defaultBranch: 'main' } as never,
    { exists: () => false } as never,
    overlay as never,
  );
  service.close();

  const ids = (sent.units as { id: string }[]).map((u) => u.id);
  assert.ok(ids.includes('graph/enrich') && ids.includes('app/public-api'), 'the runner gets the unit list');
  assert.ok(REGISTRY_PATH in flow.output.files, 'the registry is part of the emission');
  assert.ok(saved.includes(REGISTRY_PATH), 'and lands as a pending change, reviewed like the code');
  assert.ok(stored && REGISTRY_PATH in stored.files, 'stored in the memo, so it is a maintained file');
  assert.equal(stored!.units['src/graphs/enrich.py'], 'graph/enrich');
});

const sourceWith = (files: Record<string, string>) => ({
  exists: (p: string) => p in files,
  read: (p: string) => files[p],
  list: () => Object.keys(files).sort(),
  glob: () => [] as string[],
});

test('currentEmission reads each registered file as the project has it now', async () => {
  const output = emission();
  attachRegistry(output, deriveUnits(DOCUMENTS), FP);
  const project = {
    ...output.files,
    // Hand-edited outside Civil since: the revision starts from this, not the emission.
    'src/graphs/classify.py': 'def run(x):\n    return x  # tuned by hand\n',
  };
  delete (project as Record<string, string>)['src/agents/classifier.py']; // deleted by hand

  const current = await currentEmission(sourceWith(project) as never);
  assert.deepEqual(
    current.map((c) => [c.path, c.unit, c.role]),
    [
      ['src/__init__.py', 'shared', 'other'],
      ['src/boundaries/public_api.py', 'app/public-api', 'boundary-server'],
      ['src/graphs/classify.py', 'graph/classify', 'orchestration'],
    ],
    'the generated client and the registry itself are never offered; a deleted file is skipped',
  );
  assert.match(current.find((c) => c.path === 'src/graphs/classify.py')!.content, /tuned by hand/);
});

test('no registry, or an unreadable one, means writing fresh', async () => {
  assert.deepEqual(await currentEmission(sourceWith({}) as never), []);
  assert.deepEqual(await currentEmission(sourceWith({ [REGISTRY_PATH]: 'units: [broken' }) as never), []);
});

test('a miss sends the current code; the memo key ignores it', async () => {
  const bodies: { current?: { path: string }[] }[] = [];
  const service = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/transpile/meta') return res.end(JSON.stringify({ model: 'm', promptVersion: '7' }));
      bodies.push(JSON.parse(raw));
      res.end(JSON.stringify({ files: { 'src/graphs/enrich.py': 'v2' }, units: { 'src/graphs/enrich.py': 'graph/enrich' } }));
    });
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const { port } = service.address() as { port: number };

  const prior = shapeOutput({ 'src/graphs/enrich.py': 'v1' }, { 'src/graphs/enrich.py': 'orchestration' }, 1, {
    'src/graphs/enrich.py': 'graph/enrich',
  });
  attachRegistry(prior, deriveUnits(DOCUMENTS), FP);
  const files: Record<string, string> = { ...DOCUMENTS, 'civil/patterns.md': '# p\n', ...prior.files };
  const hashes: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('input_hash') && sql.includes('SELECT')) {
        hashes.push(params[2] as string);
        return { rows: [] };
      }
      // maintainedPaths: the prior emission is Civil's, so it is never offered as context.
      if (sql.includes('FROM transpilations')) return { rows: [{ output: { files: prior.files } }] };
      if (sql.includes('FROM projects') && sql.includes('patterns_stale')) {
        return { rows: [{ stale: false, head: null, headSha: null }] };
      }
      if (sql.includes('RETURNING')) return { rows: [{ path: params[3], kind: 'add', content: params[5], updatedAt: 'now' }] };
      return { rows: [] };
    },
  };
  const run = (overlay: Record<string, string>) =>
    transpileProject(
      { config: { runnerUrl: `http://127.0.0.1:${port}` }, pool } as never,
      'owner',
      { id: 'proj', defaultBranch: 'main' } as never,
      { exists: () => false } as never,
      sourceWith(overlay) as never,
    );

  await run(files);
  const withoutCode = { ...files };
  delete withoutCode['src/graphs/enrich.py'];
  delete withoutCode[REGISTRY_PATH];
  await run(withoutCode);
  service.close();

  assert.deepEqual(bodies[0]!.current!.map((c) => c.path), ['src/graphs/enrich.py'], 'the miss revises the current file');
  assert.equal(bodies[1]!.current, undefined, 'no registry, no current code: written fresh');
  assert.equal(hashes[0], hashes[1], 'the memo key is the sketch state, not the code it last produced');
});

test('the registry records the sketch it was generated from, and apply state reads it', () => {
  const output = emission();
  attachRegistry(output, deriveUnits(DOCUMENTS), FP);
  assert.match(output.files[REGISTRY_PATH]!, /^generated_from: sha256:00000000feedface$/m);

  const project = { ...output.files };
  assert.equal(applyState(sourceWith(project) as never, FP), 'current');
  assert.equal(applyState(sourceWith(project) as never, 'sha256:somethingelse0'), 'stale');
  assert.equal(applyState(sourceWith({}) as never, FP), 'never', 'nothing generated yet');
  const legacy = { [REGISTRY_PATH]: 'apiVersion: civil/v1\nkind: Registry\nunits: {}\n' };
  assert.equal(applyState(sourceWith(legacy) as never, FP), 'never', 'a registry from before generated_from');
});

test('the sketch fingerprint moves with the sketch and the code it uses, never with Civil', () => {
  const inputs = { documents: { 'civil/app.yaml': 'a' }, context: { 'src/x.py': 'x' }, patterns: '# p' };
  const fp = sketchFingerprint(inputs);
  assert.match(fp, /^sha256:[0-9a-f]{16}$/);
  assert.equal(sketchFingerprint({ ...inputs }), fp, 'deterministic');
  assert.notEqual(sketchFingerprint({ ...inputs, documents: { 'civil/app.yaml': 'b' } }), fp, 'a sketch edit');
  assert.notEqual(sketchFingerprint({ ...inputs, context: { 'src/x.py': 'y' } }), fp, 'a handler edit');
  assert.notEqual(sketchFingerprint({ ...inputs, patterns: '# q' }), fp, 'new patterns');
  // No model id or prompt version is an input at all: upgrading Civil cannot move it.
  assert.equal(sketchFingerprint.length, 1);
});
