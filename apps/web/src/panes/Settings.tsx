import { useEffect, useState } from 'react';
import { isAbortError } from '../project.js';
import {
  GITHUB_RESULTS,
  connectGitHub,
  disconnectGitHub,
  fetchConnections,
  signOut,
  type Connection,
  type Me,
} from '../identity.js';

/**
 * The owner asked for GitHub to be a settings step rather than part of signing in.
 * Per-user rather than per-project, so one connection serves every project they own.
 */
export function Settings({ me, onClose }: { me: Me; onClose: () => void }) {
  const [connections, setConnections] = useState<Connection[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchConnections(controller.signal)
      .then(setConnections)
      .catch((error: unknown) => {
        if (!isAbortError(error)) setConnections([]);
      });
    return () => controller.abort();
  }, []);

  const github = connections?.find((c) => c.provider === 'github');
  const result = new URLSearchParams(window.location.search).get('github');
  const resultMessage = result ? (GITHUB_RESULTS[result] ?? null) : null;

  return (
    <>
      <div className="pane-title">
        Settings
        <button type="button" className="link" onClick={onClose}>
          close
        </button>
      </div>
      <div className="pane-body">
        <dl className="kv">
          <dt>account</dt>
          <dd>{me.email}</dd>
          <dt>environment</dt>
          <dd>{me.environment}</dd>
        </dl>

        <h3 className="section">Connections</h3>
        {resultMessage ? <p className="muted">{resultMessage}</p> : null}
        {connections === null ? (
          <p className="muted">Loading…</p>
        ) : github ? (
          <>
            <dl className="kv">
              <dt>github</dt>
              <dd>{github.externalLogin ?? 'linked'}</dd>
              <dt>installation</dt>
              {/* No installation means authorized but the app is not installed
                  anywhere, which is a different problem from not being connected. */}
              <dd>{github.installationId ?? 'none — install the app'}</dd>
            </dl>
            <button type="button" className="connect" onClick={() => void disconnectGitHub().then(() => window.location.reload())}>
              Disconnect
            </button>
          </>
        ) : (
          <>
            <p className="muted">
              Not connected. Civil reads the repositories your projects are projections
              of, and commits back to them.
            </p>
            <button type="button" className="connect" onClick={connectGitHub}>
              Connect GitHub
            </button>
          </>
        )}

        <h3 className="section">Session</h3>
        <button type="button" className="connect" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </>
  );
}
