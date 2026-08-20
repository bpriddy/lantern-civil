import { useEffect } from 'react';

/**
 * Deleting is the one canvas gesture that destroys information, so it is the one
 * that asks first — and the question names everything that goes, including the
 * edges a removed node takes with it, because a surprise inside a confirmation
 * defeats the confirmation.
 *
 * Enter confirms and Escape cancels, captured before the global command listener
 * so neither keystroke leaks into the canvas underneath.
 */
export function ConfirmDelete({
  nodes,
  edges,
  cascades,
  onConfirm,
  onCancel,
}: {
  nodes: string[];
  edges: string[];
  /** Edges not selected themselves, going anyway because their node is. */
  cascades: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Enter') onConfirm();
      else onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onConfirm, onCancel]);

  const what = [
    nodes.length > 0 ? `${nodes.length} node${nodes.length === 1 ? '' : 's'}` : '',
    edges.length > 0 ? `${edges.length} edge${edges.length === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' and ');

  return (
    <div className="keyhelp-backdrop" onClick={onCancel} role="presentation">
      <div className="addnode confirm" onClick={(e) => e.stopPropagation()}>
        <div className="keyhelp-head">
          <span>Delete {what}?</span>
        </div>
        <div className="confirm-body">
          {[...nodes, ...edges].map((id) => (
            <code key={id} className="confirm-id">
              {id}
            </code>
          ))}
          {cascades > 0 ? (
            <p className="muted">
              {cascades === 1 ? 'One connected edge goes' : `${cascades} connected edges go`} with{' '}
              {nodes.length === 1 ? 'it' : 'them'}.
            </p>
          ) : null}
          <p className="muted">Undo brings everything back; nothing commits until you do.</p>
        </div>
        <div className="confirm-actions">
          <button type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="confirm-delete" onClick={onConfirm} autoFocus>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
