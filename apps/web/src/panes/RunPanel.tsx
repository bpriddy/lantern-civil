import { useEffect, useState } from 'react';

/**
 * What Run asks before it runs: the input. JSON, because that is what crosses the
 * boundary (PRD 9.2); remembered per graph, because the second run is usually the
 * first run again.
 */
export function RunPanel({
  projectId,
  graphPath,
  onRun,
  onClose,
}: {
  projectId: string;
  graphPath: string;
  onRun: (input: unknown) => void;
  onClose: () => void;
}) {
  const memory = `civil.runInput.${projectId}.${graphPath}`;
  const [text, setText] = useState(() => localStorage.getItem(memory) ?? '{}');
  const [complaint, setComplaint] = useState<string | null>(null);

  const run = () => {
    let input: unknown;
    try {
      input = text.trim() === '' ? null : JSON.parse(text);
    } catch (error) {
      setComplaint(`Not JSON: ${(error as Error).message}`);
      return;
    }
    localStorage.setItem(memory, text);
    onRun(input);
    onClose();
  };

  // The topmost surface owns its keys. Cmd+Enter runs; Escape closes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.stopPropagation();
        run();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <div className="keyhelp-backdrop" onClick={onClose} role="presentation">
      <div className="addnode runpanel" onClick={(e) => e.stopPropagation()}>
        <div className="keyhelp-head">
          <span>Run {graphPath}</span>
          <button type="button" className="link" onClick={onClose}>
            close
          </button>
        </div>
        <div className="runpanel-body">
          <textarea
            className="runpanel-input"
            value={text}
            autoFocus
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setComplaint(null);
            }}
          />
          {complaint ? <p className="runpanel-complaint">{complaint}</p> : null}
        </div>
        <div className="confirm-actions">
          <span className="muted">⌘↵ runs</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="run" onClick={run}>
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
