import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMMANDS, commandById, resolve, titleOf, type CommandContext } from '../src/commands/registry.ts';

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

test('U is "Generate graph from repo", or "Update" once there is a composition', () => {
  // docs/lift-repo.md: one command, named for what it will do to this project — the
  // first lift generates the documents, every later one merges into them.
  const lift = commandById('project.liftRepo');
  assert.equal(resolve(key('u'), context())?.id, 'project.liftRepo');
  assert.equal(titleOf(lift, context()), 'Generate graph from repo');
  assert.equal(titleOf(lift, context({ hasComposition: true })), 'Update graph from repo');
  // It changes the pending set, so not under the review panel showing it, nor at home.
  assert.equal(resolve(key('u'), context({ where: 'diff' })), undefined);
  assert.equal(resolve(key('u'), context({ where: 'home' })), undefined);
  // Not offered on a project it would refuse (a Python project Civil generates for).
  assert.equal(resolve(key('u'), context({ liftRefused: true })), undefined);
  // And no other command claims U.
  assert.deepEqual(
    COMMANDS.filter((c) => c.keys.includes('u')).map((c) => c.id),
    ['project.liftRepo'],
  );
});
