import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MemoryFiles,
  isFatal,
  validateComposition,
  validateGraph,
  validateProject,
} from '../dist/index.js';
import { DiskFiles, EXAMPLE_ROOT, codes, loadYaml } from './helpers.ts';

// ---------------------------------------------------------------------------
// The example project is the exit criterion for M1: it must render at both
// altitudes. Before it can render it has to validate clean.
// ---------------------------------------------------------------------------

test('the example project validates with zero diagnostics', () => {
  const result = validateProject('app.yaml', {
    files: new DiskFiles(EXAMPLE_ROOT),
    loadDoc: loadYaml(EXAMPLE_ROOT),
  });
  assert.deepEqual(result.diagnostics, [], 'example project should be clean');
  assert.deepEqual(result.graphFiles, ['graphs/classify.graph.yaml', 'graphs/enrich.graph.yaml']);
});

// ---------------------------------------------------------------------------
// PRD 6.4, rule by rule.
// ---------------------------------------------------------------------------

const emptyFiles = MemoryFiles.from({});

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

test('ids reject uppercase but admit underscores', () => {
  const bad = validateComposition(
    composition({ nodes: [{ id: 'NotAnId', type: 'process', trigger: { kind: 'schedule', cron: '* * * * *' } }] }),
    'app.yaml',
    emptyFiles,
  );
  assert.equal(bad.doc, undefined);
  assert.deepEqual(codes(bad.diagnostics), ['invalid-manifest']);
  assert.match(bad.diagnostics[0]!.message, /lowercase/);

  // Widened from the PRD's stated pattern so a code node id can match its Python
  // module. See docs/prd-deltas.md.
  const ok = validateComposition(
    composition({ nodes: [{ id: 'search_tools', type: 'process', trigger: { kind: 'schedule', cron: '* * * * *' } }] }),
    'app.yaml',
    emptyFiles,
  );
  assert.deepEqual(ok.diagnostics, []);
});

test('duplicate ids within a canvas are rejected and point at the second one', () => {
  const r = validateGraph(
    graph({
      nodes: [
        { id: 'a', type: 'io', direction: 'in' },
        { id: 'a', type: 'io', direction: 'out' },
      ],
    }),
    'g.yaml',
    emptyFiles,
  );
  assert.deepEqual(codes(r.diagnostics), ['duplicate-id']);
  assert.equal(r.diagnostics[0]!.jsonPointer, '/spec/nodes/1/id');
  assert.equal(r.diagnostics[0]!.nodeId, 'a');
});

test('exposes and calls must name services, and say what they hit instead', () => {
  const r = validateComposition(
    composition({
      nodes: [
        { id: 'api', type: 'boundary', boundary: 'api', exposes: ['other-api', 'ghost'] },
        { id: 'other-api', type: 'boundary', boundary: 'api', exposes: [] },
        { id: 'cron', type: 'process', trigger: { kind: 'schedule', cron: '0 3 * * *' }, calls: ['api'] },
      ],
    }),
    'app.yaml',
    emptyFiles,
  );
  assert.deepEqual(codes(r.diagnostics), ['calls-non-service', 'exposes-non-service', 'exposes-non-service']);
  assert.match(r.diagnostics[0]!.message, /is a boundary, not a service/);
  assert.match(r.diagnostics[1]!.message, /not a node in this composition/);
});

test('a client may not be an edge target at all', () => {
  // Dragging an edge backwards is the likeliest way to point at a consumer, so it
  // gets its own diagnostic whatever the source type is.
  const r = validateComposition(
    composition({
      nodes: [
        { id: 'svc', type: 'service', impl: { entrypoint: 'src/s.py' } },
        { id: 'app', type: 'client', client: 'web', path: 'web' },
      ],
      edges: [{ id: 'e1', kind: 'routes-to', from: { node: 'svc' }, to: { node: 'app' } }],
    }),
    'app.yaml',
    MemoryFiles.from({ 'src/s.py': '', 'web/index.html': '' }),
  );
  assert.deepEqual(codes(r.diagnostics), ['client-is-edge-target']);
  assert.equal(r.diagnostics[0]!.edgeId, 'e1');
});

