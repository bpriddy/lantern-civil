import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { once } from 'node:events';
import {
  gatherAnalyzerFiles,
  gatherInputs,
  inputHash,
} from '../dist/project/transpile.js';
import { transpileProject } from '../dist/http/transpile-routes.js';

/**
 * What the transpiler sees decides what the model emits and what the memo replays.
 * A discovery bug here does not error — it silently narrows the context or serves
 * stale bytes with confidence, the corruption class PRD 2 says is worth testing.
 */

const sourceOf = (files: Record<string, string>) => ({
  exists(p: string) { return p in files; },
  read(p: string) { return files[p]; },
  list() { return Object.keys(files).sort(); },
  glob() { return [] as string[]; },
});

const project = {
  'civil.yaml': [
    'apiVersion: civil/v1',
    'kind: Project',
    'metadata: { id: proj }',
    'spec: { composition: app.yaml }',
  ].join('\n'),
  'app.yaml': [
    'apiVersion: civil/v1',
    'kind: Composition',
    'metadata: { id: app }',
    'spec:',
    '  nodes:',
    '    - { id: pipeline, type: service, impl: { graph: flows/pipeline.yaml } }',
  ].join('\n'),
  // Outside graphs/ on purpose: reachable only by following the impl ref.
  'flows/pipeline.yaml': [
    'apiVersion: civil/v1',
    'kind: Graph',
    'metadata: { id: pipeline }',
    'spec:',
    '  nodes:',
    '    - { id: prep, type: code, entrypoint: lib/steps.py }',
    '    - { id: sub, type: subgraph, ref: flows/sub.yaml }',
  ].join('\n'),
  // Refs its parent back — the walk must terminate anyway.
  'flows/sub.yaml': [
    'apiVersion: civil/v1',
    'kind: Graph',
    'metadata: { id: sub }',
    'spec:',
    '  nodes:',
    '    - { id: back, type: subgraph, ref: flows/pipeline.yaml }',
  ].join('\n'),
  'lib/steps.py': 'def prep(): ...',
  'src/util.py': 'def helper(): ...',
  'tools/extra.py': 'def unreferenced(): ...',
  'app/main.py': 'emitted by civil',
  'civil/patterns.md': 'the helper prompt',
};

const none: ReadonlySet<string> = new Set();

test('graphs are discovered by following refs, not only the graphs/ convention', async () => {
  const inputs = await gatherInputs(sourceOf(project), none);
  assert.ok('flows/pipeline.yaml' in inputs.documents, 'composition impl.graph is followed');
  assert.ok('flows/sub.yaml' in inputs.documents, 'subgraph refs are followed');
  assert.ok('lib/steps.py' in inputs.context, 'the ref-found graph contributes its entrypoint');
  assert.ok('src/util.py' in inputs.context, 'src/ stays a default context directory');
  assert.ok(!('tools/extra.py' in inputs.context), 'unreferenced code stays out of context');
  assert.equal(inputs.patterns, 'the helper prompt');
});

test('a self-referencing subgraph terminates too', async () => {
  // The base project already carries the mutual cycle (pipeline ↔ sub); this is
  // the degenerate one.
  const cyclic = {
    ...project,
    'flows/sub.yaml': [
      'apiVersion: civil/v1',
      'kind: Graph',
      'metadata: { id: sub }',
      'spec:',
      '  nodes:',
      '    - { id: again, type: subgraph, ref: flows/sub.yaml }',
    ].join('\n'),
  };
  const inputs = await gatherInputs(sourceOf(cyclic), none);
  assert.ok('flows/pipeline.yaml' in inputs.documents);
  assert.ok('flows/sub.yaml' in inputs.documents);
});

test('maintained paths are not context — re-emitting them must stay legal', async () => {
  const maintained = new Set(['app/main.py', 'src/util.py']);
  const inputs = await gatherInputs(sourceOf(project), maintained);
  assert.ok(!('app/main.py' in inputs.context));
  assert.ok(!('src/util.py' in inputs.context), 'maintained wins even inside src/');
  assert.ok('lib/steps.py' in inputs.context, 'human code still travels');
});

