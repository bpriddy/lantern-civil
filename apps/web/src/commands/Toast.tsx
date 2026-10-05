import { useEffect, useState } from 'react';

/**
 * What just happened, said briefly in the middle of the screen.
 *
 * A keyboard shortcut is invisible by nature: the user pressed something and the
 * application changed, with no click to tie the two together. This closes that loop —
 * the chord that ran, the command it ran, and what it did.
 *
 * The chord is optional on purpose. CLAUDE.md's agent-first rule says effects are
 * reportable, and an effect an agent produced has no chord to show — it uses this
 * same surface with the origin named instead.
 */

export interface Effect {
  /** Rendered as the headline. Absent for effects with no keystroke behind them. */
  chord?: string;
  title: string;
  /** What actually happened, in words. */
  detail?: string;
  /** Set when a command declined, so the toast can say so rather than look successful. */
  refused?: boolean;
  /**
   * Stays until dismissed. For a result the author has to read — a lift's summary of
   * what it found and wrote runs to several sentences, after an operation that took
   * most of a minute, and a toast gone in a second says nothing.
   */
  sticky?: boolean;
}

const VISIBLE_MS = 900;
const FADE_MS = 260;

export function Toast({ effect }: { effect: (Effect & { seq: number }) | undefined }) {
  const [leaving, setLeaving] = useState(false);
  const [shown, setShown] = useState<(Effect & { seq: number }) | undefined>(undefined);

  useEffect(() => {
    if (!effect) return;
    setShown(effect);
    setLeaving(false);
    if (effect.sticky) return;

    // Two timers rather than one so the element stays mounted through its fade;
    // unmounting immediately would cut the animation off.
    const fade = window.setTimeout(() => setLeaving(true), VISIBLE_MS);
    const clear = window.setTimeout(() => setShown(undefined), VISIBLE_MS + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(clear);
    };
    // Keyed on seq so pressing the same key twice replays rather than doing nothing.
  }, [effect?.seq]);

  if (!shown) return null;

  return (
    <div
      className={`toast${leaving ? ' is-leaving' : ''}${shown.refused ? ' is-refused' : ''}${shown.sticky ? ' is-sticky' : ''}`}
      role="status"
    >
      {shown.chord ? <div className="toast-chord">{shown.chord}</div> : null}
      <div className="toast-title">{shown.title}</div>
      {shown.detail ? <div className="toast-detail">{shown.detail}</div> : null}
      {shown.sticky ? (
        <button type="button" className="toast-dismiss" onClick={() => setShown(undefined)} aria-label="Dismiss">
          Dismiss
        </button>
      ) : null}
    </div>
  );
}
