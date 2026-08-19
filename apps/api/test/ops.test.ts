import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { MemoryFiles, validateGraph } from '@civil/schema';
import { applyOps } from '../dist/manifest/apply.js';

/**
 * The gap that let `include: - glob` through: the earlier tests checked how the edit
 * looked and what it left alone, but never that the result was YAML at all. An edit
 * that produces an unparseable manifest is the exact silent corruption PRD 2 cares
 * about — the canvas simply empties and says nothing.
 */
function stillParses(source: string, what: string): unknown {
  try {
    return parse(source);
  } catch (error) {
    assert.fail(`${what} produced unparseable YAML: ${(error as Error).message}`);
  }
}

/**
 * PRD 14 M3's exit criterion is that "the YAML looks hand-written". These check the
 * half of that which a round-trip test cannot: that an edit adds what was asked for,
 * in the style of its neighbours, and changes nothing else.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(here, '../../../examples/doc-pipeline');
const read = (p: string) => fs.readFileSync(path.join(EXAMPLE, p), 'utf8');

/** Every line the edit did not touch must be identical, in the same order. */
function untouchedLinesSurvive(before: string, after: string): void {
  const removed = before.split('\n').filter((line) => !after.split('\n').includes(line));
  assert.deepEqual(removed, [], 'an edit removed or altered lines it did not add');
}

test('adds a node to a block-style sequence in block style', () => {
  const before = read('app.yaml');
  const { source: after, summary } = applyOps(before, [
    { op: 'addNode', node: { id: 'audit', type: 'service', impl: { entrypoint: 'src/services/audit.py' } } },
  ]);

  assert.match(summary, /Added service “audit”/);
  assert.ok(after.includes('- id: audit'), 'new item follows the block style already in the file');
  assert.ok(!after.includes('{ id: audit'), 'it did not switch the file to flow style');
  untouchedLinesSurvive(before, after);
});

test('adds a node to a flow-style sequence in flow style', () => {
  const before = read('graphs/classify.graph.yaml');
  const { source: after } = applyOps(before, [
    { op: 'addNode', node: { id: 'summary', type: 'io', direction: 'out' } },
  ]);

  assert.ok(
    /- \{ id: summary, type: io, direction: out \}/.test(after),
    `expected a flow item, got:\n${after.split('\n').filter((l) => l.includes('summary')).join('\n')}`,
  );
  untouchedLinesSurvive(before, after);
});

test('comments and blank lines around the edit are left alone', () => {
  const before = read('app.yaml');
  const { source: after } = applyOps(before, [
    { op: 'addNode', node: { id: 'audit', type: 'service', impl: { entrypoint: 'x.py' } } },
  ]);

  // app.yaml's nodes are separated by blank lines; the file should still read that way.
  assert.equal(
    (before.match(/\n\n/g) ?? []).length <= (after.match(/\n\n/g) ?? []).length,
    true,
    'blank-line rhythm was lost',
  );
  assert.ok(after.startsWith('apiVersion: civil/v1'), 'the head of the file is untouched');
});

test('layout is written as a sibling of spec, never inside it', () => {
  const before = read('app.yaml');
  const { source: after } = applyOps(before, [
    { op: 'addNode', node: { id: 'audit', type: 'service', impl: { entrypoint: 'x.py' } } },
    { op: 'setLayout', id: 'audit', x: 720, y: 400 },
  ]);

  const layoutAt = after.indexOf('\nlayout:');
  const specAt = after.indexOf('\nspec:');
  assert.ok(layoutAt > specAt, 'layout must follow spec at the top level');
  assert.ok(after.slice(layoutAt).includes('audit: { x: 720, y: 400 }'));
  // PRD 6.3: dragging a node must not look like a semantic change, which only holds
  // if the position lives outside spec.
  assert.ok(!after.slice(specAt, layoutAt).includes('720'), 'a position leaked into spec');
});

test('moving an existing node rewrites only its coordinates', () => {
  const before = read('app.yaml');
  const { source: after, summary } = applyOps(before, [
    { op: 'setLayout', id: 'classify', x: 999, y: 111 },
  ]);

  assert.match(summary, /Moved “classify”/);
  assert.ok(after.includes('classify: { x: 999, y: 111 }'));
  assert.equal(after.split('\n').length, before.split('\n').length, 'the file changed length');
  // Exactly one line differs.
  const differing = before.split('\n').filter((line, i) => line !== after.split('\n')[i]);
  assert.equal(differing.length, 1, `expected one changed line, got ${differing.length}`);
});

test('a sequence that does not exist is refused rather than invented', () => {
  assert.throws(
    () => applyOps('apiVersion: civil/v1\nkind: Composition\n', [
      { op: 'addNode', node: { id: 'a', type: 'service' } },
    ]),
    /not a sequence/,
  );
});

test('a node with no id is refused', () => {
  assert.throws(
    () => applyOps(read('app.yaml'), [{ op: 'addNode', node: { type: 'service' } }]),
    /needs an id/,
  );
});


