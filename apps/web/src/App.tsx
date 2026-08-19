import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Editor, type Altitude } from './canvas/Editor.js';
/**
 * Monaco is about a megabyte gzipped — more than the rest of Civil combined. Loading
 * it eagerly would make every canvas session pay for an editor it may never open, so
 * it arrives on the first descent into code and is cached from then on.
 */
const CodeContext = lazy(() =>
  import('./code/CodeContext.js').then((m) => ({ default: m.CodeContext })),
);
import { CommitBar } from './panes/CommitBar.js';
import { Inspector } from './panes/Inspector.js';
import { ProjectTree } from './panes/ProjectTree.js';
import { Settings } from './panes/Settings.js';
import {
  SIGN_IN_ERRORS,
  fetchMe,
  signIn,
  type Me,
  type SessionState,
} from './identity.js';
import {
  commitProject,
  fetchBundle,
  fetchExamples,
  fetchProjects,
  openExample,
  type ExampleDefinition,
  type ProjectBundle,
} from './project.js';

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
      return <Fatal title="Cannot reach the API" message={session.message} />;
    case 'authenticated':
      return <Workspace me={session.me} />;
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

function Fatal({ title, message }: { title: string; message: string }) {
  return (
    <div className="gate">
      <div className="gate-card">
        <h1>{title}</h1>
        <p>{message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}

type Load =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; bundle: ProjectBundle }
  | { status: 'error'; message: string };

/**
 * PRD 14 M1 ends with an example rendering at both altitudes. Offering it here — as a
 * thing you click rather than a project that appears by magic — means development and
 * production behave identically, and the first thing a new account sees is a canvas
 * rather than an explanation of why there isn't one.
 */
function EmptyState() {
  const [examples, setExamples] = useState<ExampleDefinition[] | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchExamples(controller.signal).then(setExamples).catch(() => setExamples([]));
    return () => controller.abort();
  }, []);

  const open = async (slug: string) => {
    setOpening(slug);
    try {
      await openExample(slug);
      window.location.reload();
    } catch {
      setOpening(null);
    }
  };

  return (
    <div className="empty">
      <h2>No project open</h2>
      <p>Connect GitHub in settings to open one of your repositories.</p>

      {examples && examples.length > 0 ? (
        <>
          <h3 className="section" style={{ marginTop: 28 }}>Or start from an example</h3>
          {examples.map((example) => (
            <div key={example.slug} className="example">
              <div className="example-name">{example.name}</div>
              <div className="example-description">{example.description}</div>
              <button
                type="button"
                className="connect"
                disabled={opening !== null}
                onClick={() => void open(example.slug)}
              >
                {opening === example.slug ? 'Opening…' : 'Open'}
              </button>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

function Workspace({ me }: { me: Me }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * PRD 1: the navigation model is TouchDesigner's. Double-click descends into a
   * context and you are then INSIDE it, not looking at it in a panel. The stack is
   * that "inside": the last entry is where you are, and the rest is how you got there.
   */
  const [stack, setStack] = useState<Altitude[]>([{ kind: 'composition', label: 'app' }]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [commitNote, setCommitNote] = useState<string | null>(null);

  /**
   * Re-reads the project after a save or a commit. The bundle is the only place the
   * canvas gets manifests from, so re-fetching it is what makes an edit to app.yaml
   * show up as a changed node rather than requiring a reload.
   */
  const refresh = useCallback(async () => {
    if (load.status !== 'ready') return;
    try {
      const bundle = await fetchBundle(load.bundle.project.id);
      setLoad({ status: 'ready', bundle });
    } catch { /* leave the previous bundle rendered */ }
  }, [load]);

  const commit = useCallback(async (message: string) => {
    if (load.status !== 'ready') return;
    setCommitting(true);
    setCommitNote(null);
    try {
      const result = await commitProject(load.bundle.project.id, message);
      setCommitNote(
        result.reparentedOnto
          ? `Committed ${result.files} file(s) on top of newer work.`
          : `Committed ${result.files} file(s).`,
      );
      await refresh();
    } catch (error) {
      setCommitNote((error as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [load, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const projects = await fetchProjects(controller.signal);
        const first = projects[0];
        if (!first) return setLoad({ status: 'empty' });
        const bundle = await fetchBundle(first.id, controller.signal);
        setLoad({ status: 'ready', bundle });
        setStack([{ kind: 'composition', label: bundle.project.name || 'app' }]);
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoad({ status: 'error', message: (error as Error).message });
        }
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Monaco handles its own Escape (dismissing autocomplete, say), so only ascend
      // when focus is outside the editor.
      const inEditor = (event.target as HTMLElement | null)?.closest?.('.monaco-editor');
      if (event.key === 'Escape' && !inEditor) {
        setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const descend = useCallback((altitude: Altitude) => {
    setSelectedId(null);
    setStack((s) => [...s, altitude]);
  }, []);

  const ascend = useCallback(() => {
    setSelectedId(null);
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const ascendTo = useCallback((index: number) => {
    setSelectedId(null);
    setStack((s) => s.slice(0, index + 1));
  }, []);

  const bundle = load.status === 'ready' ? load.bundle : undefined;
  const current = stack[stack.length - 1]!;
  const pendingCount = bundle?.pending.length ?? 0;

  const fatalCount = useMemo(
    () => bundle?.diagnostics.filter((d) => d.severity === 'error').length ?? 0,
    [bundle],
  );
  const runBlockedCount = useMemo(
    () => bundle?.diagnostics.filter((d) => d.severity === 'run-blocking').length ?? 0,
    [bundle],
  );

  // PRD 4: Run has no meaning on the composition canvas. PRD 6.4: a flow cycle blocks
  // Run without failing the save. Both are expressed here rather than hidden.
  const runDisabled = current.kind === 'composition' || runBlockedCount > 0 || fatalCount > 0;
  const runTitle =
    current.kind === 'composition'
      ? 'Run has no meaning on the composition canvas'
      : fatalCount > 0
        ? `${fatalCount} validation error${fatalCount === 1 ? '' : 's'}`
        : runBlockedCount > 0
          ? 'A flow cycle blocks Run until it is broken'
          : 'Runtime arrives with M4';

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">Civil</span>
        <nav className="breadcrumb" aria-label="Location">
          {stack.map((level, index) => (
            <span key={`${level.kind}-${index}`}>
              {index > 0 ? <span className="sep">/</span> : null}
              {index === stack.length - 1 ? (
                <span className="here">{level.label}</span>
              ) : (
                <button type="button" className="crumb" onClick={() => ascendTo(index)}>
                  {level.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <span className="spacer" />
        {fatalCount > 0 ? (
          <span className="chip" title="Validation errors">
            <span className="dot danger" />
            {fatalCount} error{fatalCount === 1 ? '' : 's'}
          </span>
        ) : null}
        <span className="chip" title="Current branch">
          <span className="dot" />
          {bundle?.project.defaultBranch ?? 'main'}
        </span>
        {/* PRD 7: commits are explicit, and the indicator shows a count. */}
        <CommitBar
          count={pendingCount}
          committing={committing}
          note={commitNote}
          // Asserted, not assumed. `!== 'example'` fails open when the field is
          // missing — an older server, a shape change — and offers to commit
          // something with no repository behind it.
          committable={bundle?.project.sourceKind === 'github'}
          onCommit={commit}
          onDismissNote={() => setCommitNote(null)}
        />
        <button className="run" type="button" disabled={runDisabled} title={runTitle}>
          Run
        </button>
        <button className="avatar" type="button" onClick={() => setSettingsOpen((v) => !v)} title={me.email}>
          {me.avatarUrl ? <img src={me.avatarUrl} alt="" /> : (me.email[0] ?? '?').toUpperCase()}
        </button>
      </header>

      <aside className="pane tree">
        <ProjectTree bundle={bundle} />
      </aside>

      <main className="centre">
        {load.status === 'loading' ? null : load.status === 'error' ? (
          <div className="empty">
            <h2>Could not load the project</h2>
            <p>{load.message}</p>
          </div>
        ) : load.status === 'empty' ? (
          <EmptyState />
        ) : current.kind === 'code' ? (
          // PRD 7: a viewport takeover, not a panel. The canvas is still on the stack
          // underneath, so Escape returns you to exactly where you left it.
          <Suspense fallback={<div className="code-empty">Loading editor…</div>}>
            <CodeContext
              projectId={load.bundle.project.id}
              files={current.files}
              onPendingChanged={() => void refresh()}
            />
          </Suspense>
        ) : (
          <Editor
            bundle={load.bundle}
            stack={stack}
            selectedId={selectedId}
            onDescend={descend}
            onAscend={ascend}
            onSelect={setSelectedId}
          />
        )}
      </main>

      <aside className="pane inspector">
        {settingsOpen ? (
          <Settings me={me} onClose={() => setSettingsOpen(false)} />
        ) : (
          <Inspector bundle={bundle} altitude={current} selectedId={selectedId} />
        )}
      </aside>
    </div>
  );
}
