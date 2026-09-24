import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register } from 'node:module';
import { MarkerType } from '@xyflow/react';

/**
 * graphToFlow (PRD 5) turns a dataflow manifest plus the bundle context into what
 * React Flow draws. Getting a node's kind, face, descent, or an edge's relation wrong
 * makes the canvas draw something the manifest does not say — the same failure mode
 * edges.test.ts guards on the write side, guarded here on the read side.
 *
 * Resolution note: unlike edges.ts / routes.ts / registry.ts (which the other web
 * tests cover) model.ts imports a runtime value from `../project.js`. The source is
 * written for the built world where that path is a real .js file; on disk it is
 * project.ts, and `node --test` does no build, so its ESM resolver cannot find it.
 * This hook rewrites a relative `.js` specifier to the sibling `.ts` when one exists —
 * scoped to relative paths, so bare packages (@xyflow/react, node:*) are untouched —
 * and must be registered before model.ts is imported, which is why the import below is
 * dynamic rather than static. See the report accompanying these tests.
 */
register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      export async function resolve(specifier, context, nextResolve) {
        if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
          const tsSpec = specifier.slice(0, -3) + '.ts';
          try {
            const url = new URL(tsSpec, context.parentURL);
            if (existsSync(fileURLToPath(url))) return nextResolve(tsSpec, context);
          } catch {}
        }
        return nextResolve(specifier, context);
      }
    `),
  import.meta.url,
);

const { graphToFlow, compositionToFlow } = await import('../src/canvas/model.ts');

// Fixtures are shaped for what the transform reads (spec, layout) and cast, exactly
// as edges.test.ts does, because the manifests are validated elsewhere.
const graph = (
  nodes: unknown[],
  edges: unknown[] = [],
  layout: Record<string, { x: number; y: number }> = {},
) =>
  ({
    apiVersion: 'civil/v1',
    kind: 'Graph',
    metadata: { name: 'g' },
    spec: { nodes, edges },
    layout: { nodes: layout },
  }) as never;

const composition = (
  nodes: unknown[],
  edges: unknown[] = [],
  layout: Record<string, { x: number; y: number }> = {},
) =>
  ({
    apiVersion: 'civil/v1',
    kind: 'Composition',
    metadata: { name: 'c' },
    spec: { nodes, edges },
    layout: { nodes: layout },
  }) as never;

const context = (over: Record<string, unknown> = {}) =>
  ({ graphs: {}, agents: {}, files: [], contracts: {}, ...over }) as never;

const byId = <T extends { id: string }>(items: T[]): Record<string, T> =>
  Object.fromEntries(items.map((n) => [n.id, n]));

const FILE = 'graphs/main.graph.yaml';

// --- node kinds map to faces (PRD 5) ---------------------------------------

test('each graph node kind carries its type onto the flow node', () => {
  const g = graph([
    { id: 'doc', type: 'io', direction: 'in' },
    { id: 'classifier', type: 'agent' },
    { id: 'normalize', type: 'code', include: [], entrypoint: 'a.py' },
    { id: 'enrich', type: 'subgraph', ref: 'graphs/e.graph.yaml' },
  ]);
  const nodes = byId(graphToFlow(g, FILE, [], context()).nodes);
  assert.equal(nodes.doc!.type, 'io');
  assert.equal(nodes.classifier!.type, 'agent');
  assert.equal(nodes.normalize!.type, 'code');
  assert.equal(nodes.enrich!.type, 'subgraph');
});

test('an io node shows its schema and does not descend', () => {
  const g = graph([
    { id: 'schemad', type: 'io', direction: 'in', schema: 'schemas/doc.json' },
    { id: 'bare', type: 'io', direction: 'out' },
    { id: 'prog', type: 'io', direction: 'out', kind: 'progress' },
  ]);
  const nodes = byId(graphToFlow(g, FILE, [], context()).nodes);
  assert.equal(nodes.schemad!.data.detail, 'schemas/doc.json');
  assert.equal(nodes.bare!.data.detail, 'no schema');
  assert.equal(nodes.prog!.data.detail, 'progress');
  // io is a leaf at the boundary — a canvas or code descent would be a lie.
  assert.equal(nodes.schemad!.data.descent, undefined);
});

test('a code node with an entrypoint is a flow step; without one, a capability target', () => {
  const files = ['steps/normalize.py', 'steps/clean.py', 'tools/search.py', 'README.md'];
  const g = graph([
    { id: 'step', type: 'code', include: ['steps/*.py'], entrypoint: 'steps/normalize.py' },
    { id: 'cap', type: 'code', include: ['tools/*.py'] },
  ]);
  const nodes = byId(graphToFlow(g, FILE, [], context({ files })).nodes);

  // A flow step names its entrypoint; a capability target has none, so it names its glob.
  assert.equal(nodes.step!.data.detail, 'steps/normalize.py');
  assert.equal(nodes.cap!.data.detail, 'tools/*.py');

  assert.equal(nodes.step!.data.descent.into, 'code');
  assert.equal(nodes.step!.data.descent.note, 'step');
  assert.deepEqual(nodes.step!.data.descent.files, ['steps/normalize.py', 'steps/clean.py']);

  assert.equal(nodes.cap!.data.descent.into, 'code');
  assert.equal(nodes.cap!.data.descent.note, 'capability target');
  assert.deepEqual(nodes.cap!.data.descent.files, ['tools/search.py']);
});

test('a subgraph descends into a canvas, previewing the referenced graph as ports', () => {
  const enrich = graph([
    { id: 'seed', type: 'io', direction: 'in', name: 'Seed' },
    { id: 'done', type: 'io', direction: 'out', name: 'Enriched' },
    { id: 'inner', type: 'agent' }, // not an io node, so not a boundary port
  ]);
  const g = graph([{ id: 'enrich', type: 'subgraph', ref: 'graphs/enrich.graph.yaml' }]);
  const node = graphToFlow(g, FILE, [], context({ graphs: { 'graphs/enrich.graph.yaml': enrich } }))
    .nodes[0]!;

  assert.equal(node.data.detail, 'graphs/enrich.graph.yaml');
  assert.equal(node.data.descent.into, 'canvas');
  // PRD 5: inputs left, outputs right, so inputs sort first.
  assert.deepEqual(node.data.descent.ports, [
    { name: 'Seed', direction: 'in' },
    { name: 'Enriched', direction: 'out' },
  ]);
});

// --- the agent face (PRD 7) ------------------------------------------------

const objective =
  'Classify the incoming document into exactly one of the known categories and return its label';

test('an agent resolves its objective from the graph-qualified key', () => {
  const g = graph([{ id: 'classifier', type: 'agent', name: 'Classifier' }]);
  const node = graphToFlow(
    g,
    FILE,
    [],
    context({
      agents: {
        // The key the transform must use.
        [`${FILE}#classifier`]: {
          graphPath: FILE,
          id: 'classifier',
          promptPath: 'prompts/classifier.md',
          prompt: `\n   \n${objective}\nA distracting second line that must not appear.`,
        },
        // Decoys: a node id is unique only within its graph, so an unqualified key or a
        // different graph's key must not win.
        classifier: { graphPath: FILE, id: 'classifier', promptPath: 'x', prompt: 'WRONG unqualified' },
        'other.graph.yaml#classifier': {
          graphPath: 'other.graph.yaml',
          id: 'classifier',
          promptPath: 'x',
          prompt: 'WRONG other graph',
        },
      },
    }),
  ).nodes[0]!;

  // The name is the face's label; the objective is the first non-empty prompt line,
  // clipped for the semantic-zoom preview.
  assert.equal(node.data.label, 'Classifier');
  assert.equal(node.data.detail, objective.slice(0, 80));
  assert.equal(node.data.detail.length, 80);
  assert.ok(!node.data.detail.includes('distracting'));
  assert.ok(!node.data.detail.includes('WRONG'));
  // An agent is a leaf; it does not descend.
  assert.equal(node.data.descent, undefined);
});

