import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  ManifestEditError,
  applySplices,
  findItemMap,
  findSequence,
  findSequenceItemById,
  readManifest,
  removeMapEntries,
  removeMapEntry,
  removeSequenceItem,
  removeSequenceItems,
  setMapEntries,
  trimEnd,
  valueStartOfKey,
  type Splice,
} from '../dist/manifest/document.js';

/**
 * document.ts is the layer beneath applyOps: it locates spans in the source and returns
 * splices, and the whole point (PRD 6.5) is that untouched text is never regenerated, so
 * comments, quotes, and layout an edit did not name survive byte for byte. ops.test.ts
 * covers this through applyOps; these tests exercise the exported helpers directly, since
 * that surface — and its ManifestEditError paths — is what a future op is built from.
 */

/** Parse the result of an edit, failing loudly if the edit produced non-YAML. */
function reparse(source: string, what: string): any {
  try {
    return parse(source);
  } catch (error) {
    return assert.fail(`${what} produced unparseable YAML: ${(error as Error).message}`);
  }
}

const MANIFEST = [
  'apiVersion: civil/v1',
  'kind: Composition',
  'metadata:',
  '  id: demo',
  '# nodes below',
  'spec:',
  '  nodes:',
  '    - id: web           # the web client',
  '      type: client',
  '      dev: "npm run dev"',
  '    - id: api',
  '      type: service',
  '      impl: { entrypoint: api.py }',
  '  edges:',
  '    - { id: e1, kind: routes-to, from: { node: web }, to: { node: api } }',
  'layout:',
  '  nodes:',
  "    web: { x: 1, y: 2 }",
  '',
].join('\n');

// ---------------------------------------------------------------------------
// readManifest — the source is kept verbatim alongside the parse.

test('readManifest keeps the exact source and a usable parse', () => {
  const m = readManifest(MANIFEST);
  assert.equal(m.source, MANIFEST, 'the source bytes must be preserved verbatim');
  assert.equal(m.doc.getIn(['metadata', 'id']), 'demo');
  assert.equal(m.doc.getIn(['spec', 'nodes', 0, 'id']), 'web');
});

// ---------------------------------------------------------------------------
// applySplices / trimEnd — the mechanical primitives.

test('applySplices edits back to front, independent of input order', () => {
  const forward: Splice[] = [
    { start: 1, end: 2, text: 'X' },
    { start: 3, end: 4, text: 'Y' },
  ];
  assert.equal(applySplices('abcdef', forward), 'aXcYef');
  // Reversing the input must not change the result: they are ordered internally.
  assert.equal(applySplices('abcdef', [...forward].reverse()), 'aXcYef');
  // A no-op splice set returns the source untouched.
  assert.equal(applySplices('abcdef', []), 'abcdef');
  // Text longer or shorter than the span it replaces both work.
  assert.equal(applySplices('abcdef', [{ start: 2, end: 4, text: 'LONG' }]), 'abLONGef');
});

test('trimEnd finds the last non-whitespace offset and clamps to length', () => {
  assert.equal(trimEnd('abc   ', 6), 3);
  assert.equal(trimEnd('abc', 3), 3);
  assert.equal(trimEnd('abc\n\n  ', 7), 3);
  assert.equal(trimEnd('   ', 3), 0, 'all whitespace trims to zero');
  assert.equal(trimEnd('abc', 100), 3, 'an end past the string is clamped');
});

test('ManifestEditError is a named Error subclass', () => {
  const error = new ManifestEditError('boom');
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ManifestEditError');
  assert.equal(error.message, 'boom');
});

// ---------------------------------------------------------------------------
// findSequence — where and how a new item should be written.

test('findSequence reads a block sequence of flow maps', () => {
  const m = readManifest(MANIFEST);
  const nodes = findSequence(m, ['spec', 'nodes']);
  assert.equal(nodes.count, 2);
  assert.equal(nodes.flow, false, 'nodes are block-style `- id:` items');
  assert.ok(nodes.itemPrefix.includes('\n') && nodes.itemPrefix.trimEnd().endsWith('-'));

  // edges is a block sequence whose single item is a flow map, so `flow` is true even
  // though the prefix still carries a dash. That distinction drives how addEdge renders.
  const edges = findSequence(m, ['spec', 'edges']);
  assert.equal(edges.count, 1);
  assert.equal(edges.flow, true, 'a `- { ... }` item is flow-styled');
  assert.ok(edges.itemPrefix.includes('- '));
});

test('findSequence reads an inline flow sequence, appending with a comma', () => {
  const m = readManifest('spec:\n  edges: [{ id: e1 }, { id: e2 }]\n');
  const edges = findSequence(m, ['spec', 'edges']);
  assert.equal(edges.count, 2);
  assert.equal(edges.flow, true);
  assert.equal(edges.itemPrefix, ', ', 'inline items join the punctuation already there');
  assert.equal(edges.insertAt, edges.replaceTo, 'an append replaces nothing');
});

