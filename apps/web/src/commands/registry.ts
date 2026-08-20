/**
 * Every action Civil can take, named.
 *
 * CLAUDE.md's agent-first rule: the keyboard dispatches into this registry and an
 * agent will dispatch into the same one. An action reachable only by clicking a
 * particular button is invisible to an agent, so actions live here and buttons call
 * into them rather than the other way round.
 *
 * A command carries a plain-language description because that is what an agent
 * matches an instruction against, and it returns what it did in words because that
 * string is what the user is shown — by the toast now, by an agent transcript later.
 */

export type CommandId =
  | 'nav.home'
  | 'nav.ascend'
  | 'nav.descend'
  | 'project.switch'
  | 'project.settings'
  | 'canvas.fit'
  | 'node.add'
  | 'canvas.delete'
  | 'edit.undo'
  | 'canvas.clearSelection'
  | 'file.save'
  | 'project.diff'
  | 'project.commit'
  | 'project.sync'
  | 'help.keys';

export interface CommandContext {
  /** Where the user is, so a command can refuse when it does not apply. `diff` is
   *  the review panel: a modal, so canvas commands must not fire underneath it —
   *  mutating the project while its diff is on screen is how a commit message gets
   *  written against a diff that is no longer true. */
  where: 'home' | 'canvas' | 'code' | 'diff';
  hasSelection: boolean;
  pendingCount: number;
  canCommit: boolean;
  /** Whether the op history has anything to walk back. */
  canUndo: boolean;
  depth: number;
}

/**
 * What a command did, in words. Undefined means it declined and nothing happened —
 * which is worth a toast, because a keystroke that silently does nothing reads as a
 * bug. Null means it acted and the effect speaks for itself on screen — deleting the
 * selected node is watched happening, so no toast repeats it.
 */
export type CommandOutcome = string | null | undefined;

export interface Command {
  id: CommandId;
  title: string;
  /** Plain language, present tense. An agent matches instructions against this. */
  description: string;
  /** Chord in the form used by `matches` below, e.g. "mod+k" or "shift+?". */
  keys: string[];
  /** Whether it applies right now. A command that cannot run is not offered. */
  enabled: (context: CommandContext) => boolean;
}

/**
 * `mod` is Cmd on Apple platforms and Ctrl elsewhere, so a binding is written once.
 */
const isApple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const MOD_LABEL = isApple ? '⌘' : 'Ctrl';