test('an agent with no bundle entry degrades gracefully', () => {
  const g = graph([
    { id: 'named', type: 'agent', name: 'Namer' },
    { id: 'lonely', type: 'agent' },
  ]);
  // Nothing in context.agents for either node.
  assert.doesNotThrow(() => graphToFlow(g, FILE, [], context()));
  const nodes = byId(graphToFlow(g, FILE, [], context()).nodes);

  // The label still resolves — from the node's own name, then its id.
  assert.equal(nodes.named!.data.label, 'Namer');
  assert.equal(nodes.lonely!.data.label, 'lonely');
  // With no prompt to read, the objective is simply absent rather than a crash.
  assert.equal(nodes.named!.data.detail, undefined);
  assert.equal(nodes.lonely!.data.detail, undefined);
});

// --- edges: flow vs capability (PRD 5) -------------------------------------

test('a flow edge is solid and arrowed; a capability edge is dashed and named', () => {
  const g = graph(
    [
      { id: 'doc', type: 'io', direction: 'in' },
      { id: 'agent', type: 'agent' },
      { id: 'tools', type: 'code', include: [] },
    ],
    [
      { id: 'f1', kind: 'flow', from: { node: 'doc' }, to: { node: 'agent' } },
      { id: 'c1', kind: 'capability', from: { node: 'agent' }, to: { node: 'tools', function: 'search' } },
    ],
  );
  const edges = byId(graphToFlow(g, FILE, [], context()).edges);

  const flow = edges.f1!;
  assert.equal(flow.source, 'doc');
  assert.equal(flow.target, 'agent');
  assert.equal(flow.className, 'edge-flow');
  assert.equal((flow.markerEnd as { type: MarkerType }).type, MarkerType.ArrowClosed);
  assert.equal(flow.style, undefined); // solid: no dash
  assert.equal(flow.label, undefined); // no function named

  const cap = edges.c1!;
  assert.equal(cap.className, 'edge-capability');
  // Capability carries no ordering, so the runner's sort ignores it: dashed, unarrowed.
  assert.equal(cap.markerEnd, undefined);
  assert.deepEqual(cap.style, { strokeDasharray: '4 4' });
  // The edge names the function the agent may call.
  assert.equal(cap.label, 'search');
});

