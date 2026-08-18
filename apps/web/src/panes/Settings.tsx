import { useEffect, useState } from 'react';
import { fetchConnections, signOut, type Connection, type Me } from '../identity.js';

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
      .catch(() => setConnections([]));
    return () => controller.abort();
  }, []);

  const github = connections?.find((c) => c.provider === 'github');

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
        {connections === null ? (
          <p className="muted">Loading…</p>
        ) : github ? (
          <p className="muted">
            GitHub connected{github.externalLogin ? ` as ${github.externalLogin}` : ''}.
          </p>
        ) : (
          <>
            <p className="muted">
              Not connected. Civil needs GitHub to clone the repositories your projects
              are projections of.
            </p>
            <button type="button" className="connect" disabled title="Arrives with the App installation">
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
