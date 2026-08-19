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
  | 'canvas.clearSelection'
  | 'file.save'
  | 'project.commit'
  | 'help.keys';

export interface CommandContext {
  /** Where the user is, so a command can refuse when it does not apply. */
  where: 'home' | 'canvas' | 'code';
  hasSelection: boolean;
  pendingCount: number;
  canCommit: boolean;
  depth: number;
}

/** What a command did, in words. Undefined means it declined and nothing happened. */
export type CommandOutcome = string | undefined;

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
    id: 'file.save',
    title: 'Save',
    description: 'Write the open file as a pending change. Nothing is committed.',
    keys: ['mod+s'],
    enabled: (c) => c.where === 'code',
  },
  {
    id: 'project.commit',
    title: 'Commit',
    description: 'Commit every pending change to the repository.',
    keys: ['mod+enter'],
    enabled: (c) => c.pendingCount > 0 && c.canCommit,
  },
  {
    id: 'project.settings',
    title: 'Settings',
    description: 'Show account and connections.',
    keys: ['mod+,'],
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
