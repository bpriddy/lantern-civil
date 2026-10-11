import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  READER,
  checkEvidence,
  claimsFromSkeleton,
  reconcile,
  toSkeleton,
} from '../dist/lift/claims.js';

/**
 * The claims layer stands between what readers and analysts say and what the graph
 * draws. Two properties matter most: it is lossless (the reader's own findings pass
 * through unchanged, so nothing downstream moves), and it is skeptical (evidence that
 * does not hold, or a sound refutation, keeps a statement off the canvas).
 */

const lines = (n: number, at: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => at[i + 1] ?? `// line ${i + 1}`).join('\n');

const FILES = {
  'apps/server/src/main.ts': lines(10, { 3: "app.setGlobalPrefix('api');" }),
  'apps/server/src/tasks/tasks.module.ts': lines(20, { 5: '@Module({ controllers: [TasksController] })' }),
  'apps/server/src/notes/notes.module.ts': lines(20, { 4: '@Module({ imports: [TasksModule] })' }),
  'apps/server/src/agents/writer/agent.ts': lines(12, { 2: 'export const writer = new LlmAgent({' }),
  'apps/server/src/testing/model-fake.ts': lines(8, { 1: '// A fake model client for tests.' }),
  'apps/web/vite.config.ts': lines(5),
};

const SKELETON = {
  clients: [
    { id: 'web', path: 'apps/web', framework: 'vite', devScript: 'vite', calls: ['server'], source: { file: 'apps/web/vite.config.ts' } },
  ],
  servers: [
    {
      id: 'server', path: 'apps/server', framework: 'nestjs', globalPrefix: 'api',
      routes: [{ method: 'GET', path: '/api/tasks', controller: 'TasksController', handler: 'list', source: { file: 'apps/server/src/tasks/tasks.module.ts', line: 5 } }],
      exposes: ['tasks', 'notes'], source: { file: 'apps/server/src/main.ts', line: 3 },
    },
  ],
  services: [
    {
      id: 'tasks', server: 'server', moduleClass: 'TasksModule', source: { file: 'apps/server/src/tasks/tasks.module.ts', line: 5 },
      controllers: [], providers: [], dependsOn: [], agents: ['writer'], infrastructure: false,
    },
    {
      id: 'notes', server: 'server', moduleClass: 'NotesModule', source: { file: 'apps/server/src/notes/notes.module.ts', line: 4 },
      controllers: [], providers: [], dependsOn: ['tasks'], agents: [], infrastructure: false,
    },
  ],
  agents: [
    { id: 'writer', files: ['apps/server/src/agents/writer/agent.ts'], tools: [], source: { file: 'apps/server/src/agents/writer/agent.ts', line: 2 } },
    { id: 'model-fake', files: ['apps/server/src/testing/model-fake.ts'], tools: [], source: { file: 'apps/server/src/testing/model-fake.ts', line: 1 } },
  ],
  processes: [],
  unresolved: [{ file: 'apps/server/src/x.ts', reason: 'computed' }],
  frameworks: ['nestjs', 'vite'],
};

test('the reader\'s findings pass through the claims layer unchanged', () => {
  const claims = claimsFromSkeleton(SKELETON as never);
  const { skeleton, dropped } = toSkeleton(reconcile(claims, FILES), SKELETON as never);
  assert.deepEqual(skeleton, SKELETON, 'round trip is lossless — the mapper sees exactly what it saw before');
  assert.deepEqual(dropped, []);
});

test('everything the reader supports with sound evidence is high confidence', () => {
  const { provenance } = toSkeleton(reconcile(claimsFromSkeleton(SKELETON as never), FILES), SKELETON as never);
  assert.equal(provenance['tasks']!.confidence, 'high');
  assert.deepEqual(provenance['tasks']!.supporters, [READER]);
  assert.deepEqual(provenance['tasks']!.evidence, [{ file: 'apps/server/src/tasks/tasks.module.ts', line: 5 }]);
});