test('the analyzer reads all repo code minus civil documents and civil output', async () => {
  const files = await gatherAnalyzerFiles(sourceOf(project), new Set(['app/main.py']));
  assert.deepEqual(Object.keys(files).sort(), ['lib/steps.py', 'src/util.py', 'tools/extra.py']);
});

test('the runner fingerprint is part of the memo key', () => {
  const inputs = { documents: { 'app.yaml': 'x' }, context: {}, patterns: null };
  const base = { model: 'claude-sonnet-5', promptVersion: '1' };
  assert.equal(inputHash(inputs, base), inputHash(inputs, { ...base }));
  assert.notEqual(inputHash(inputs, base), inputHash(inputs, { ...base, model: 'claude-6' }));
  assert.notEqual(inputHash(inputs, base), inputHash(inputs, { ...base, promptVersion: '2' }));
});

// --- retirement --------------------------------------------------------------

/**
 * A stale emission left running beside a fresh one is the exact crash retirement
 * fixes (docs/app-session.md): a path a past emission produced and this one does
 * not is a delete when it exists at HEAD (so a commit removes it from the repo too)
 * and a plain revert when it was only ever pending.
 */

/** The runner, faked to answer just the two calls transpileProject makes. */
const fakeRunner = async (emitted: Record<string, string>) => {
  const service = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/transpile/meta') {
        res.end(JSON.stringify({ model: 'claude-sonnet-5', promptVersion: '1' }));
      } else if (req.url === '/transpile') {
        res.end(JSON.stringify({ files: emitted, roles: {}, attempts: 1 }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  service.listen(0, '127.0.0.1');
  await once(service, 'listening');
  const { port } = service.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => service.close() };
};

test('a path a prior emission produced and this one drops is retired from pending', async () => {
  const runner = await fakeRunner({ 'app/main.py': 'the new emission' });

  // The prior emission's union, as maintainedPaths reads it: main survives, legacy
  // and only_pending do not.
  const maintainedFiles = {
    'app/main.py': 'old',
    'app/legacy.py': 'old',
    'src/only_pending.py': 'old',
  };

  const deleted: string[] = [];
  const reverted: string[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO transpilations')) return { rows: [] }; // storeMemo
      if (sql.includes('INSERT INTO pending_changes') && sql.includes('RETURNING')) {
        return {
          rows: [{ path: params[3], kind: 'add', content: params[5], updatedAt: 'now' }],
        }; // savePending
      }
      if (sql.includes('INSERT INTO pending_changes')) {
        deleted.push(params[3] as string); // deletePending, path is $4
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM pending_changes')) {
        reverted.push(params[3] as string); // revertPending, path is $4
        return { rowCount: 1 };
      }
      if (sql.includes('FROM transpilations') && sql.includes('input_hash')) {
        return { rows: [] }; // findMemo miss — a genuine transpile
      }
      if (sql.includes('FROM transpilations')) {
        return { rows: [{ output: { files: maintainedFiles } }] }; // maintainedPaths
      }
      if (sql.includes('FROM projects') && sql.includes('patterns_stale')) {
        return { rows: [{ stale: false, head: null, headSha: null }] };
      }
      return { rows: [] };
    },
  };

  // Only legacy.py exists at HEAD; only_pending.py was never committed.
  const source = { exists: (p: string) => p === 'app/legacy.py' };
  const overlay = sourceOf(project);
  const deps = { config: { runnerUrl: runner.url }, pool };

  const flow = await transpileProject(
    deps as never,
    'owner',
    { id: 'proj', defaultBranch: 'main' } as never,
    source as never,
    overlay as never,
  );

  runner.close();

  assert.ok('app/main.py' in flow.output.files, 'the surviving file is still emitted');
  assert.deepEqual(flow.retired, ['app/legacy.py', 'src/only_pending.py']);
  assert.deepEqual(deleted, ['app/legacy.py'], 'a HEAD file is retired as a delete');
  assert.deepEqual(reverted, ['src/only_pending.py'], 'a pending-only file is reverted');
});
