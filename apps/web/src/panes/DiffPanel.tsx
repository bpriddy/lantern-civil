import { useEffect, useMemo, useState } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { CIVIL_THEME } from '../code/monaco-setup.js';
import { fetchDiff, isAbortError, type DiffFile } from '../project.js';

/**
 * PRD 7: "the indicator shows a count and a diff preview". The count is the chip in
 * the header; this is the preview — every pending change against what HEAD says,
 * with the commit controls beside it, because reading the diff is what a commit
 * message is written from.
 *
 * It is also the constraint CLAUDE.md states as "nothing is applied unpreviewably"
 * made visible: any change an agent makes arrives here as before-and-after text
 * before it can reach the repository.
 */
export function DiffPanel({
  projectId,
  committable,
  committing,
  revision,
  unapplied,
  initialPath,
  onCommit,
  onClose,
}: {
  projectId: string;
  committable: boolean;
  committing: boolean;
  /** Bumped when the pending set changes underneath an open panel (a pre-commit
   *  transpile lands emitted files); the fetch re-runs so the review shows them. */
  revision?: number;
  /** The sketch has changes the generated code does not reflect yet (or an apply
   *  is running): committing now would land documents and code that disagree. */
  unapplied?: boolean;
  /** Open on this file — the source-control panel's per-file diff link. */
  initialPath?: string | undefined;
  onCommit: (message: string) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<DiffFile[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | undefined>(initialPath);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetchDiff(projectId, controller.signal)
      .then(({ files: loaded }) => {
        setFiles(loaded);
        setActive((current) => current ?? loaded[0]?.path);
      })
      .catch((err: unknown) => {
        if (!isAbortError(err)) setError((err as Error).message);
      });
    return () => controller.abort();
  }, [projectId, revision]);

  // The topmost surface owns Escape while it is open. Capture phase, so the global
  // command listener never sees the keystroke and cannot also clear the selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const file = useMemo(() => files?.find((f) => f.path === active), [files, active]);

  const commit = () => {
    if (message.trim() && committable && !committing && !unapplied) {
      onCommit(message.trim());
      setMessage('');
      onClose();
    }
  };

  return (
    <div className="keyhelp-backdrop" onClick={onClose} role="presentation">
      <div className="diff-panel" onClick={(e) => e.stopPropagation()}>
        <header className="diff-head">
          <span className="pane-title" style={{ padding: 0 }}>
            Pending changes
          </span>
          <span className="spacer" />
          {committable ? (
            <>
              <input
                className="commit-message"
                placeholder="Commit message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                }}
              />
              <button
                type="button"
                className="connect"
                disabled={committing || unapplied || !message.trim()}
                title={unapplied ? 'The sketch has changes not yet applied — press Apply changes first' : undefined}
                onClick={commit}
              >
                {committing
                  ? 'Committing…'
                  : unapplied
                    ? 'Apply changes first'
                    : `Commit ${files?.length ?? ''} file${files?.length === 1 ? '' : 's'}`}
              </button>
            </>
          ) : (
            <span className="muted">An example has no repository to commit to.</span>
          )}
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="diff-body">
          <aside className="diff-files">
            {error ? <p className="muted">{error}</p> : null}
            {files?.length === 0 ? <p className="muted">Nothing pending.</p> : null}
            {(files ?? []).map((f) => (
              <button
                key={f.path}
                type="button"
                className={`diff-file${f.path === active ? ' active' : ''}`}
                onClick={() => setActive(f.path)}
              >
                <span className={`diff-kind diff-kind-${f.kind}`}>{f.kind}</span>
                {f.path}
              </button>
            ))}
          </aside>

          <div className="diff-editor">
            {file ? (
              <DiffEditor
                original={file.base ?? ''}
                modified={file.current ?? ''}
                language={languageFor(file.path)}
                theme={CIVIL_THEME}
                options={{
                  readOnly: true,
                  renderSideBySide: false,
                  minimap: { enabled: false },
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  // Both texts arrive together, so the placeholder flash is not worth
                  // animating through.
                  hideUnchangedRegions: { enabled: true },
                }}
              />
            ) : (
              <div className="code-empty">{files === undefined ? 'Loading…' : 'Select a file.'}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function languageFor(path: string): string {
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript';
  return 'plaintext';
}
