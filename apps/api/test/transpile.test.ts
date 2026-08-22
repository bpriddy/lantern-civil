import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gatherAnalyzerFiles,
  gatherInputs,
  inputHash,
} from '../dist/project/transpile.js';

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
