import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryFiles, validateProject } from '../dist/index.js';
import { codes } from './helpers.ts';

// ---------------------------------------------------------------------------
// validateProject walks the composition, follows service→graph impls as roots,
// and descends subgraph refs with a colour-marked DFS. These tests exercise
// that walk with an in-memory files stub and an in-memory loadDoc, matching the
// style of the cross-file cases in validate.test.ts.
// ---------------------------------------------------------------------------

const composition = (spec: unknown, layout: unknown = { nodes: {} }) => ({
  apiVersion: 'civil/v1',
  kind: 'Composition',
  metadata: { id: 'test' },
  spec,
  layout,
});

const graph = (spec: unknown, layout: unknown = { nodes: {} }) => ({
  apiVersion: 'civil/v1',
  kind: 'Graph',
  metadata: { id: 'test' },
  spec,
  layout,
});

/** loadDoc backed by a plain record; undefined for anything absent (as YAML parse would). */
const loaderFor = (docs: Record<string, unknown>) => (p: string): unknown => docs[p];

test('graph files are discovered in DFS pre-order, descending each ref fully', () => {
  const files = MemoryFiles.from({
    'app.yaml': '',
    'graphs/a.graph.yaml': '',
    'graphs/b.graph.yaml': '',
    'graphs/c.graph.yaml': '',
    'graphs/d.graph.yaml': '',
  });
  const docs = {
    'app.yaml': composition({
      nodes: [{ id: 'svc', type: 'service', impl: { graph: 'graphs/a.graph.yaml' } }],
    }),
    // a fans out to b then c; b nests d.
    'graphs/a.graph.yaml': graph({
      nodes: [
        { id: 'to_b', type: 'subgraph', ref: 'graphs/b.graph.yaml' },
        { id: 'to_c', type: 'subgraph', ref: 'graphs/c.graph.yaml' },
      ],
    }),
    'graphs/b.graph.yaml': graph({
      nodes: [{ id: 'to_d', type: 'subgraph', ref: 'graphs/d.graph.yaml' }],
    }),
    'graphs/c.graph.yaml': graph({ nodes: [] }),
    'graphs/d.graph.yaml': graph({ nodes: [] }),
  };

  const r = validateProject('app.yaml', { files, loadDoc: loaderFor(docs) });
  assert.deepEqual(r.diagnostics, [], 'a fully-resolved project should be clean');
  // Pre-order: a, then all of b's subtree (b, d), then c.
  assert.deepEqual(r.graphFiles, [
    'graphs/a.graph.yaml',
    'graphs/b.graph.yaml',
    'graphs/d.graph.yaml',
    'graphs/c.graph.yaml',
  ]);
});

test('a graph reached by two paths is validated and listed once (colour marking)', () => {
  const files = MemoryFiles.from({
    'app.yaml': '',
    'graphs/a.graph.yaml': '',
    'graphs/b.graph.yaml': '',
    'graphs/c.graph.yaml': '',
    'graphs/shared.graph.yaml': '',
  });
  const docs = {
    'app.yaml': composition({
      nodes: [{ id: 'svc', type: 'service', impl: { graph: 'graphs/a.graph.yaml' } }],
    }),
    'graphs/a.graph.yaml': graph({
      nodes: [
        { id: 'to_b', type: 'subgraph', ref: 'graphs/b.graph.yaml' },
        { id: 'to_c', type: 'subgraph', ref: 'graphs/c.graph.yaml' },
      ],
    }),
    'graphs/b.graph.yaml': graph({
      nodes: [{ id: 'to_shared', type: 'subgraph', ref: 'graphs/shared.graph.yaml' }],
    }),
    'graphs/c.graph.yaml': graph({
      nodes: [{ id: 'to_shared', type: 'subgraph', ref: 'graphs/shared.graph.yaml' }],
    }),
    'graphs/shared.graph.yaml': graph({ nodes: [] }),
  };

  const r = validateProject('app.yaml', { files, loadDoc: loaderFor(docs) });
  assert.deepEqual(r.diagnostics, []);
  // shared is visited via b first, then short-circuited via c: it appears exactly once.
  assert.deepEqual(r.graphFiles, [
    'graphs/a.graph.yaml',
    'graphs/b.graph.yaml',
    'graphs/shared.graph.yaml',
    'graphs/c.graph.yaml',
  ]);
});

