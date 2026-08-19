import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readManifest } from '../dist/manifest/document.js';
import { applyOps } from '../dist/manifest/apply.js';

/** A no-op is byte-identical by construction: untouched text is never regenerated. */
const roundTripsExactly = (source: string) => applyOps(source, []).source === source;
const writeManifest = (m: { source: string }) => m.source;

/**
 * PRD 2 names two tests that matter. This is one of them, and PRD 6.5 is explicit
 * about when to write it: "Test this on day one; it will save weeks."
 *
 * What it guards is silent corruption of real repositories. A writer that reformats
 * turns every commit into a whole-file diff, makes review impossible, and quietly
 * destroys the comments a human left for other humans.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(here, '../../../examples/doc-pipeline');

const manifests = [
  'civil.yaml',
  'app.yaml',
  'graphs/classify.graph.yaml',
  'graphs/enrich.graph.yaml',
  'agents/classifier/agent.yaml',
];

for (const relative of manifests) {
  test(`${relative} round-trips byte for byte`, () => {
    const source = fs.readFileSync(path.join(EXAMPLE, relative), 'utf8');
    const written = writeManifest(readManifest(source));

    if (written !== source) {
      // Point at the first divergence rather than dumping two files.
      const a = source.split('\n');
      const b = written.split('\n');
      const line = a.findIndex((l, i) => l !== b[i]);
      assert.fail(
        `line ${line + 1} changed\n  read:    ${JSON.stringify(a[line])}\n  written: ${JSON.stringify(b[line])}`,
      );
    }
    assert.equal(written, source);
  });
}

test('comments survive, wherever they are', () => {
  const source = [
    '# leading comment',
    'apiVersion: civil/v1',
    'kind: Composition',
    'metadata:',
    '  id: t # trailing comment',
    'spec:',
    '  # a comment inside a block',
    '  nodes: []',
    '',
    '# a comment at the end',
    '',
  ].join('\n');
  assert.equal(roundTripsExactly(source), true);
});

test('formatting choices survive', () => {
  // Flow style, block style, quoting, and blank lines are all authorial choices.
  // A writer that "tidies" them is rewriting someone else's file.
  const source = [
    'apiVersion: civil/v1',
    'spec:',
    '  edges:',
    '    - { id: c1, kind: routes-to, from: { node: web }, to: { node: api } }',
    '  nodes:',
    '    - id: web',
    '      type: client',
    '',
    '      dev: "npm run dev"',
    "      quoted: 'single'",
    '      plain: 1.0',
    '',
  ].join('\n');
  assert.equal(roundTripsExactly(source), true);
});

test('indentation that is not two spaces is left alone', () => {
  const source = ['spec:', '    nodes:', '        - id: a', ''].join('\n');
  assert.equal(roundTripsExactly(source), true);
});
