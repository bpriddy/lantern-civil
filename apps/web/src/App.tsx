import { useEffect, useState } from 'react';
import { fetchMe, type SessionState } from './identity.js';

/**
 * PRD 14 M0: an empty authenticated shell. The frame is PRD 7's — project tree left,
 * canvas or Monaco centre, inspector right, breadcrumb and branch and Run on top.
 * M1 fills the centre; everything here is deliberately inert so that when the canvas
 * arrives it lands in a layout that already exists.
 */
export function App(): React.ReactElement {
  const [session, setSession] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void fetchMe(controller.signal).then(setSession);
    return () => controller.abort();
  }, []);

  if (session.status === 'loading') {
    return <div className="gate" />;
  }

  if (session.status !== 'authenticated') {
    return <Gate session={session} />;
  }

  return <Shell me={session.me} />;
}

function Gate({ session }: { session: Extract<SessionState, { status: 'unauthenticated' | 'error' }> }) {
  const unauthenticated = session.status === 'unauthenticated';
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>{unauthenticated ? 'Not signed in' : 'Cannot reach the API'}</h1>
        <p>
          {unauthenticated
            ? // PRD 12 puts auth in IAP, so there is no login form to render here —
              // a reload is genuinely the only remedy the SPA has.
              'Access is granted by Identity-Aware Proxy. Reloading will send you through the Google sign-in flow.'
            : session.message}
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

function Shell({ me }: { me: { email: string; environment: string } }) {
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
            here. Disabled rather than hidden, so the rule is visible. */}
        <button className="run" type="button" disabled title="Run has no meaning on the composition canvas">
          Run
        </button>
      </header>

      <aside className="pane tree">
        <div className="pane-title">Project</div>
        <div className="pane-body">
          <p style={{ color: 'var(--text-faint)', margin: 0, lineHeight: 1.6 }}>
            No project open. Cloning and the file tree arrive with M1.
          </p>
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
        <div className="pane-title">Inspector</div>
        <div className="pane-body">
          <dl className="kv">
            <dt>Signed in</dt>
            <dd>{me.email}</dd>
            <dt>Environment</dt>
            <dd>{me.environment}</dd>
          </dl>
        </div>
      </aside>
    </div>
  );
}
