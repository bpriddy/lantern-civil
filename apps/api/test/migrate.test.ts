import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planMigration, rewriteCivilRefs } from '../dist/project/migrate.js';

/**
 * The migration's one subtle piece is the ref rewrite: graph refs and the
 * composition path gain the civil/ prefix; code, agents, and io schemas — which do
 * not move — must be left exactly as written.
 */

test('graph refs gain civil/, code/agent/schema refs do not', () => {
  const app = `spec:
  nodes:
    - id: web
      type: client
      path: web
    - id: svc
      type: service
      impl: { graph: graphs/classify.graph.yaml }
    - id: fn
      type: service
      impl: { entrypoint: src/services/save.py }
`;
  const out = rewriteCivilRefs(app, false);
  assert.match(out, /graph: civil\/graphs\/classify\.graph\.yaml/, 'graph ref is prefixed');
  assert.match(out, /entrypoint: src\/services\/save\.py/, 'a code entrypoint is untouched');
  assert.match(out, /path: web/, 'a client path is untouched');
});

test('a graph doc: subgraph ref prefixed, agent ref and schema left alone', () => {
  const graph = `spec:
  nodes:
    - { id: doc, type: io, direction: in, schema: schemas/document.schema.json }
    - { id: cls, type: agent, ref: agents/classifier/agent.yaml }
    - { id: sub, type: subgraph, ref: graphs/enrich.graph.yaml }
    - { id: code, type: code, include: ["src/steps/**/*.py"], entrypoint: src/steps/main.py }
`;
  const out = rewriteCivilRefs(graph, false);
  assert.match(out, /ref: civil\/graphs\/enrich\.graph\.yaml/, 'subgraph ref is prefixed');
  assert.match(out, /ref: agents\/classifier\/agent\.yaml/, 'agent ref is NOT prefixed');
  assert.match(out, /schema: schemas\/document\.schema\.json/, 'io schema is NOT prefixed');
  assert.match(out, /entrypoint: src\/steps\/main\.py/, 'code entrypoint is NOT prefixed');
});

test('the project doc: composition path is prefixed, idempotently', () => {
  const civil = `spec:
  # the top level
  composition: app.yaml
  language: python
`;
  const out = rewriteCivilRefs(civil, true);
  assert.match(out, /composition: civil\/app\.yaml/, 'composition is prefixed');
  // Running it again does not double-prefix.
  assert.equal(rewriteCivilRefs(out, true), out, 'rewrite is idempotent on an already-migrated doc');
});

test('comments and quoting survive the rewrite', () => {
  const doc = `spec:
  nodes:
    - id: svc
      # points at the classify graph
      impl: { graph: "graphs/classify.graph.yaml" }
`;
  const out = rewriteCivilRefs(doc, false);
  assert.match(out, /# points at the classify graph/, 'a comment survives');
  assert.match(out, /graph: "civil\/graphs\/classify\.graph\.yaml"/, 'a quoted value is prefixed inside the quotes');
});

test('planMigration is null when already migrated or not a civil project', () => {
  const migrated = { exists: (p: string) => p === 'civil/civil.yaml', list: () => [], read: () => undefined } as never;
  assert.equal(planMigration(migrated), null, 'already migrated -> null');
  const notCivil = { exists: () => false, list: () => [], read: () => undefined } as never;
  assert.equal(planMigration(notCivil), null, 'no civil.yaml -> null');
});