test('evidence is checked mechanically: file, line, and quote near the line', () => {
  const claim = (evidence: unknown[]) => ({ kind: 'service', subject: 's', evidence, by: 'analyst:x', stance: 'assert' }) as never;
  assert.deepEqual(checkEvidence(claim([{ file: 'apps/server/src/main.ts', line: 3, quote: "setGlobalPrefix('api')" }]), FILES), []);
  assert.match(checkEvidence(claim([{ file: 'nope.ts' }]), FILES)[0]!, /not in the repository/);
  assert.match(checkEvidence(claim([{ file: 'apps/server/src/main.ts', line: 99 }]), FILES)[0]!, /no line 99/);
  assert.match(
    checkEvidence(claim([{ file: 'apps/server/src/main.ts', line: 9, quote: 'setGlobalPrefix' }]), FILES)[0]!,
    /does not contain/,
    'a quote must appear near its line, not merely somewhere in the file',
  );
  assert.match(checkEvidence(claim([]), FILES)[0]!, /no evidence/);
  // Listed but unread (past the reader's cap) is unverifiable, not wrong.
  assert.deepEqual(checkEvidence(claim([{ file: 'big.ts' }]), FILES, new Set(['big.ts'])), []);
});

test('a sound refutation keeps even a reader finding off the canvas', () => {
  const refute = {
    kind: 'agent', subject: 'model-fake', by: 'verifier:1', stance: 'refute',
    evidence: [{ file: 'apps/server/src/testing/model-fake.ts', line: 1, quote: 'A fake model client for tests' }],
    note: 'A test double, not a product agent.',
  };
  const beliefs = reconcile([...claimsFromSkeleton(SKELETON as never), refute as never], FILES);
  const { skeleton, dropped } = toSkeleton(beliefs, SKELETON as never);
  assert.ok(!skeleton.agents.some((a: { id: string }) => a.id === 'model-fake'));
  assert.deepEqual(dropped.map((b: { key: string }) => b.key), ['agent:model-fake']);
});

test('a refutation that cites nothing does not outweigh code read exactly', () => {
  const refute = { kind: 'service', subject: 'notes', by: 'verifier:1', stance: 'refute', evidence: [] };
  const { skeleton, provenance } = toSkeleton(
    reconcile([...claimsFromSkeleton(SKELETON as never), refute as never], FILES),
    SKELETON as never,
  );
  assert.ok(skeleton.services.some((s: { id: string }) => s.id === 'notes'), 'still drawn');
  assert.equal(provenance['notes']!.confidence, 'low', 'but marked as contested');
});

test('an analyst can add what the reader missed; confidence follows the evidence', () => {
  const analyst = (by: string) => ({
    kind: 'process', subject: 'nightly-digest', by, stance: 'assert',
    attrs: { schedule: '0 3 * * *', source: { file: 'apps/server/src/notes/notes.module.ts', line: 4 } },
    evidence: [{ file: 'apps/server/src/notes/notes.module.ts', line: 4, quote: 'TasksModule' }],
    note: 'Runs the digest nightly.',
  });
  const calls = { kind: 'calls', subject: 'nightly-digest', object: 'notes', by: 'analyst:a', stance: 'assert', evidence: [{ file: 'apps/server/src/notes/notes.module.ts', line: 4 }] };

  let out = toSkeleton(reconcile([...claimsFromSkeleton(SKELETON as never), analyst('analyst:a') as never, calls as never], FILES), SKELETON as never);
  assert.deepEqual(out.skeleton.processes.map((p: { id: string; calls: string[] }) => [p.id, p.calls]), [['nightly-digest', ['notes']]]);
  assert.equal(out.provenance['nightly-digest']!.confidence, 'medium', 'one voice');
  assert.deepEqual(out.provenance['nightly-digest']!.notes, ['analyst:a: Runs the digest nightly.']);

  out = toSkeleton(
    reconcile([...claimsFromSkeleton(SKELETON as never), analyst('analyst:a') as never, analyst('analyst:b') as never], FILES),
    SKELETON as never,
  );
  assert.equal(out.provenance['nightly-digest']!.confidence, 'high', 'two independent voices');
});

test('claims whose evidence does not hold, and lines to nothing, are not drawn', () => {
  const invented = { kind: 'service', subject: 'billing', by: 'analyst:a', stance: 'assert', evidence: [{ file: 'apps/server/src/billing.ts' }] };
  const dangling = { kind: 'depends-on', subject: 'notes', object: 'billing', by: 'analyst:a', stance: 'assert', evidence: [{ file: 'apps/server/src/notes/notes.module.ts', line: 4 }] };
  const { skeleton, dropped } = toSkeleton(
    reconcile([...claimsFromSkeleton(SKELETON as never), invented as never, dangling as never], FILES),
    SKELETON as never,
  );
  assert.ok(!skeleton.services.some((s: { id: string }) => s.id === 'billing'));
  assert.deepEqual(skeleton.services.find((s: { id: string }) => s.id === 'notes')!.dependsOn, ['tasks']);
  assert.deepEqual(dropped.map((b: { key: string }) => b.key).sort(), ['depends-on:notes->billing', 'service:billing']);
});
