import { useState } from 'react';

/**
 * PRD 7: "Commits are explicit. Edits accumulate as pending changes; the indicator
 * shows a count and a diff preview. Nothing auto-commits."
 *
 * The count is the indicator. The message prompt is deliberate friction — a commit
 * that needs a sentence written is one you meant to make.
 */
export function CommitBar({
  count,
  committing,
  note,
  committable,
  onCommit,
  onDismissNote,
}: {
  count: number;
  committing: boolean;
  note: string | null;
  committable: boolean;
  onCommit: (message: string) => void;
  onDismissNote: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');

  if (note) {
    return (
      <button type="button" className="chip chip-note" onClick={onDismissNote} title="Dismiss">
        <span className="dot ok" />
        {note}
      </button>
    );
  }

  if (count === 0) {
    return (
      <span className="chip" title="Edits accumulate as pending changes">
        <span className="dot" />
        no pending changes
      </span>
    );
  }

  return (
    <span className="commit-wrap">
      <button
        type="button"
        className="chip chip-pending"
        onClick={() => setOpen((v) => !v)}
        title={committable ? 'Review and commit' : 'Examples have no repository to commit to'}
      >
        <span className="dot warn" />
        {count} pending
      </button>

      {open ? (
        <div className="commit-popover">
          {committable ? (
            <>
              <input
                autoFocus
                className="commit-message"
                placeholder="Commit message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && message.trim()) {
                    onCommit(message.trim());
                    setMessage('');
                    setOpen(false);
                  }
                }}
              />
              <button
                type="button"
                className="connect"
                disabled={committing || !message.trim()}
                onClick={() => {
                  onCommit(message.trim());
                  setMessage('');
                  setOpen(false);
                }}
              >
                {committing ? 'Committing…' : `Commit ${count} file${count === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <p className="muted">
              This is an example bundled with Civil, so there is no repository to commit
              to. Your edits are kept, and open one of your own repositories to keep them
              for good.
            </p>
          )}
        </div>
      ) : null}
    </span>
  );
}