test('composition edge kinds have different legal endpoints', () => {
  const files = MemoryFiles.from({ 'src/a.py': '', 'src/b.py': '', 'web/index.html': '' });
  const nodes = [
    { id: 'app', type: 'client', client: 'web', path: 'web' },
    { id: 'api', type: 'boundary', boundary: 'api', exposes: ['a'] },
    { id: 'a', type: 'service', impl: { entrypoint: 'src/a.py' } },
    { id: 'b', type: 'service', impl: { entrypoint: 'src/b.py' } },
    { id: 'cron', type: 'process', trigger: { kind: 'schedule', cron: '0 3 * * *' } },
  ];

  // The whole legal route: client -> boundary -> service, and dependencies
  // terminating at services.
  const good = validateComposition(
    composition({
      nodes,
      edges: [
        { id: 'ok1', kind: 'routes-to', from: { node: 'app' }, to: { node: 'api' } },
        { id: 'ok2', kind: 'routes-to', from: { node: 'api' }, to: { node: 'a' } },
        { id: 'ok3', kind: 'depends-on', from: { node: 'a' }, to: { node: 'b' } },
        { id: 'ok4', kind: 'depends-on', from: { node: 'cron' }, to: { node: 'a' } },
      ],
    }),
    'app.yaml',
    files,
  );
  assert.deepEqual(good.diagnostics, []);

  const bad = validateComposition(
    composition({
      nodes,
      edges: [
        // A client skipping the boundary, straight to a service.
        { id: 'x1', kind: 'routes-to', from: { node: 'app' }, to: { node: 'a' } },
        // Traffic originating at a service.
        { id: 'x2', kind: 'routes-to', from: { node: 'a' }, to: { node: 'b' } },
        // Routing into a process.
        { id: 'x3', kind: 'routes-to', from: { node: 'api' }, to: { node: 'cron' } },
        // A boundary depending rather than routing.
        { id: 'x4', kind: 'depends-on', from: { node: 'api' }, to: { node: 'a' } },
        // Depending on something that is not a service.
        { id: 'x5', kind: 'depends-on', from: { node: 'a' }, to: { node: 'cron' } },
      ],
    }),
    'app.yaml',
    files,
  );
  // codes() sorts, so this is the multiset rather than the emission order.
  assert.deepEqual(codes(bad.diagnostics), [
    'edge-kind-bad-source',
    'edge-kind-bad-source',
    'edge-kind-bad-source',
    'edge-kind-bad-target',
    'edge-kind-bad-target',
  ]);
  // And each refusal names the actual rule it broke.
  assert.match(
    bad.diagnostics.find((d) => d.edgeId === 'x1')!.message,
    /through a boundary, not directly/,
  );
  assert.match(
    bad.diagnostics.find((d) => d.edgeId === 'x3')!.message,
    /a process has a trigger, not a caller/,
  );
  assert.match(
    bad.diagnostics.find((d) => d.edgeId === 'x4')!.message,
    /routes to what it reaches/,
  );
});

test('capability edges must run agent → code', () => {
  const r = validateGraph(
    graph({
      nodes: [
        { id: 'in', type: 'io', direction: 'in' },
        { id: 'agent', type: 'agent', ref: 'agents/a/agent.yaml' },
        { id: 'code', type: 'code', include: ['src/**/*.py'] },
      ],
      edges: [
        { id: 'bad1', kind: 'capability', from: { node: 'in' }, to: { node: 'code' } },
        { id: 'bad2', kind: 'capability', from: { node: 'agent' }, to: { node: 'in' } },
      ],
    }),
    'g.yaml',
    MemoryFiles.from({ 'agents/a/agent.yaml': '', 'src/x.py': '' }),
  );
  assert.deepEqual(codes(r.diagnostics), ['capability-edge-bad-source', 'capability-edge-bad-target']);
});

test('a code node on a flow edge must declare an entrypoint, but a capability target need not', () => {
  const files = MemoryFiles.from({ 'agents/a/agent.yaml': '', 'src/tools/t.py': '' });
  const base = {
    nodes: [
      { id: 'in', type: 'io', direction: 'in' },
      { id: 'agent', type: 'agent', ref: 'agents/a/agent.yaml' },
      { id: 'tools', type: 'code', include: ['src/tools/**/*.py'] },
      { id: 'step', type: 'code', include: ['src/tools/**/*.py'] },
    ],
    edges: [
      { id: 'f1', kind: 'flow', from: { node: 'in' }, to: { node: 'step' } },
      { id: 'c1', kind: 'capability', from: { node: 'agent' }, to: { node: 'tools' } },
    ],
  };
  const r = validateGraph(graph(base), 'g.yaml', files);
  assert.deepEqual(codes(r.diagnostics), ['flow-code-node-needs-entrypoint']);
  assert.equal(r.diagnostics[0]!.nodeId, 'step', 'the capability-only node must not be flagged');
});

