import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confidenceSentence,
  liftAnalysisNote,
  liftProgressFraction,
  liftProgressText,
  parseEvidence,
  voicesSentence,
} from '../src/lift.ts';
import type { LiftAnalysis, LiftRunProgress } from '../src/project.ts';

/**
 * Reading the repository, in words (src/lift.ts). These strings are what the author
 * sees in Source control, the toast and the inspector — and what an agent transcript
 * will repeat — so they are pinned here rather than trusted to a component.
 */

const progress = (over: Partial<LiftRunProgress>): LiftRunProgress => ({
  runId: 'r1',
  state: 'running',
  stage: 'reading',
  detail: '',
  areasTotal: null,
  areasDone: null,
  updatedAt: '2026-10-11T00:00:00Z',
  ...over,
});

// --- progress --------------------------------------------------------------

test('before the first progress, the lift is starting', () => {
  assert.equal(liftProgressText(null), 'Starting to read the repository…');
  assert.equal(liftProgressFraction(null), null);
});

test('each stage is said in words', () => {
  assert.equal(liftProgressText(progress({ stage: 'listing' })), 'Listing the repository');
  assert.equal(liftProgressText(progress({ stage: 'reading' })), 'Reading the code');
  assert.equal(liftProgressText(progress({ stage: 'writing' })), 'Writing the civil/ documents');
});

test('analysing counts the areas when their number is known', () => {
  const p = progress({ stage: 'analysing', areasTotal: 12, areasDone: 5 });
  assert.equal(liftProgressText(p), 'Analysts are reading it area by area — analysing 5 of 12 areas');
  assert.equal(liftProgressFraction(p), 5 / 12);
});

test('analysing without a known total says the stage and draws no bar', () => {
  const p = progress({ stage: 'analysing', areasTotal: null, areasDone: null });
  assert.equal(liftProgressText(p), 'Analysts are reading it area by area');
  assert.equal(liftProgressFraction(p), null);
});

test('one area is one area, and a count past the total is held to it', () => {
  assert.equal(
    liftProgressText(progress({ stage: 'analysing', areasTotal: 1, areasDone: 0 })),
    'Analysts are reading it area by area — analysing 0 of 1 area',
  );
  assert.equal(liftProgressFraction(progress({ stage: 'analysing', areasTotal: 4, areasDone: 9 })), 1);
});

test('past the analysts, the bar is full', () => {
  assert.equal(liftProgressFraction(progress({ stage: 'refining', areasTotal: 12, areasDone: 11 })), 1);
});

// --- the result note -------------------------------------------------------

const analysis = (over: Partial<LiftAnalysis>): LiftAnalysis => ({
  areas: 12,
  claims: 136,
  analystClaims: 100,
  verifierClaims: 36,
  issues: [],
  note: null,
  disbelieved: [],
  ...over,
});

test('no analysis, no line', () => {
  assert.equal(liftAnalysisNote(undefined), null);
});

test('areas read against areas reused, and claims not believed', () => {
  assert.equal(
    liftAnalysisNote(analysis({ cachedAreas: 9, disbelieved: ['a', 'b', 'c'] })),
    '12 areas read, 9 unchanged since the last read; 3 of 136 claims not believed.',
  );
});

test('nothing reused and everything believed is said plainly', () => {
  assert.equal(liftAnalysisNote(analysis({ cachedAreas: 0 })), '12 areas read; all 136 claims believed.');
});

test("the stage's own note follows", () => {
  assert.equal(
    liftAnalysisNote(analysis({ areas: 0, claims: 0, note: 'The runner was not reachable.' })),
    'The runner was not reachable.',
  );
});

// --- confidence and voices -------------------------------------------------

test('each confidence has its sentence', () => {
  assert.equal(confidenceSentence('high', ['reader']), 'High confidence — read directly from the code');
  assert.equal(confidenceSentence('medium'), 'Medium — one analyst found it');
  assert.equal(confidenceSentence('low'), 'Low — contested or the evidence was shaky');
});

test('high without the reader is two voices agreeing, not a direct read', () => {
  assert.equal(
    confidenceSentence('high', ['analyst:apps-api', 'verifier:apps-api']),
    'High confidence — independent voices agree',
  );
});

test('voices read as a list of who, reader first', () => {
  assert.equal(
    voicesSentence(['verifier:apps-api', 'reader', 'analyst:apps-api']),
    'the reader, an analyst, and a verifier',
  );
  assert.equal(voicesSentence(['analyst:a', 'analyst:b']), '2 analysts');
  assert.equal(voicesSentence(['reader', 'verifier:x']), 'the reader and a verifier');
  assert.equal(voicesSentence([]), null);
  assert.equal(voicesSentence(undefined), null);
});

// --- evidence --------------------------------------------------------------

test('evidence is a path, or a path and a line', () => {
  assert.deepEqual(parseEvidence('apps/api/src/main.ts:42'), { path: 'apps/api/src/main.ts', line: 42 });
  assert.deepEqual(parseEvidence('apps/api/src/main.ts'), { path: 'apps/api/src/main.ts' });
  assert.deepEqual(parseEvidence('src/a.ts:12-20'), { path: 'src/a.ts', line: 12 });
});

test('a colon that is not a line number stays part of the path', () => {
  assert.deepEqual(parseEvidence('docs/a:b.md'), { path: 'docs/a:b.md' });
  assert.deepEqual(parseEvidence('a:b.ts:7'), { path: 'a:b.ts', line: 7 });
});

test('empty evidence is nothing, and line 0 is no line', () => {
  assert.equal(parseEvidence('  '), null);
  assert.deepEqual(parseEvidence('src/a.ts:0'), { path: 'src/a.ts' });
});