test('a missing subgraph ref inside a descended graph is reported per-node', () => {
  const files = MemoryFiles.from({
    'app.yaml': '',
    'graphs/a.graph.yaml': '',
    // graphs/missing.graph.yaml deliberately absent from files.
  });
  const docs = {
    'app.yaml': composition({
      nodes: [{ id: 'svc', type: 'service', impl: { graph: 'graphs/a.graph.yaml' } }],
    }),
    'graphs/a.graph.yaml': graph({
      nodes: [{ id: 'gone', type: 'subgraph', ref: 'graphs/missing.graph.yaml' }],
    }),
  };

  const r = validateProject('app.yaml', { files, loadDoc: loaderFor(docs) });

  // validateGraph flags the dangling ref, attributed to the subgraph node and its file.
  assert.deepEqual(codes(r.diagnostics), ['unresolved-ref']);
  const d = r.diagnostics[0]!;
  assert.equal(d.nodeId, 'gone');
  assert.equal(d.file, 'graphs/a.graph.yaml');
  assert.equal(d.jsonPointer, '/spec/nodes/0/ref');

  // The walk still records both the resolved graph and the (unloadable) ref it chased.
  assert.deepEqual(r.graphFiles, ['graphs/a.graph.yaml', 'graphs/missing.graph.yaml']);
});

test('an unreadable composition yields a single "could not be read" diagnostic and no graphs', () => {
  const files = MemoryFiles.from({});
  // loadDoc returns undefined for the composition path.
  const r = validateProject('app.yaml', { files, loadDoc: () => undefined });

  assert.equal(r.diagnostics.length, 1);
  const d = r.diagnostics[0]!;
  assert.equal(d.code, 'unresolved-ref');
  assert.equal(d.severity, 'error');
  assert.equal(d.file, 'app.yaml');
  assert.match(d.message, /could not be read/);
  assert.deepEqual(r.graphFiles, []);
});

test('a service graph impl missing from files is reported by the composition and still discovered', () => {
  // The graph file exists in neither `files` nor `loadDoc`.
  const files = MemoryFiles.from({ 'app.yaml': '' });
  const docs = {
    'app.yaml': composition({
      nodes: [{ id: 'svc', type: 'service', impl: { graph: 'graphs/missing.graph.yaml' } }],
    }),
  };

  const r = validateProject('app.yaml', { files, loadDoc: loaderFor(docs) });

  // Composition-level existence check catches the dangling graph impl as unresolved-ref.
  assert.deepEqual(codes(r.diagnostics), ['unresolved-ref']);
  const d = r.diagnostics[0]!;
  assert.equal(d.nodeId, 'svc');
  assert.equal(d.file, 'app.yaml');
  // The root is still walked (and so listed), even though it cannot be loaded.
  assert.deepEqual(r.graphFiles, ['graphs/missing.graph.yaml']);
});

test('services implemented as a function are not graph roots and are never descended', () => {
  const files = MemoryFiles.from({ 'app.yaml': '', 'src/s.py': '' });
  const docs = {
    'app.yaml': composition({
      nodes: [{ id: 'svc', type: 'service', impl: { entrypoint: 'src/s.py' } }],
    }),
  };

  const r = validateProject('app.yaml', { files, loadDoc: loaderFor(docs) });
  // An existing entrypoint is clean, and produces no graph descent at all.
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(r.graphFiles, []);
});

test('a missing function entrypoint is an unresolved-entrypoint, distinct from a graph ref', () => {
  const files = MemoryFiles.from({ 'app.yaml': '' });
  const docs = {
    'app.yaml': composition({
      nodes: [{ id: 'svc', type: 'service', impl: { entrypoint: 'src/gone.py' } }],
    }),
  };

  const r = validateProject('app.yaml', { files, loadDoc: loaderFor(docs) });
  assert.deepEqual(codes(r.diagnostics), ['unresolved-entrypoint']);
  assert.equal(r.diagnostics[0]!.nodeId, 'svc');
  assert.deepEqual(r.graphFiles, []);
});
