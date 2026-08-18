import { useEffect, useState } from 'react';
import {
  SIGN_IN_ERRORS,
  fetchConnections,
  fetchMe,
  signIn,
  signOut,
  type Connection,
  type Me,
  type SessionState,
} from './identity.js';

/**
 * PRD 14 M0: an authenticated shell. The frame is PRD 7's — project tree left, canvas
 * or Monaco centre, inspector right, breadcrumb and branch and Run on top. M1 fills
 * the centre; everything here is inert so the canvas lands in a layout that exists.
 *
 * The sign-in screen is new. IAP used to render one; the owner replaced it with
 * application-owned Google OAuth so the application can be shared.
 */
export function App(): React.ReactElement {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void fetchMe(controller.signal).then(setSession);
    return () => controller.abort();
  }, []);

  switch (session.status) {
    case 'loading':
      return <div className="gate" />;
    case 'signedOut':
      return <SignIn />;
    case 'error':
      return <Unreachable message={session.message} />;
    case 'authenticated':
      return <Shell me={session.me} />;
  }
}

function SignIn() {
  const error = new URLSearchParams(window.location.search).get('error');
  const message = error ? (SIGN_IN_ERRORS[error] ?? 'Sign-in failed. Try again.') : null;

  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Civil</h1>
        <p>A web IDE for building applications at graph altitude.</p>
        {message ? <p className="gate-error">{message}</p> : null}
        <button type="button" onClick={signIn}>
          Continue with Google
        </button>
      </div>
    </div>
  );
}

function Unreachable({ message }: { message: string }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>Cannot reach the API</h1>
        <p>{message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

function Shell({ me }: { me: Me }) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">Civil</span>
        <nav className="breadcrumb" aria-label="Location">
          <span className="here">app</span>
        </nav>
        <span className="spacer" />
        <span className="chip" title="Current branch">
          <span className="dot" />
          main
        </span>
        <span className="chip" title="Pending changes are committed explicitly (PRD 7)">
          <span className="dot" />
          no pending changes
        </span>
        {/* PRD 4: nothing executes at the composition altitude, so Run has no meaning
            here. Disabled rather than hidden, so the rule stays visible. */}
        <button className="run" type="button" disabled title="Run has no meaning on the composition canvas">
          Run
        </button>
        <button className="avatar" type="button" onClick={() => setSettingsOpen((v) => !v)} title={me.email}>
          {me.avatarUrl ? <img src={me.avatarUrl} alt="" /> : (me.email[0] ?? '?').toUpperCase()}
        </button>
      </header>

      <aside className="pane tree">
        <div className="pane-title">Project</div>
        <div className="pane-body">
          <p className="muted">No project open. Cloning and the file tree arrive with M1.</p>
        </div>
      </aside>

      <main className="centre">
        <div className="empty">
          <h2>The canvas lands here</h2>
          <p>
            M0 is the authenticated shell. M1 renders <code>app.yaml</code> as the
            composition canvas and descends into <code>graphs/*.graph.yaml</code>.
          </p>
        </div>
      </main>

      <aside className="pane inspector">
        {settingsOpen ? <Settings me={me} onClose={() => setSettingsOpen(false)} /> : <Inspector me={me} />}
      </aside>
    </div>
  );
}

function Inspector({ me }: { me: Me }) {
  return (
    <>
      <div className="pane-title">Inspector</div>
      <div className="pane-body">
        <p className="muted">Nothing selected.</p>
        <dl className="kv" style={{ marginTop: 16 }}>
          <dt>Signed in</dt>
          <dd>{me.email}</dd>
          <dt>Environment</dt>
          <dd>{me.environment}</dd>
        </dl>
      </div>
    </>
  );
}

/**
 * The owner asked for GitHub to be a settings step rather than part of signing in.
 * Keeping it per-user rather than per-project means one connection serves every
 * project that user owns.
 */
function Settings({ me, onClose }: { me: Me; onClose: () => void }) {
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
          <dt>Account</dt>
          <dd>{me.email}</dd>
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
              GitHub is not connected. Civil needs it to clone the repositories your
              projects are projections of.
            </p>
            <button type="button" className="connect" disabled title="Arrives with M1">
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
