import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dissolveAgentRef,
  planAgentDissolution,
  planMigration,
  rewriteCivilRefs,
} from '../dist/project/migrate.js';

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

// ---------------------------------------------------------------------------
// agent.yaml dissolution (docs/emitted-code.md)
// ---------------------------------------------------------------------------

/** A source over a fixed file map — planAgentDissolution only reads list() and read(). */
const source = (files: Record<string, string>) =>
  ({
    list: () => Object.keys(files),
    read: (p: string) => files[p],
    exists: (p: string) => p in files,
    glob: () => [],
  }) as never;

test('dissolveAgentRef replaces a ref with a name, or drops it whole', () => {
  const flow = '    - { id: cls, type: agent, ref: agents/cls/agent.yaml }\n';
  assert.equal(
    dissolveAgentRef(flow, 'agents/cls/agent.yaml', 'Classifier'),
    '    - { id: cls, type: agent, name: Classifier }\n',
  );
  assert.equal(
    dissolveAgentRef(flow, 'agents/cls/agent.yaml', undefined),
    '    - { id: cls, type: agent }\n',
    'no name: the comma-led ref token is removed',
  );

  const block = ['    - id: cls', '      type: agent', '      ref: agents/cls/agent.yaml', ''].join('\n');
  assert.equal(
    dissolveAgentRef(block, 'agents/cls/agent.yaml', 'Classifier'),
    ['    - id: cls', '      type: agent', '      name: Classifier', ''].join('\n'),
  );
  assert.equal(
    dissolveAgentRef(block, 'agents/cls/agent.yaml', undefined),
    ['    - id: cls', '      type: agent', ''].join('\n'),
    'no name: the whole ref line is removed',
  );
});

test('planAgentDissolution moves the prompt, deletes the yaml, and rewrites the node', () => {
  const graph = `apiVersion: civil/v1
kind: Graph
metadata: { id: classify }
spec:
  nodes:
    - { id: normalize, type: code, entrypoint: src/steps/normalize/main.py }
    - { id: classifier, type: agent, ref: agents/classifier/agent.yaml }
  edges: []
layout: { nodes: {} }
`;
  const agentYaml = `apiVersion: civil/v1
kind: Agent
metadata: { id: classifier, name: Classifier }
spec:
  promptFile: agents/classifier/prompt.md
  maxTurns: 8
`;
  const plan = planAgentDissolution(
    source({
      'civil/graphs/classify.graph.yaml': graph,
      'agents/classifier/agent.yaml': agentYaml,
      'agents/classifier/prompt.md': 'Classify the document.\n',
    }),
  )!;

  assert.ok(plan, 'a project with an agent yields a plan');
  assert.deepEqual(plan.moves, [
    {
      from: 'agents/classifier/prompt.md',
      to: 'prompts/classifier.md',
      content: 'Classify the document.\n',
    },
  ]);
  assert.deepEqual(plan.deletes, ['agents/classifier/agent.yaml']);
  assert.deepEqual(plan.warnings, [], 'the default turn budget and absent model raise nothing');
  assert.equal(plan.rewrites.length, 1);
  assert.equal(plan.rewrites[0].from, 'civil/graphs/classify.graph.yaml');
  assert.equal(plan.rewrites[0].to, 'civil/graphs/classify.graph.yaml', 'rewritten in place');
  assert.match(plan.rewrites[0].content, /{ id: classifier, type: agent, name: Classifier }/);
  assert.doesNotMatch(plan.rewrites[0].content, /agent\.yaml/, 'the ref is gone');
  // The code node's entrypoint is untouched.
  assert.match(plan.rewrites[0].content, /entrypoint: src\/steps\/normalize\/main\.py/);
});

