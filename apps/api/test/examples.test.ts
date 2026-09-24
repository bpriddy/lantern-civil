import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXAMPLES, findExample, openExample } from '../dist/project/examples.js';

/**
 * Examples are read through the ordinary ProjectSource port so the rest of Civil
 * cannot tell an example from a real project. The list itself is closed and
 * hand-edited (PRD 3's closed vocabulary), so it is small enough to check in full.
 */

test('EXAMPLES is a non-empty, closed list with well-formed definitions', () => {
  assert.ok(EXAMPLES.length > 0, 'at least one example ships');
  for (const example of EXAMPLES) {
    assert.equal(typeof example.slug, 'string');
    assert.ok(example.slug.length > 0);
    assert.equal(typeof example.name, 'string');
    assert.ok(example.name.length > 0);
    assert.equal(typeof example.description, 'string');
    assert.ok(example.description.length > 0);
  }
  const slugs = EXAMPLES.map((e) => e.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'slugs are unique');
});

test('EXAMPLES includes the doc-pipeline worked example', () => {
  const docPipeline = EXAMPLES.find((e) => e.slug === 'doc-pipeline');
  assert.ok(docPipeline, 'doc-pipeline is a shipped example');
  assert.equal(docPipeline!.name, 'Document Pipeline');
});

test('findExample returns the definition for a known slug', () => {
  const found = findExample('doc-pipeline');
  assert.ok(found);
  assert.equal(found!.slug, 'doc-pipeline');
  assert.equal(found!.name, 'Document Pipeline');
});

test('findExample returns undefined for an unknown slug', () => {
  assert.equal(findExample('not-a-real-example'), undefined);
  assert.equal(findExample(''), undefined);
});

test('openExample returns undefined for an unknown slug, without touching disk', () => {
  assert.equal(openExample('not-a-real-example'), undefined);
});

test('openExample returns a real ProjectSource over the shipped doc-pipeline example', () => {
  const source = openExample('doc-pipeline');
  assert.ok(source, 'doc-pipeline resolves to a source');

  // It is read through the same port as any other project: list/exists/read all work.
  assert.equal(source!.exists('civil/civil.yaml'), true);
  assert.equal(source!.exists('civil/app.yaml'), true);
  assert.equal(source!.exists('does/not/exist.py'), false);

  const civilYaml = source!.read('civil/civil.yaml');
  assert.ok(civilYaml, 'civil/civil.yaml is readable');
  assert.match(civilYaml!, /kind: Project/);

  const files = source!.list();
  assert.ok(files.includes('civil/civil.yaml'));
  assert.ok(files.includes('civil/app.yaml'));
  assert.ok(files.includes('src/services/save_record.py'), 'the function-backed service ships with the example');
});

test('openExample is read-only ground truth: the same slug reopens to an equivalent, unmodified source', () => {
  const first = openExample('doc-pipeline')!;
  const second = openExample('doc-pipeline')!;
  assert.deepEqual(first.list(), second.list());
  assert.equal(first.read('civil/civil.yaml'), second.read('civil/civil.yaml'));
});
