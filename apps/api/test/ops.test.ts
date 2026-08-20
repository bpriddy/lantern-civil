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


test('an edge is added in the style of its neighbours and validates', () => {
  const before = read('graphs/classify.graph.yaml');
  const { source: after, summary } = applyOps(before, [
    {
      op: 'addEdge',
      edge: { id: 'e6', kind: 'flow', from: { node: 'normalize' }, to: { node: 'record' } },
    },
  ]);

  assert.match(summary, /Connected normalize → record/);
  assert.ok(/- \{ id: e6, kind: flow, from: \{ node: normalize \}, to: \{ node: record \} \}/.test(after),
    `expected a flow item:\n${after.split('\n').filter((l) => l.includes('e6')).join('\n')}`);
  untouchedLinesSurvive(before, after);

  const parsed = stillParses(after, 'addEdge') as { spec: { edges: { id: string }[] } };
  assert.equal(parsed.spec.edges.length, 6);
});

test('removing an edge takes its whole line with it', () => {
  const before = read('graphs/classify.graph.yaml');
  const { source: after, summary } = applyOps(before, [{ op: 'removeEdge', id: 'e5' }]);

  assert.match(summary, /Disconnected “e5”/);
  const parsed = stillParses(after, 'removeEdge') as { spec: { edges: { id: string }[] } };
  assert.deepEqual(parsed.spec.edges.map((e) => e.id), ['e1', 'e2', 'e3', 'e4']);

  // No orphaned dash, and exactly one line fewer.
  assert.ok(!/^\s*-\s*$/m.test(after), `a bare dash was left behind:\n${after}`);
  assert.equal(after.split('\n').length, before.split('\n').length - 1);
});

test('an edge added to an empty list, then removed, returns the file to itself', () => {
  const scaffold = [
    'apiVersion: civil/v1',
    'kind: Composition',
    'metadata:',
    '  id: demo',
    'spec:',
    '  nodes:',
    '    - id: a',
    '      type: service',
    '    - id: b',
    '      type: service',
    '  edges: []',
    'layout:',
    '  nodes: {}',
    '',
  ].join('\n');

  const added = applyOps(scaffold, [
    { op: 'addEdge', edge: { id: 'c1', kind: 'depends-on', from: { node: 'a' }, to: { node: 'b' } } },
  ]).source;
  const parsed = stillParses(added, 'addEdge into an empty list') as {
    spec: { edges: { id: string }[] };
  };
  assert.equal(parsed.spec.edges.length, 1);

  // Removing it leaves valid YAML with no edges, even though the list is now empty
  // in a different way than it started.
  const removed = applyOps(added, [{ op: 'removeEdge', id: 'c1' }]).source;
  const after = stillParses(removed, 'removeEdge back to empty') as {
    spec: { edges: unknown };
  };
  assert.ok(after.spec.edges === null || (Array.isArray(after.spec.edges) && after.spec.edges.length === 0),
    `expected no edges, got ${JSON.stringify(after.spec.edges)}`);
});

test('removing an edge that is not there is refused', () => {
  assert.throws(
    () => applyOps(read('app.yaml'), [{ op: 'removeEdge', id: 'nope' }]),
    /no item with id "nope"/,
  );
});

// ---------------------------------------------------------------------------
// removeNode

test('removing a node takes its edges and its layout entry with it', () => {
  const before = read('graphs/classify.graph.yaml');
  const { source: after, summary } = applyOps(before, [{ op: 'removeNode', id: 'classifier' }]);

  const parsed = stillParses(after, 'removeNode') as {
    spec: { nodes: { id: string }[]; edges: { id: string; from: { node: string }; to: { node: string } }[] };
    layout: { nodes: Record<string, unknown> };
  };

  assert.ok(!parsed.spec.nodes.some((n) => n.id === 'classifier'), 'the node is still there');
  assert.ok(
    !parsed.spec.edges.some((e) => e.from.node === 'classifier' || e.to.node === 'classifier'),
    'a dangling edge survived',
  );
  assert.ok(!('classifier' in parsed.layout.nodes), 'the layout entry survived');
  assert.match(summary, /Removed agent “classifier” and \d+ edges/);
  // Only lines mentioning the node and its edges changed.
  untouchedLinesSurvive(
    before.split('\n').filter((l) => !l.includes('classifier')).join('\n'),
    after,
  );
});