test('findSequence handles an empty `[]` by covering the brackets', () => {
  const m = readManifest('spec:\n  nodes: []\n');
  const target = findSequence(m, ['spec', 'nodes']);
  assert.equal(target.count, 0);
  assert.equal(target.flow, false, 'an empty sequence defaults to block style');
  assert.ok(target.replaceTo > target.insertAt, 'the `[]` is a span to replace, not an append point');
  assert.ok(target.itemPrefix.includes('- '));
});

test('findSequence refuses a path that is not a sequence', () => {
  const m = readManifest('metadata:\n  id: demo\n');
  assert.throws(() => findSequence(m, ['metadata', 'id']), (error) => {
    assert.ok(error instanceof ManifestEditError);
    assert.match(error.message, /not a sequence/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// findItemMap — locating a specific item for editing.

test('findItemMap returns the mapping for an id, and refuses a missing one', () => {
  const m = readManifest(MANIFEST);
  const api = findItemMap(m, ['spec', 'nodes'], 'api');
  assert.equal(api.get('type'), 'service');
  assert.throws(() => findItemMap(m, ['spec', 'nodes'], 'ghost'), /no item with id "ghost"/);
  assert.throws(() => findItemMap(m, ['metadata', 'id'], 'x'), /not a sequence/);
});

// ---------------------------------------------------------------------------
// valueStartOfKey — where a key's value begins, for rewriting emptied collections.

test('valueStartOfKey points just past the colon of a key', () => {
  const m = readManifest(MANIFEST);
  const at = valueStartOfKey(m, ['metadata', 'id']);
  assert.equal(MANIFEST.slice(at).trimStart().startsWith('demo'), true);
  // It is the value position, not the key's — the key itself precedes it.
  assert.ok(MANIFEST.slice(0, at).endsWith('id:'));
});

test('valueStartOfKey refuses a non-mapping parent and an absent key', () => {
  const m = readManifest(MANIFEST);
  // spec.nodes is a sequence, so it has no keyed value position.
  assert.throws(() => valueStartOfKey(m, ['spec', 'nodes', '0']), /not a mapping/);
  assert.throws(() => valueStartOfKey(m, ['metadata', 'missing']), /has no key in the source/);
});

// ---------------------------------------------------------------------------
// findSequenceItemById / removeSequenceItem — a single removal keeps the rest verbatim.

test('removing one block item leaves its neighbours, comments, and quotes untouched', () => {
  const m = readManifest(MANIFEST);
  const span = findSequenceItemById(m, ['spec', 'nodes'], 'api');
  const after = applySplices(MANIFEST, [{ start: span.start, end: span.end, text: '' }]);

  const parsed = reparse(after, 'removing the api node');
  assert.deepEqual(parsed.spec.nodes.map((n: { id: string }) => n.id), ['web']);
  // The surviving node keeps its trailing comment and its exact quoting.
  assert.ok(after.includes('# the web client'), 'a neighbour comment was lost');
  assert.ok(after.includes('dev: "npm run dev"'), 'a neighbour quote style was rewritten');
  // No orphaned dash is left where the item used to be.
  assert.ok(!/^\s*-\s*$/m.test(after), `a bare dash survived:\n${after}`);

  // removeSequenceItem is the same span wrapped as a ready splice.
  assert.deepEqual(removeSequenceItem(m, ['spec', 'nodes'], 'api'), {
    start: span.start,
    end: span.end,
    text: '',
  });
});

test('findSequenceItemById refuses a missing id and a non-sequence path', () => {
  const m = readManifest(MANIFEST);
  assert.throws(() => findSequenceItemById(m, ['spec', 'nodes'], 'ghost'), /no item with id "ghost"/);
  assert.throws(() => findSequenceItemById(m, ['metadata', 'id'], 'x'), /not a sequence/);
});

// ---------------------------------------------------------------------------
// removeSequenceItems — the plural form that handles the all-items and flow cases.

test('removing every block item rewrites the sequence as [] rather than null', () => {
  const m = readManifest(MANIFEST);
  const splices = removeSequenceItems(m, ['spec', 'nodes'], ['web', 'api']);
  assert.equal(splices.length, 1, 'clearing a whole sequence is one restore splice');
  const after = applySplices(MANIFEST, splices);
  const parsed = reparse(after, 'clearing the nodes sequence');
  assert.deepEqual(parsed.spec.nodes, [], 'an emptied sequence must read as [], not null');
  // The key survives; only its value was replaced.
  assert.ok(/\n  nodes: \[\]/.test(after), `expected \`nodes: []\`:\n${after}`);
});

test('removing adjacent inline flow items merges their spans without shredding', () => {
  const source = [
    'spec:',
    '  edges: [{ id: e1, kind: flow }, { id: e2, kind: flow }, { id: e3, kind: flow }]',
    '',
  ].join('\n');
  const m = readManifest(source);
  const after = applySplices(source, removeSequenceItems(m, ['spec', 'edges'], ['e1', 'e2']));
  const parsed = reparse(after, 'removing two adjacent inline flow items');
  assert.deepEqual(parsed.spec.edges.map((e: { id: string }) => e.id), ['e3']);
  assert.ok(!/\[\s*,/.test(after) && !/,\s*\]/.test(after), `stray comma left behind:\n${after}`);
});

test('removeSequenceItems names the first id it cannot find', () => {
  const m = readManifest(MANIFEST);
  assert.throws(
    () => removeSequenceItems(m, ['spec', 'nodes'], ['web', 'ghost']),
    /no item with id "ghost"/,
  );
});

// ---------------------------------------------------------------------------
// setMapEntries — replacing values in place and appending new keys in style.

test('setMapEntries replaces a value and leaves everything around it alone', () => {
  const m = readManifest(MANIFEST);
  const web = findItemMap(m, ['spec', 'nodes'], 'web');
  const after = applySplices(MANIFEST, setMapEntries(m, web, new Map([['dev', '"npm start"']])));
  const parsed = reparse(after, 'replacing dev');
  assert.equal(parsed.spec.nodes.find((n: { id: string }) => n.id === 'web').dev, 'npm start');
  // Only the value changed: same number of lines, comment intact, api node untouched.
  assert.equal(after.split('\n').length, MANIFEST.split('\n').length);
  assert.ok(after.includes('# the web client'));
  assert.ok(after.includes('impl: { entrypoint: api.py }'));
});

test('setMapEntries appends a new key below a trailing comment, not above it', () => {
  const source = [
    'spec:',
    '  nodes:',
    '    - id: worker',
    '      type: service',
    '      impl: { entrypoint: w.py } # the important one',
    '',
  ].join('\n');
  const m = readManifest(source);
  const worker = findItemMap(m, ['spec', 'nodes'], 'worker');
  const after = applySplices(source, setMapEntries(m, worker, new Map([['name', 'Worker']])));
  reparse(after, 'appending a key below a trailing comment');
  // The comment stays welded to the line it annotated; the new key is its own line.
  assert.ok(after.includes('impl: { entrypoint: w.py } # the important one'), after);
  assert.ok(after.includes('\n      name: Worker'), after);
});

test('setMapEntries adds a new key to a flow mapping inline', () => {
  const source = ['spec:', '  nodes:', '    - { id: doc, type: io }', '  edges: []', ''].join('\n');
  const m = readManifest(source);
  const doc = findItemMap(m, ['spec', 'nodes'], 'doc');
  const after = applySplices(source, setMapEntries(m, doc, new Map([['direction', 'in']])));
  const parsed = reparse(after, 'appending to a flow mapping');
  assert.deepEqual(parsed.spec.nodes[0], { id: 'doc', type: 'io', direction: 'in' });
  assert.ok(after.includes('{ id: doc, type: io, direction: in }'), `not inline:\n${after}`);
});

// ---------------------------------------------------------------------------
// removeMapEntries / removeMapEntry — dropping fields, reporting what was there.

test('removeMapEntries drops a block field and reports it, skipping absent keys', () => {
  const m = readManifest(MANIFEST);
  const web = findItemMap(m, ['spec', 'nodes'], 'web');
  const { splices, removed } = removeMapEntries(m, web, ['dev', 'ghost']);
  assert.deepEqual(removed, ['dev'], 'only keys that were present are reported');
  const after = applySplices(MANIFEST, splices);
  const parsed = reparse(after, 'removing the dev field');
  assert.equal(parsed.spec.nodes.find((n: { id: string }) => n.id === 'web').dev, undefined);
  // Its neighbours on the node stay.
  assert.equal(parsed.spec.nodes.find((n: { id: string }) => n.id === 'web').type, 'client');
});

test('removeMapEntry returns a splice when present and undefined when not', () => {
  const m = readManifest(MANIFEST);
  const web = findItemMap(m, ['spec', 'nodes'], 'web');
  assert.equal(removeMapEntry(m, web, 'ghost'), undefined);
  const splice = removeMapEntry(m, web, 'dev');
  assert.ok(splice && typeof splice.start === 'number' && splice.text === '');
});

test('removeMapEntries merges adjacent flow fields that share a comma', () => {
  const source = ['spec:', '  nodes:', '    - { id: doc, type: io, name: Doc, schema: s.json }', ''].join('\n');
  const m = readManifest(source);
  const doc = findItemMap(m, ['spec', 'nodes'], 'doc');
  const { splices, removed } = removeMapEntries(m, doc, ['name', 'schema']);
  assert.deepEqual(removed, ['name', 'schema']);
  const after = applySplices(source, splices);
  const parsed = reparse(after, 'removing two adjacent flow fields');
  assert.deepEqual(parsed.spec.nodes[0], { id: 'doc', type: 'io' });
  assert.ok(!/,\s*,/.test(after) && !/,\s*\}/.test(after), `stray comma left behind:\n${after}`);
});
