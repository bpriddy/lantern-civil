/**
 * PRD 7: "Commits are explicit. Edits accumulate as pending changes; the indicator
 * shows a count and a diff preview. Nothing auto-commits."
 *
 * The chip is the count. Clicking it opens the diff panel, which holds the preview
 * and the commit controls — a commit is written while looking at what it commits.
 */
export function CommitBar({
  count,
  note,
  onReview,
  onDismissNote,
}: {
  count: number;
  note: string | null;
  onReview: () => void;
  onDismissNote: () => void;
}) {
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
    <button
      type="button"
      className="chip chip-pending"
      onClick={onReview}
      title="Review every pending change as a diff, then commit"
    >
      <span className="dot warn" />
      {count} pending
    </button>
  );
}