export function formatChord(chord: string): string {
  return chord
    .split('+')
    .map((part) => {
      switch (part) {
        case 'mod': return MOD_LABEL;
        case 'shift': return isApple ? '⇧' : 'Shift';
        case 'alt': return isApple ? '⌥' : 'Alt';
        case 'escape': return 'Esc';
        case 'enter': return '↵';
        default: return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join(isApple ? '' : '+');
}

export function matches(chord: string, event: KeyboardEvent): boolean {
  const parts = chord.split('+');
  const key = parts[parts.length - 1]!;
  const wantMod = parts.includes('mod');
  const wantShift = parts.includes('shift');
  const wantAlt = parts.includes('alt');

  const hasMod = isApple ? event.metaKey : event.ctrlKey;
  if (hasMod !== wantMod) return false;
  if (event.altKey !== wantAlt) return false;
  // Shift is implied by punctuation like `?`, so it is only checked when the binding
  // asks for it — otherwise "shift+/" would never match a keyboard that types ? that way.
  if (wantShift && !event.shiftKey) return false;
  // But for plain letters and digits an unrequested Shift is a different chord:
  // without this, Cmd+Shift+Z — redo everywhere else — ran undo.
  if (!wantShift && event.shiftKey && /^[a-z0-9]$/.test(key)) return false;

  return event.key.toLowerCase() === key.toLowerCase();
}

export const COMMANDS: readonly Command[] = [
  {
    id: 'nav.home',
    title: 'All projects',
    description: 'Leave the current project and show every project you can open.',
    keys: ['mod+shift+o'],
    enabled: (c) => c.where !== 'home',
  },
  {
    id: 'project.switch',
    title: 'Switch project',
    description: 'Open the project picker to change project or open a repository.',
    keys: ['mod+p'],
    enabled: (c) => c.where !== 'home',
  },
  {
    id: 'nav.ascend',
    title: 'Ascend',
    description: 'Leave this context and return to the one that contains it.',
    keys: ['escape'],
    enabled: (c) => c.depth > 0,
  },
  {
    id: 'nav.descend',
    title: 'Descend',
    description: 'Enter the selected node — its canvas if it is a graph, its code if it is code.',
    keys: ['enter'],
    enabled: (c) => c.where === 'canvas' && c.hasSelection,
  },
  {
    id: 'canvas.fit',
    title: 'Fit to view',
    description: 'Frame every node on the current canvas.',
    keys: ['f'],
    enabled: (c) => c.where === 'canvas',
  },
  {
    id: 'canvas.clearSelection',
    title: 'Clear selection',
    description: 'Deselect the current node.',
    keys: ['escape'],
    enabled: (c) => c.where === 'canvas' && c.hasSelection,
  },
  {
    id: 'node.add',
    title: 'Add node',
    description:
      'Add a node to the current canvas. The vocabulary is closed — client, service ' +
      'or process at the top level; agent, io, subgraph or code inside a graph.',
    keys: ['n'],
    enabled: (c) => c.where === 'canvas',
  },
  {
    id: 'canvas.delete',
    title: 'Delete',
    description:
      'Remove the selected node or edge from the canvas. A removed node takes its ' +
      'edges with it — a manifest is never left pointing at a node that is not there.',
    keys: ['backspace', 'delete'],
    enabled: (c) => c.where === 'canvas' && c.hasSelection,
  },
  {
    id: 'edit.undo',
    title: 'Undo',
    description:
      'Walk the last canvas edit back — the file returns to what it said before. ' +
      'Inside a file, Monaco keeps its own undo.',
    keys: ['mod+z'],
    enabled: (c) => c.where === 'canvas' && c.canUndo,
  },
  {
    id: 'file.save',
    title: 'Save',
    description: 'Write the open file as a pending change. Nothing is committed.',
    keys: ['mod+s'],
    enabled: (c) => c.where === 'code',
  },
  {
    id: 'project.diff',
    title: 'Review changes',
    description:
      'Show every pending change as a diff against the repository, before anything ' +
      'is committed.',
    keys: ['mod+d'],
    enabled: (c) => c.where !== 'home' && c.pendingCount > 0,
  },
  {
    id: 'project.commit',
    title: 'Commit',
    description: 'Commit every pending change to the repository.',
    keys: ['mod+enter'],
    enabled: (c) => c.pendingCount > 0 && c.canCommit,
  },
  {
    id: 'project.sync',
    title: 'Sync',
    description:
      'Pick up commits pushed to the repository since this project was opened. Civil ' +
      'edits against a fixed commit, so it does not follow the branch on its own.',
    // Not mod+r: the browser owns that one — it is how the page reloads, and no
    // amount of preventDefault reliably wins it back. Plain R matches the other
    // single-key canvas verbs (N adds, F fits).
    keys: ['r'],
    enabled: (c) => c.where !== 'home' && c.canCommit,
  },
  {
    id: 'project.settings',
    title: 'Settings',
    description: 'Show account and connections.',
    // Not mod+comma — that is the browser's own settings on macOS. One key to the
    // right, no collision.
    keys: ['mod+.'],
    enabled: (c) => c.where !== 'home',
  },
  {
    id: 'help.keys',
    title: 'Keyboard shortcuts',
    description: 'List every shortcut and what it does.',
    // Both spellings: `?` is what most layouts report, `shift+/` is what some
    // report and what synthetic events often send.
    keys: ['shift+?', 'shift+/'],
    enabled: () => true,
  },
];

export const commandById = (id: CommandId): Command =>
  COMMANDS.find((c) => c.id === id)!;

/** The command a key event should run, or undefined. */
export function resolve(event: KeyboardEvent, context: CommandContext): Command | undefined {
  return COMMANDS.find(
    (command) => command.enabled(context) && command.keys.some((chord) => matches(chord, event)),
  );
}
