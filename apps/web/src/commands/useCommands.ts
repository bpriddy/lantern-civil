import { useCallback, useEffect, useRef, useState } from 'react';
import type { Effect } from './Toast.js';
import {
  formatChord,
  resolve,
  type Command,
  type CommandContext,
  type CommandId,
  type CommandOutcome,
} from './registry.js';

/**
 * Binds the keyboard to the command registry, and reports what ran.
 *
 * Handlers are supplied by the shell rather than living in the registry, because the
 * registry is a description of what Civil can do and the shell is what can currently
 * do it. Keeping them apart is what lets an agent read the catalogue without dragging
 * React state along with it.
 */
export type CommandHandlers = Partial<Record<CommandId, () => CommandOutcome>>;

export function useCommands(context: CommandContext, handlers: CommandHandlers) {
  const [effect, setEffect] = useState<(Effect & { seq: number }) | undefined>(undefined);
  const seq = useRef(0);

  // Held in a ref so the listener is bound once rather than on every state change,
  // which would drop keystrokes during re-render.
  const latest = useRef({ context, handlers });
  latest.current = { context, handlers };

  /** Also the entry point an agent will use, which is why it is not private. */
  const run = useCallback((command: Command, chord?: string) => {
    seq.current += 1;
    const handler = latest.current.handlers[command.id];

    if (!handler) {
      setEffect({
        seq: seq.current,
        title: command.title,
        detail: 'Not available here.',
        refused: true,
        ...(chord ? { chord } : {}),
      });
      return;
    }

    const outcome = handler();
    // Null is "done, and you watched it happen" — the effect is its own feedback,
    // so no toast. Undefined is "declined", which still deserves one: a keystroke
    // that silently does nothing reads as a bug.
    if (outcome === null) return;
    setEffect({
      seq: seq.current,
      title: command.title,
      detail: outcome ?? 'Nothing to do.',
      refused: outcome === undefined,
      ...(chord ? { chord } : {}),
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // `?.` guards against null, not against a target that has no closest at all —
      // and the target is window or document whenever nothing is focused, which is
      // the state the application starts in. Checking for an Element is the actual
      // question being asked.
      const target = event.target instanceof Element ? event.target : null;

      // Typing in a field is typing, not commanding. Monaco is excluded too: it owns
      // its own keymap, and the shell binds Cmd+S inside it separately.
      const typing =
        target !== null &&
        target.closest('input, textarea, [contenteditable="true"], .monaco-editor') !== null;

      const command = resolve(event, latest.current.context);
      if (!command) return;

      // Escape still ascends out of a text field — it is how you leave one.
      const isEscape = event.key === 'Escape';
      if (typing && !isEscape) return;

      event.preventDefault();
      const chord = command.keys.find(() => true);
      run(command, chord ? formatChord(chord) : undefined);
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run]);

  /** For effects with no keystroke behind them — a button, or later an agent. */
  const report = useCallback((next: Effect) => {
    seq.current += 1;
    setEffect({ ...next, seq: seq.current });
  }, []);

  return { effect, run, report };
}
