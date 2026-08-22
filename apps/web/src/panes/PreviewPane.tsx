import { useState } from 'react';
import type { SessionPreview, SessionProcess } from '../project.js';

/**
 * The app, running, inside the IDE (docs/app-session.md): composition Run starts
 * the session and this pane is where it lands — the place the user runs, uses, and
 * tests their application. Locally the iframe points straight at the process's own
 * port; the proxy problem belongs entirely to the deployed adapter.
 */
export type AppSessionState =
  | { phase: 'idle' }
  /** Requested, or found materialising: nothing confirmed running yet. */
  | {
      phase: 'starting';
      previews: SessionPreview[];
      boundaries: SessionPreview[];
      processes: SessionProcess[];
      filesVersion?: number | undefined;
    }
  | {
      phase: 'live';
      previews: SessionPreview[];
      boundaries: SessionPreview[];
      processes: SessionProcess[];
      filesVersion?: number | undefined;
    }
  /** Transpile and session failures land here, in the pane — a toast is too small
   *  a place for a list of validator issues. */
  | { phase: 'error'; message: string };

export function PreviewPane({
  session,
  logsOpen,
  onToggleLogs,
  onStart,
  onStop,
  onClose,
}: {
  session: AppSessionState;
  logsOpen: boolean;
  onToggleLogs: () => void;
  onStart: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const running = session.phase === 'starting' || session.phase === 'live';
  const previews = running ? session.previews : [];
  const boundaries = running ? session.boundaries : [];
  const processes = running ? session.processes : [];

  /** Which client is on screen, when there are several. */
  const [picked, setPicked] = useState<string | undefined>(undefined);
  /** Remounting the iframe is the refresh — a cross-origin frame has no reload API. */
  const [nonce, setNonce] = useState(0);
  const selected = previews.find((p) => p.name === picked) ?? previews[0];

  return (
    <aside className="preview">
      <div className="preview-head">
        <span className="preview-title">App</span>
        {previews.length > 1 ? (
          <select
            className="field preview-pick"
            value={selected?.name ?? ''}
            onChange={(e) => setPicked(e.target.value)}
            title="Which client to preview"
          >
            {previews.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        ) : null}
        <span style={{ flex: 1 }} />
        {selected ? (
          <>
            <button
              type="button"
              className="link"
              onClick={() => setNonce((n) => n + 1)}
              title="Reload the preview"
            >
              refresh
            </button>
            <a className="link" href={selected.url} target="_blank" rel="noreferrer">
              open ↗
            </a>
          </>
        ) : null}
        <button type="button" className="link" onClick={onToggleLogs}>
          {logsOpen ? 'hide logs' : 'logs'}
        </button>
        {running ? (
          <button type="button" className="link preview-stop" onClick={onStop}>
            stop
          </button>
        ) : null}
        <button type="button" className="link" onClick={onClose}>
          close
        </button>
      </div>

      {session.phase === 'error' ? (
        <div className="preview-empty">
          <p className="preview-error">{session.message}</p>
          <button type="button" className="connect" onClick={onStart}>
            Try again
          </button>
        </div>
      ) : session.phase === 'idle' ? (
        <div className="preview-empty">
          <p className="muted">No app session. Run starts one.</p>
          <button type="button" className="connect" onClick={onStart}>
            Run the app
          </button>
        </div>
      ) : session.phase === 'starting' ? (
        <div className="preview-empty">
          <p className="muted">Starting — materialising the workspace, installing, launching…</p>
        </div>
      ) : !selected ? (
        <div className="preview-empty">
          <p className="muted">The session is up, but no client exposes a preview.</p>
          {/* A headless app is still an app: say what IS running, with an address —
              never leave the user to discover it as a 404. */}
          {boundaries.map((b) => (
            <p key={b.name} className="muted">
              boundary <strong>{b.name}</strong> at{' '}
              <a className="link" href={b.url} target="_blank" rel="noreferrer">
                {b.url}
              </a>
            </p>
          ))}
        </div>
      ) : (
        <iframe
          // The url in the key: switching clients remounts too, not just refresh.
          // filesVersion in the key: a write-through remounts the frame, so a save
          // shows up even when the dev server's reload push never reached it.
          key={`${selected.url}#${nonce}#${running ? (session.filesVersion ?? 0) : 0}`}
          className="preview-frame"
          src={selected.url}
          title={`Preview of ${selected.name}`}
        />
      )}

      {processes.length > 0 ? (
        <div className="preview-status">
          {processes.map((proc) => (
            <span
              key={proc.name}
              className="preview-proc"
              title={proc.port !== null ? `port ${proc.port}` : undefined}
            >
              <span
                className={`dot ${
                  proc.running ? 'ok' : proc.exitCode === null || proc.exitCode === 0 ? '' : 'danger'
                }`}
              />
              {proc.name}
              <span className="preview-proc-state">
                {proc.running
                  ? 'running'
                  : proc.exitCode === null
                    ? 'starting'
                    : `exited ${proc.exitCode}`}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </aside>
  );
}