test('an added node leaves the manifest parseable and valid', () => {
  const before = read('graphs/classify.graph.yaml');
  const { source: after } = applyOps(before, [
    {
      op: 'addNode',
      node: {
        id: 'summarize',
        type: 'code',
        name: 'Summarize',
        include: ['src/steps/summarize/**/*.py'],
        entrypoint: 'src/steps/summarize/main.py',
      },
    },
  ]);

  const parsed = stillParses(after, 'addNode with a list value');

  // And it must survive the validator, not merely the parser: a node the schema
  // rejects is as broken as one YAML rejects, just later.
  const files = MemoryFiles.from({
    'agents/classifier/agent.yaml': '',
    'graphs/enrich.graph.yaml': '',
    'src/steps/normalize/main.py': '',
    'src/steps/summarize/main.py': '',
    'src/tools/search/search.py': '',
    'schemas/document.schema.json': '{}',
    'schemas/record.schema.json': '{}',
  });
  const result = validateGraph(parsed, 'graphs/classify.graph.yaml', files);
  assert.ok(result.doc, `validator rejected the edited manifest: ${JSON.stringify(result.diagnostics)}`);

  const added = result.doc.spec.nodes.find((n) => n.id === 'summarize');
  assert.ok(added, 'the added node is not in the parsed manifest');
  assert.equal(added.type, 'code');
  // The list survived as a list rather than becoming a string or a broken sequence.
  assert.deepEqual((added as { include: string[] }).include, ['src/steps/summarize/**/*.py']);
});

test('a nested object value survives as an object', () => {
  const before = read('app.yaml');
  const { source: after } = applyOps(before, [
    { op: 'addNode', node: { id: 'audit', type: 'service', impl: { entrypoint: 'src/services/audit.py' } } },
  ]);

  const parsed = stillParses(after, 'addNode with a nested mapping') as {
    spec: { nodes: { id: string; impl?: { entrypoint?: string } }[] };
  };
  const added = parsed.spec.nodes.find((n) => n.id === 'audit');
  assert.equal(added?.impl?.entrypoint, 'src/services/audit.py');
});


test('the first node in a scaffolded project lands correctly', () => {
  // Exactly what "Add Civil to this project" writes. Every new project's first node
  // goes through this path, so it is the common case rather than an edge one.
  const scaffold = [
    'apiVersion: civil/v1',
    'kind: Composition',
    'metadata:',
    '  id: demo',
    '',
    '# The composition canvas.',
    'spec:',
    '  nodes: []',
    '  edges: []',
    '',
    'layout:',
    '  nodes: {}',
    '',
  ].join('\n');

  const { source: after } = applyOps(scaffold, [
    { op: 'addNode', node: { id: 'classify', type: 'service', impl: { graph: 'graphs/classify.graph.yaml' } } },
    { op: 'setLayout', id: 'classify', x: 200, y: 120 },
  ]);

  const parsed = stillParses(after, 'first node into an empty sequence') as {
    spec: { nodes: { id: string }[]; edges: unknown[] };
    layout: { nodes: Record<string, unknown> };
  };

  assert.equal(parsed.spec.nodes.length, 1);
  assert.equal(parsed.spec.nodes[0]!.id, 'classify');
  // The empty brackets are replaced, not left behind beside the new item.
  assert.ok(!after.includes('nodes: []'), `\`nodes: []\` survived:\n${after}`);
  // Its neighbours are untouched.
  assert.deepEqual(parsed.spec.edges, []);
  assert.ok(after.includes('# The composition canvas.'), 'a comment was lost');
  assert.deepEqual(parsed.layout.nodes, { classify: { x: 200, y: 120 } });
});

test('an empty sequence in a four-space file is indented to match', () => {
  const source = ['spec:', '    nodes: []', ''].join('\n');
  const { source: after } = applyOps(source, [
    { op: 'addNode', node: { id: 'a', type: 'service' } },
  ]);
  stillParses(after, 'first node in a four-space file');
  assert.ok(after.includes('\n        - id: a'), `wrong indent:\n${JSON.stringify(after)}`);
});


test('a scaffolded project survives more than one node', () => {
  // The first node replaces an empty sequence; the second appends to what the first
  // left behind. Testing only the first hid a corruption that appeared on the second.
  const scaffold = [
    'apiVersion: civil/v1',
    'kind: Composition',
    'metadata:',
    '  id: demo',
    '',
    '# The composition canvas.',
    'spec:',
    '  nodes: []',
    '  edges: []',
    '',
    'layout:',
    '  nodes: {}',
    '',
  ].join('\n');

  const first = applyOps(scaffold, [
    { op: 'addNode', node: { id: 'classify', type: 'service', impl: { entrypoint: 'a.py' } } },
    { op: 'setLayout', id: 'classify', x: 200, y: 120 },
  ]).source;
  stillParses(first, 'first node');

  const second = applyOps(first, [
    { op: 'addNode', node: { id: 'public-api', type: 'client', client: 'api', exposes: ['classify'] } },
    { op: 'setLayout', id: 'public-api', x: 40, y: 120 },
  ]).source;

  const parsed = stillParses(second, 'second node') as {
    spec: { nodes: { id: string }[]; edges: unknown[] };
    layout: { nodes: Record<string, { x: number; y: number }> };
  };

  assert.deepEqual(parsed.spec.nodes.map((n) => n.id), ['classify', 'public-api']);
  // `edges: []` must remain its own key rather than being swallowed by the new item.
  assert.deepEqual(parsed.spec.edges, []);
  assert.deepEqual(parsed.layout.nodes, {
    classify: { x: 200, y: 120 },
    'public-api': { x: 40, y: 120 },
  });
  // And no stray key escaped to the top level.
  assert.deepEqual(Object.keys(parsed).sort(), ['apiVersion', 'kind', 'layout', 'metadata', 'spec']);
});
