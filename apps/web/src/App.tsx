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
import { Home } from './panes/Home.js';
import { ProjectPicker } from './panes/ProjectPicker.js';
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
  type ProjectBundle,
  type ProjectSummary,
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

const ACTIVE_PROJECT_KEY = 'civil.activeProject';

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

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(
    () => localStorage.getItem(ACTIVE_PROJECT_KEY) ?? undefined,
  );
  /**
   * Civil used to open whichever project was remembered, so a new account arrived
   * inside an example it never chose and an existing one had no way back out. Home
   * is where you land; the remembered project is only a shortcut back to it.
   */
  const [atHome, setAtHome] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const reloadProjects = useCallback(async () => {
    const list = await fetchProjects();
    setProjects(list);
    return list;
  }, []);


  /**
   * Re-reads the project after a save or a commit. The bundle is the only place the
   * canvas gets manifests from, so re-fetching it is what makes an edit to app.yaml
   * show up as a changed node rather than requiring a reload.
   */
  const refresh = useCallback(async () => {
    if (!activeId) return;
    try {
      setLoad({ status: 'ready', bundle: await fetchBundle(activeId) });
    } catch { /* leave the previous bundle rendered */ }
  }, [activeId]);

  const commit = useCallback(async (message: string) => {
    if (!activeId) return;
    setCommitting(true);
    setCommitNote(null);
    try {
      const result = await commitProject(activeId, message);
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
  }, [activeId, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const list = await fetchProjects(controller.signal);
        setProjects(list);
        // The remembered project may have been removed since; forget it rather than
        // holding a shortcut to something that no longer exists.
        if (activeId && !list.some((p) => p.id === activeId)) {
          setActiveId(undefined);
          localStorage.removeItem(ACTIVE_PROJECT_KEY);
        }
      } catch (error) {
        if (!controller.signal.aborted) setLoad({ status: 'error', message: (error as Error).message });
      }
    })();
    return () => controller.abort();
    // Runs once: later project changes go through setActiveId, which reloads below.
  }, []);

  useEffect(() => {
    if (!activeId) return;
    localStorage.setItem(ACTIVE_PROJECT_KEY, activeId);

    const controller = new AbortController();
    setLoad({ status: 'loading' });
    void fetchBundle(activeId, controller.signal)
      .then((bundle) => {
        setLoad({ status: 'ready', bundle });
        setStack([{ kind: 'composition', label: bundle.project.name || 'app' }]);
        setSelectedId(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoad({ status: 'error', message: (error as Error).message });
        }
      });
    return () => controller.abort();
  }, [activeId]);

  const enterProject = useCallback((id: string) => {
    setActiveId(id);
    setAtHome(false);
  }, []);

  const goHome = useCallback(() => {
    setAtHome(true);
    setPickerOpen(false);
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

  if (atHome) {
    return (
      <>
        <Home
          me={me}
          projects={projects}
          onOpen={enterProject}
          onChanged={reloadProjects}
          onOpenSettings={() => { setAtHome(false); setSettingsOpen(true); }}
        />
        {settingsOpen ? null : null}
      </>
    );
  }

  return (
    <div className="shell">
      <header className="top">
        {/* The way back out. */}
        <button type="button" className="brand brand-home" onClick={goHome} title="All projects">
          Civil
        </button>
        <span className="project-switch-wrap">
          <button
            type="button"
            className="project-switch"
            onClick={() => setPickerOpen((v) => !v)}
            title="Switch project, or open a repository"
          >
            {bundle?.project.name ?? 'No project'} <span className="project-switch-caret">▾</span>
          </button>
          {pickerOpen ? (
            <ProjectPicker
              projects={projects}
              activeId={activeId}
              onSelect={enterProject}
              onChanged={() => void reloadProjects().then((list) => {
                // Removing the open project leaves nothing selected; fall to the next.
                if (activeId && !list.some((p) => p.id === activeId)) setActiveId(list[0]?.id);
              })}
              onClose={() => setPickerOpen(false)}
            />
          ) : null}
        </span>
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
          <div className="empty">
            <h2>No project open</h2>
            <p>Open one of your repositories, or start from an example.</p>
            <button type="button" className="connect" onClick={() => setPickerOpen(true)}>
              Choose a project
            </button>
          </div>
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