// --- layout (PRD 6.3) ------------------------------------------------------

test('layout positions are applied, and a node without one lands on the fallback diagonal', () => {
  const nodes = [
    { id: 'placed', type: 'io', direction: 'in' },
    { id: 'unplaced', type: 'io', direction: 'out' },
  ];
  const g = graph(nodes, [], { placed: { x: 111, y: 222 } });
  const out = byId(graphToFlow(g, FILE, [], context()).nodes);

  assert.deepEqual(out.placed!.position, { x: 111, y: 222 });
  // Fallback mirrors model.ts: 60 + index*200 across, 60 + (index%3)*120 down.
  const i = nodes.findIndex((n) => n.id === 'unplaced');
  assert.deepEqual(out.unplaced!.position, { x: 60 + i * 200, y: 60 + (i % 3) * 120 });
});

// --- context integration (PRD 7.2) -----------------------------------------

test('contracts resolve by the manifest:node key, and an error surfaces separately', () => {
  const g = graph([
    { id: 'ok', type: 'code', include: [] },
    { id: 'broken', type: 'code', include: [] },
  ]);
  const contracts = {
    [`${FILE}:ok`]: {
      name: 'run',
      description: null,
      isAsync: true,
      inputs: [{ name: 'x', type: 'str', schema: null, required: true }],
      output: { type: 'int', schema: null },
    },
    [`${FILE}:broken`]: { error: 'could not parse signature' },
  };
  const nodes = byId(graphToFlow(g, FILE, [], context({ contracts })).nodes);

  assert.equal(nodes.ok!.data.contract?.name, 'run');
  assert.equal(nodes.ok!.data.contractError, undefined);

  // An error result is not projected as a contract; it is carried as the message the
  // face shows instead of ports.
  assert.equal(nodes.broken!.data.contract, undefined);
  assert.equal(nodes.broken!.data.contractError, 'could not parse signature');
});

test('diagnostics attach only to their own file and node', () => {
  const g = graph([
    { id: 'a', type: 'io', direction: 'in' },
    { id: 'b', type: 'io', direction: 'out' },
  ]);
  const diags = [
    { file: FILE, nodeId: 'a', jsonPointer: '', code: 'flow-cycle', severity: 'run-blocking', message: 'mine' },
    { file: 'graphs/other.graph.yaml', nodeId: 'a', jsonPointer: '', code: 'flow-cycle', severity: 'run-blocking', message: 'other file' },
    { file: FILE, nodeId: 'b', jsonPointer: '', code: 'flow-cycle', severity: 'run-blocking', message: 'for b' },
  ] as never[];
  const nodes = byId(graphToFlow(g, FILE, diags, context()).nodes);
  assert.deepEqual(nodes.a!.data.diagnostics.map((d: { message: string }) => d.message), ['mine']);
  assert.deepEqual(nodes.b!.data.diagnostics.map((d: { message: string }) => d.message), ['for b']);
});

test('a subgraph referencing an unknown graph degrades to an empty interior', () => {
  const g = graph([{ id: 'enrich', type: 'subgraph', ref: 'graphs/missing.graph.yaml' }]);
  const node = graphToFlow(g, FILE, [], context()).nodes[0]!;
  assert.equal(node.data.descent.into, 'canvas');
  assert.deepEqual(node.data.descent.ports, []);
});