test('planAgentDissolution warns about a pinned model and non-default maxTurns', () => {
  const graph = `spec:
  nodes:
    - { id: cls, type: agent, ref: agents/cls/agent.yaml }
`;
  const agentYaml = `metadata: { id: cls }
spec:
  model: claude-opus
  promptFile: agents/cls/prompt.md
  maxTurns: 12
`;
  const plan = planAgentDissolution(
    source({
      'civil/graphs/g.graph.yaml': graph,
      'agents/cls/agent.yaml': agentYaml,
      'agents/cls/prompt.md': 'do it\n',
    }),
  )!;

  assert.equal(plan.warnings.length, 2, 'both the pinned model and the turn budget are surfaced');
  assert.match(plan.warnings.join(' '), /claude-opus/);
  assert.match(plan.warnings.join(' '), /12/);
  // No name anywhere, so the ref is dropped without adding one.
  assert.match(plan.rewrites[0].content, /{ id: cls, type: agent }/);
});

test('planAgentDissolution is null when no agent references a yaml', () => {
  const plan = planAgentDissolution(
    source({
      'civil/graphs/g.graph.yaml': 'spec:\n  nodes:\n    - { id: step, type: code, entrypoint: src/x.py }\n',
    }),
  );
  assert.equal(plan, null);
});

test('civil/ migration then dissolution compose on the same graph (the /migrate sequence)', () => {
  // A legacy project with an agent. The route runs the civil/ move first, then
  // dissolution against that result; this checks both rewrites land on the one graph.
  const legacy: Record<string, string> = {
    'civil.yaml':
      'apiVersion: civil/v1\nkind: Project\nmetadata: { id: p }\nspec: { composition: app.yaml }\n',
    'app.yaml':
      'apiVersion: civil/v1\nkind: Composition\nmetadata: { id: p }\nspec:\n  nodes:\n    - { id: svc, type: service, impl: { graph: graphs/classify.graph.yaml } }\n',
    'graphs/classify.graph.yaml':
      'apiVersion: civil/v1\nkind: Graph\nmetadata: { id: classify }\nspec:\n  nodes:\n    - { id: cls, type: agent, ref: agents/cls/agent.yaml }\n    - { id: sub, type: subgraph, ref: graphs/enrich.graph.yaml }\n',
    'graphs/enrich.graph.yaml':
      'apiVersion: civil/v1\nkind: Graph\nmetadata: { id: enrich }\nspec: { nodes: [] }\n',
    'agents/cls/agent.yaml': 'metadata: { id: cls, name: Classifier }\nspec: { promptFile: agents/cls/prompt.md }\n',
    'agents/cls/prompt.md': 'classify\n',
  };

  // Phase 1 — the civil/ move, applied to build the post-move file map.
  const civilPlan = planMigration(source(legacy))!;
  assert.ok(civilPlan, 'a legacy project migrates');
  const afterMove: Record<string, string> = { ...legacy };
  for (const m of civilPlan.moves) {
    delete afterMove[m.from];
    afterMove[m.to] = m.content;
  }
  const movedGraph = afterMove['civil/graphs/classify.graph.yaml']!;
  assert.match(movedGraph, /ref: civil\/graphs\/enrich\.graph\.yaml/, 'the move prefixes the subgraph ref');
  assert.match(movedGraph, /ref: agents\/cls\/agent\.yaml/, 'the move leaves the agent ref alone');

  // Phase 2 — dissolution on the moved state.
  const agentPlan = planAgentDissolution(source(afterMove))!;
  assert.ok(agentPlan, 'dissolution finds the agent in the moved graph');
  assert.deepEqual(agentPlan.deletes, ['agents/cls/agent.yaml']);
  assert.deepEqual(agentPlan.moves, [
    { from: 'agents/cls/prompt.md', to: 'prompts/cls.md', content: 'classify\n' },
  ]);
  const rw = agentPlan.rewrites.find((r) => r.to === 'civil/graphs/classify.graph.yaml')!;
  assert.ok(rw, 'the moved graph is what gets rewritten');
  assert.match(rw.content, /{ id: cls, type: agent, name: Classifier }/, 'agent ref dropped, name kept');
  assert.match(rw.content, /ref: civil\/graphs\/enrich\.graph\.yaml/, 'the civil/ subgraph ref survives');
  assert.doesNotMatch(rw.content, /agent\.yaml/, 'no agent.yaml ref remains anywhere in the graph');
});