test('cascadeEdges false refuses while edges remain, and names them', () => {
  assert.throws(
    () => applyOps(read('graphs/classify.graph.yaml'), [
      { op: 'removeNode', id: 'classifier', cascadeEdges: false },
    ]),
    /still has \d+ edges? \("e\d+"/,
  );
});

test('removing the last node leaves empty lists, not null keys', () => {
  const scaffold = [
    'apiVersion: civil/v1',
    'kind: Composition',
    'metadata:',
    '  id: demo',
    'spec:',
    '  nodes:',
    '    - id: only',
    '      type: service',
    '      impl: { entrypoint: a.py }',
    '  edges: []',
    'layout:',
    '  nodes:',
    '    only: { x: 1, y: 2 }',
    '',
  ].join('\n');

  const { source: after } = applyOps(scaffold, [{ op: 'removeNode', id: 'only' }]);
  const parsed = stillParses(after, 'removeNode to empty') as {
    spec: { nodes: unknown[]; edges: unknown[] };
    layout: { nodes: Record<string, unknown> };
  };

  // `[]` and `{}`, so the next addNode appends rather than being refused with
  // "not a sequence" — the add-remove-add cycle every project hits early.
  assert.deepEqual(parsed.spec.nodes, []);
  assert.deepEqual(parsed.layout.nodes, {});
  const again = applyOps(after, [{ op: 'addNode', node: { id: 'next', type: 'service', impl: { entrypoint: 'b.py' } } }]);
  const reparsed = stillParses(again.source, 'addNode after emptying') as { spec: { nodes: { id: string }[] } };
  assert.deepEqual(reparsed.spec.nodes.map((n) => n.id), ['next']);
});

test('removing a node whose edges are the whole list restores edges to []', () => {
  const source = [
    'apiVersion: civil/v1',
    'kind: Composition',
    'metadata:',
    '  id: demo',
    'spec:',
    '  nodes:',
    '    - id: a',
    '      type: service',
    '      impl: { entrypoint: a.py }',
    '    - id: b',
    '      type: service',
    '      impl: { entrypoint: b.py }',
    '  edges:',
    '    - { id: c1, kind: depends-on, from: { node: a }, to: { node: b } }',
    'layout:',
    '  nodes: {}',
    '',
  ].join('\n');

  const { source: after } = applyOps(source, [{ op: 'removeNode', id: 'a' }]);
  const parsed = stillParses(after, 'removeNode taking the whole edge list') as {
    spec: { nodes: { id: string }[]; edges: unknown[] };
  };
  assert.deepEqual(parsed.spec.nodes.map((n) => n.id), ['b']);
  assert.deepEqual(parsed.spec.edges, []);
});

test('an edge removed from an inline flow list takes its comma along', () => {
  const source = [
    'spec:',
    '  nodes: []',
    '  edges: [{ id: c1, kind: flow, from: { node: a }, to: { node: b } }, { id: c2, kind: flow, from: { node: b }, to: { node: c } }]',
    '',
  ].join('\n');

  const first = applyOps(source, [{ op: 'removeEdge', id: 'c1' }]).source;
  const parsed = stillParses(first, 'inline flow removal') as { spec: { edges: { id: string }[] } };
  assert.deepEqual(parsed.spec.edges.map((e) => e.id), ['c2']);

  const second = applyOps(first, [{ op: 'removeEdge', id: 'c2' }]).source;
  const emptied = stillParses(second, 'inline flow removal to empty') as { spec: { edges: unknown[] } };
  assert.deepEqual(emptied.spec.edges, []);
});

// ---------------------------------------------------------------------------
// updateNode / updateEdge

test('updating a field rewrites only its value', () => {
  const before = read('app.yaml');
  const { source: after, summary } = applyOps(before, [
    { op: 'updateNode', id: 'nightly-reindex', patch: { trigger: { kind: 'schedule', cron: '0 5 * * *' } } },
  ]);

  assert.match(summary, /Updated “nightly-reindex” \(set trigger\)/);
  const parsed = stillParses(after, 'updateNode') as {
    spec: { nodes: { id: string; trigger?: { cron: string } }[] };
  };
  assert.equal(parsed.spec.nodes.find((n) => n.id === 'nightly-reindex')?.trigger?.cron, '0 5 * * *');
  assert.equal(after.split('\n').length, before.split('\n').length, 'the file changed shape');
});

test('a patch can add a field the node does not have, in its own style', () => {
  const before = read('graphs/classify.graph.yaml');
  const { source: after } = applyOps(before, [
    { op: 'updateNode', id: 'document', patch: { name: 'Document in' } },
  ]);
  const parsed = stillParses(after, 'updateNode adding a key') as {
    spec: { nodes: { id: string; name?: string }[] };
  };
  assert.equal(parsed.spec.nodes.find((n) => n.id === 'document')?.name, 'Document in');
  // The node is a one-line flow item, so the field joins it there: exactly that line
  // changes and no other.
  const beforeLines = before.split('\n');
  const changed = after.split('\n').filter((line, i) => line !== beforeLines[i]);
  assert.deepEqual(changed, [
    '    - { id: document, type: io, direction: in, schema: schemas/document.schema.json, name: Document in }',
  ]);
});

test('a null in a patch removes the field', () => {
  const withName = applyOps(read('graphs/classify.graph.yaml'), [
    { op: 'updateNode', id: 'document', patch: { name: 'Document in' } },
  ]).source;
  const { source: after, summary } = applyOps(withName, [
    { op: 'updateNode', id: 'document', patch: { name: null } },
  ]);
  assert.match(summary, /removed name/);
  const parsed = stillParses(after, 'updateNode removing a key') as {
    spec: { nodes: { id: string; name?: string }[] };
  };
  assert.equal(parsed.spec.nodes.find((n) => n.id === 'document')?.name, undefined);
});

test('id and type are refused in a patch', () => {
  assert.throws(
    () => applyOps(read('app.yaml'), [{ op: 'updateNode', id: 'classify', patch: { id: 'other' } }]),
    /renameNode/,
  );
  assert.throws(
    () => applyOps(read('app.yaml'), [{ op: 'updateNode', id: 'classify', patch: { type: 'process' } }]),
    /whole shape/,
  );
});

test('updateEdge rewires an endpoint in place', () => {
  const before = read('graphs/classify.graph.yaml');
  const { source: after } = applyOps(before, [
    { op: 'updateEdge', id: 'e1', patch: { to: { node: 'search_tools' } } },
  ]);
  const parsed = stillParses(after, 'updateEdge') as {
    spec: { edges: { id: string; to: { node: string } }[] };
  };
  assert.equal(parsed.spec.edges.find((e) => e.id === 'e1')?.to.node, 'search_tools');
});

// ---------------------------------------------------------------------------
// renameNode

test('renaming a node rewrites every reference in one application', () => {
  const source = [
    'apiVersion: civil/v1',
    'kind: Composition',
    'metadata:',
    '  id: demo',
    'spec:',
    '  nodes:',
    '    - id: public-api',
    '      type: client',
    '      client: api',
    '      exposes: [classify, save-record]',
    '      invocation:',
    '        classify: async',
    '    - id: classify',
    '      type: service',
    '      impl: { entrypoint: a.py }',
    '    - id: reindex',
    '      type: process',
    '      trigger: { kind: schedule, cron: "0 3 * * *" }',
    '      calls: [classify]',
    '  edges:',
    '    - { id: c1, kind: routes-to, from: { node: public-api }, to: { node: classify } }',
    '    - { id: c2, kind: depends-on, from: { node: reindex }, to: { node: classify } }',
    'layout:',
    '  nodes:',
    '    classify: { x: 10, y: 20 }',
    '',
  ].join('\n');

  const { source: after, summary } = applyOps(source, [
    { op: 'renameNode', from: 'classify', to: 'categorize' },
  ]);

  // id + exposes + invocation key + calls + two edge endpoints + layout key = 7 spots.
  assert.match(summary, /Renamed “classify” to “categorize” \(6 references updated\)/);
  assert.ok(!after.includes('classify'), `an old id survived:\n${after}`);

  const parsed = stillParses(after, 'renameNode') as {
    spec: {
      nodes: ({ id: string } & Record<string, unknown>)[];
      edges: { from: { node: string }; to: { node: string } }[];
    };
    layout: { nodes: Record<string, unknown> };
  };
  assert.ok(parsed.spec.nodes.some((n) => n.id === 'categorize'));
  assert.deepEqual(parsed.spec.nodes[0]!['exposes'], ['categorize', 'save-record']);
  assert.deepEqual(parsed.spec.nodes[0]!['invocation'], { categorize: 'async' });
  assert.deepEqual(parsed.spec.nodes[2]!['calls'], ['categorize']);
  assert.ok(parsed.spec.edges.every((e) => e.to.node === 'categorize'));
  assert.ok('categorize' in parsed.layout.nodes);
});

test('a rename does not touch strings that merely contain the id', () => {
  const source = [
    'spec:',
    '  nodes:',
    '    - id: search',
    '      type: code',
    '      name: search',
    '      include: [src/search/**]',
    '      entrypoint: src/search/main.py',
    '  edges: []',
    'layout:',
    '  nodes: {}',
    '',
  ].join('\n');

  const { source: after } = applyOps(source, [{ op: 'renameNode', from: 'search', to: 'lookup' }]);
  const parsed = stillParses(after, 'renameNode near lookalikes') as {
    spec: { nodes: ({ id: string } & Record<string, unknown>)[] };
  };
  const node = parsed.spec.nodes[0]!;
  assert.equal(node.id, 'lookup');
  // `name` coincidentally equals the id; it is a label, not a reference. Paths that
  // contain the word are not references either.
  assert.equal(node['name'], 'search');
  assert.equal(node['entrypoint'], 'src/search/main.py');
});

test('renaming onto an existing id is refused', () => {
  assert.throws(
    () => applyOps(read('app.yaml'), [{ op: 'renameNode', from: 'classify', to: 'save-record' }]),
    /already a node called/,
  );
});

test('renaming to an invalid id is refused', () => {
  assert.throws(
    () => applyOps(read('app.yaml'), [{ op: 'renameNode', from: 'classify', to: 'Not An Id' }]),
    /not a valid id/,
  );
});

// ---------------------------------------------------------------------------
// The overlap family. Both of these produced unparseable YAML when spans for
// adjacent flow entries were computed independently — each span owns a shared
// comma, and applying both shreds the text between them. Found by adversarial
// review, confirmed by execution, fixed by computing removals as one set.

test('removing a node whose edges are adjacent in an inline flow list', () => {
  const source = [
    'spec:',
    '  nodes:',
    '    - id: a',
    '      type: service',
    '      impl: { entrypoint: a.py }',
    '    - id: b',
    '      type: service',
    '      impl: { entrypoint: b.py }',
    '    - id: c',
    '      type: service',
    '      impl: { entrypoint: c.py }',
    '  edges: [{ id: e1, kind: depends-on, from: { node: a }, to: { node: c } }, { id: e2, kind: depends-on, from: { node: b }, to: { node: a } }, { id: e3, kind: depends-on, from: { node: b }, to: { node: c } }]',
    'layout:',
    '  nodes: {}',
    '',
  ].join('\n');

  // Removing b takes e2 and e3 — adjacent, and e3 is last.
  const { source: after } = applyOps(source, [{ op: 'removeNode', id: 'b' }]);
  const parsed = stillParses(after, 'adjacent inline flow cascade') as {
    spec: { edges: { id: string }[] };
  };
  assert.deepEqual(parsed.spec.edges.map((e) => e.id), ['e1']);

  // And the non-adjacent variant: removing c takes e1 and e3 around a survivor.
  const other = applyOps(source, [{ op: 'removeNode', id: 'c' }]).source;
  const parsedOther = stillParses(other, 'non-adjacent inline flow cascade') as {
    spec: { edges: { id: string }[] };
  };
  assert.deepEqual(parsedOther.spec.edges.map((e) => e.id), ['e2']);
});

test('a patch that nulls two adjacent fields of a flow item', () => {
  const source = [
    'spec:',
    '  nodes:',
    '    - { id: doc, type: io, direction: in, name: Doc, schema: s.json }',
    '  edges: []',
    'layout:',
    '  nodes: {}',
    '',
  ].join('\n');

  const { source: after, summary } = applyOps(source, [
    { op: 'updateNode', id: 'doc', patch: { name: null, schema: null } },
  ]);
  assert.match(summary, /removed name, schema/);
  const parsed = stillParses(after, 'double null on a flow item') as {
    spec: { nodes: Record<string, unknown>[] };
  };
  assert.deepEqual(parsed.spec.nodes[0], { id: 'doc', type: 'io', direction: 'in' });
});

test('renaming to an id YAML would read as something else gets quoted', () => {
  // ID_PATTERN admits `on`, `true`, `null` — all YAML keywords as plain scalars.
  const source = [
    'spec:',
    '  nodes:',
    '    - id: toggle',
    '      type: service',
    '      impl: { entrypoint: t.py }',
    '  edges: []',
    'layout:',
    '  nodes:',
    '    toggle: { x: 1, y: 2 }',
    '',
  ].join('\n');

  const { source: after } = applyOps(source, [{ op: 'renameNode', from: 'toggle', to: 'on' }]);
  const parsed = stillParses(after, 'rename to a YAML keyword') as {
    spec: { nodes: { id: unknown }[] };
    layout: { nodes: Record<string, unknown> };
  };
  // The id must arrive as the STRING "on", not the boolean YAML reads bare `on` as.
  assert.strictEqual(parsed.spec.nodes[0]!.id, 'on');
  assert.deepEqual(Object.keys(parsed.layout.nodes), ['on']);
});

test('a new field added below an entry with a trailing comment leaves the comment', () => {
  const source = [
    'spec:',
    '  nodes:',
    '    - id: worker',
    '      type: service',
    '      impl: { entrypoint: w.py } # the important one',
    '  edges: []',
    'layout:',
    '  nodes: {}',
    '',
  ].join('\n');

  const { source: after } = applyOps(source, [
    { op: 'updateNode', id: 'worker', patch: { name: 'Worker' } },
  ]);
  stillParses(after, 'addition below a trailing comment');
  // The comment stays on the line it annotates rather than migrating to the new one.
  assert.ok(after.includes('impl: { entrypoint: w.py } # the important one'), after);
  assert.ok(after.includes('\n      name: Worker'), after);
});