test('io nodes are directional: inputs are sources, outputs are sinks', () => {
  const r = validateGraph(
    graph({
      nodes: [
        { id: 'in', type: 'io', direction: 'in' },
        { id: 'out', type: 'io', direction: 'out' },
      ],
      edges: [{ id: 'e1', kind: 'flow', from: { node: 'out' }, to: { node: 'in' } }],
    }),
    'g.yaml',
    emptyFiles,
  );
  assert.deepEqual(codes(r.diagnostics), ['io-direction-violation', 'io-direction-violation']);
});

test('a malformed JSON Schema is reported against the io node that references it', () => {
  const r = validateGraph(
    graph({ nodes: [{ id: 'in', type: 'io', direction: 'in', schema: 'schemas/bad.json' }] }),
    'g.yaml',
    MemoryFiles.from({ 'schemas/bad.json': '{ "type": "not-a-type" }' }),
  );
  assert.deepEqual(codes(r.diagnostics), ['invalid-json-schema']);
  assert.equal(r.diagnostics[0]!.nodeId, 'in');
});

// ---------------------------------------------------------------------------
// PRD 6.4 treats the two cycle kinds differently, and that difference is the
// whole point: one is invalid, the other merely un-runnable.
// ---------------------------------------------------------------------------

test('a flow cycle blocks Run but does not fail the save, and names the full path', () => {
  const r = validateGraph(
    graph({
      nodes: [
        { id: 'a', type: 'code', include: ['src/**/*.py'], entrypoint: 'src/a.py' },
        { id: 'b', type: 'code', include: ['src/**/*.py'], entrypoint: 'src/b.py' },
      ],
      edges: [
        { id: 'e1', kind: 'flow', from: { node: 'a' }, to: { node: 'b' } },
        { id: 'e2', kind: 'flow', from: { node: 'b' }, to: { node: 'a' } },
      ],
    }),
    'g.yaml',
    MemoryFiles.from({ 'src/a.py': '', 'src/b.py': '' }),
  );
  assert.deepEqual(codes(r.diagnostics), ['flow-cycle']);
  assert.equal(r.diagnostics[0]!.severity, 'run-blocking');
  assert.ok(r.doc, 'the document still parses, so the save proceeds');
  assert.equal(isFatal(r.diagnostics), false);
  assert.deepEqual(r.diagnostics[0]!.cyclePath, ['a', 'b', 'a']);
});

test('a subgraph containment cycle is fatal and reports the full cycle path', () => {
  const files = MemoryFiles.from({
    'app.yaml': '',
    'graphs/a.graph.yaml': '',
    'graphs/b.graph.yaml': '',
  });
  const docs: Record<string, unknown> = {
    'app.yaml': composition({
      nodes: [{ id: 'svc', type: 'service', impl: { graph: 'graphs/a.graph.yaml' } }],
    }),
    'graphs/a.graph.yaml': graph({
      nodes: [{ id: 'down', type: 'subgraph', ref: 'graphs/b.graph.yaml' }],
    }),
    'graphs/b.graph.yaml': graph({
      nodes: [{ id: 'back', type: 'subgraph', ref: 'graphs/a.graph.yaml' }],
    }),
  };

  const r = validateProject('app.yaml', { files, loadDoc: (p) => docs[p] });
  const cycle = r.diagnostics.find((d) => d.code === 'subgraph-cycle');
  assert.ok(cycle, 'expected a subgraph-cycle diagnostic');
  assert.equal(cycle.severity, 'error');
  assert.deepEqual(cycle.cyclePath, [
    'graphs/a.graph.yaml',
    'graphs/b.graph.yaml',
    'graphs/a.graph.yaml',
  ]);
});

test('unresolved refs are reported per node, not as one blanket failure', () => {
  const r = validateGraph(
    graph({
      nodes: [
        { id: 'agent', type: 'agent', ref: 'agents/missing/agent.yaml' },
        { id: 'sub', type: 'subgraph', ref: 'graphs/missing.graph.yaml' },
        { id: 'step', type: 'code', include: ['src/nothing/**/*.py'], entrypoint: 'src/gone.py' },
      ],
    }),
    'g.yaml',
    emptyFiles,
  );
  assert.deepEqual(codes(r.diagnostics), [
    'unresolved-entrypoint',
    'unresolved-ref',
    'unresolved-ref',
    'unresolved-ref',
  ]);
  assert.deepEqual(
    [...new Set(r.diagnostics.map((d) => d.nodeId))].sort(),
    ['agent', 'step', 'sub'],
  );
});
