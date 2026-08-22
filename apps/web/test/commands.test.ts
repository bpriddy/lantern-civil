import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandById, resolve, type CommandContext } from '../src/commands/registry.ts';

/**
 * docs/app-session.md: Run is one gesture whose meaning follows the altitude — the
 * same chord starts a graph run on a graph canvas and the app session on the
 * composition. These pin the dispatch, because a mistake here runs the wrong thing,
 * or silently nothing.
 */

const context = (over: Partial<CommandContext> = {}): CommandContext => ({
  where: 'canvas',
  hasSelection: false,
  pendingCount: 0,
  canCommit: false,
  canUndo: false,
  canRun: false,
  runActive: false,
  canSession: false,
  sessionActive: false,
  depth: 0,
  ...over,
});

/** Just enough of a KeyboardEvent for `matches` to interrogate. */
const key = (k: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

const shiftEnter = () => key('Enter', { shiftKey: true });
const shiftEscape = () => key('Escape', { shiftKey: true });

test('shift+enter on a runnable graph is the graph run', () => {
  assert.equal(resolve(shiftEnter(), context({ canRun: true }))?.id, 'run.start');
});

test('shift+enter on the composition is the app session', () => {
  assert.equal(resolve(shiftEnter(), context({ canSession: true }))?.id, 'session.start');
});

test('the shared chord never has two meanings at once', () => {
  // The enabled sets are disjoint by construction (canRun is graph-altitude, canSession
  // is composition-altitude); a context claiming neither resolves to nothing.
  assert.equal(resolve(shiftEnter(), context()), undefined);
  // And the reuse is literal — one chord, looked up rather than retyped.
  assert.deepEqual(commandById('session.start').keys, commandById('run.start').keys);
});

test('shift+escape prefers cancelling the run over stopping the session', () => {
  // A graph run is a moment and the session is an era: while both are live, the
  // chord addresses the moment. Registry order is the tiebreak, so this pins it.
  assert.equal(
    resolve(shiftEscape(), context({ runActive: true, sessionActive: true }))?.id,
    'run.cancel',
  );
  assert.equal(resolve(shiftEscape(), context({ sessionActive: true }))?.id, 'session.stop');
});