test('the transform preserves node and edge counts', () => {
  const g = graph(
    [
      { id: 'doc', type: 'io', direction: 'in' },
      { id: 'out', type: 'io', direction: 'out' },
    ],
    [{ id: 'e', kind: 'flow', from: { node: 'doc' }, to: { node: 'out' } }],
  );
  const { nodes, edges } = graphToFlow(g, FILE, [], context());
  assert.equal(nodes.length, 2);
  assert.equal(edges.length, 1);
});

// --- compositionToFlow (PRD 4), the sibling transform ----------------------

test('a service is one thing at two resolutions: graph descends to canvas, entrypoint to code', () => {
  const inner = graph([{ id: 'seed', type: 'io', direction: 'in', name: 'Seed' }]);
  const c = composition([
    { id: 'svcG', type: 'service', impl: { graph: 'graphs/inner.graph.yaml' } },
    { id: 'svcE', type: 'service', impl: { entrypoint: 'services/x.py' } },
  ]);
  const nodes = byId(
    compositionToFlow(c, 'civil/composition.yaml', [], context({
      graphs: { 'graphs/inner.graph.yaml': inner },
      files: ['services/x.py'],
    })).nodes,
  );

  assert.equal(nodes.svcG!.data.detail, 'graphs/inner.graph.yaml');
  assert.equal(nodes.svcG!.data.descent.into, 'canvas');
  assert.deepEqual(nodes.svcG!.data.descent.ports, [{ name: 'Seed', direction: 'in' }]);

  assert.equal(nodes.svcE!.data.detail, 'services/x.py');
  assert.equal(nodes.svcE!.data.descent.into, 'code');
  assert.equal(nodes.svcE!.data.descent.note, 'entrypoint');
  assert.deepEqual(nodes.svcE!.data.descent.files, ['services/x.py']);
});

test('client, process and boundary faces read their own manifest fields', () => {
  const c = composition([
    { id: 'web', type: 'client', path: 'apps/web' },
    { id: 'nightly', type: 'process', trigger: { kind: 'schedule', cron: '0 3 * * *' } },
    { id: 'api', type: 'boundary', exposes: ['svcG', 'svcE'] },
    { id: 'empty', type: 'boundary', exposes: [] },
  ]);
  const files = ['apps/web/App.tsx', 'apps/web/src/main.tsx', 'services/x.py'];
  const nodes = byId(compositionToFlow(c, 'civil/composition.yaml', [], context({ files })).nodes);

  // A client descends into its own source tree; the ** glob reaches nested files.
  assert.equal(nodes.web!.data.detail, 'apps/web');
  assert.equal(nodes.web!.data.descent.note, 'client');
  assert.deepEqual(nodes.web!.data.descent.files, ['apps/web/App.tsx', 'apps/web/src/main.tsx']);

  // A process is triggered, not entered — it names its schedule and has no descent.
  assert.equal(nodes.nightly!.data.detail, 'cron 0 3 * * *');
  assert.equal(nodes.nightly!.data.descent, undefined);

  // A boundary is generated from what it exposes; nothing behind it to enter.
  assert.equal(nodes.api!.data.detail, 'exposes svcG, svcE');
  assert.equal(nodes.empty!.data.detail, 'exposes nothing');
  assert.equal(nodes.api!.data.descent, undefined);
});

test('composition edges: routes-to is arrowed, depends-on is dashed and labelled', () => {
  const c = composition(
    [
      { id: 'web', type: 'client', path: 'apps/web' },
      { id: 'api', type: 'boundary', exposes: [] },
      { id: 'svc', type: 'service', impl: { entrypoint: 'a.py' } },
    ],
    [
      { id: 'r1', kind: 'routes-to', from: { node: 'web' }, to: { node: 'api' } },
      { id: 'd1', kind: 'depends-on', from: { node: 'svc' }, to: { node: 'api' } },
    ],
  );
  const edges = byId(compositionToFlow(c, 'civil/composition.yaml', [], context()).edges);

  assert.equal(edges.r1!.className, 'edge-routes');
  assert.equal((edges.r1!.markerEnd as { type: MarkerType }).type, MarkerType.ArrowClosed);
  assert.equal(edges.r1!.style, undefined);
  assert.equal(edges.r1!.label, undefined);

  assert.equal(edges.d1!.className, 'edge-depends');
  assert.deepEqual(edges.d1!.style, { strokeDasharray: '2 4' });
  assert.equal(edges.d1!.label, 'depends on');
});
