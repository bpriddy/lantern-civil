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
import { KeyHelp } from './commands/KeyHelp.js';
import { Toast } from './commands/Toast.js';
import { useCommands } from './commands/useCommands.js';
import { Home } from './panes/Home.js';
import { AddNode } from './panes/AddNode.js';
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
  applyOps,
  commitProject,
  initializeProject,
  fetchBundle,
  fetchExamples,
  fetchProjects,
  syncProject,
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
  const [keyHelpOpen, setKeyHelpOpen] = useState(false);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [initializing, setInitializing] = useState(false);
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

  /**
   * Opening a file from the tree is the same code takeover a code node descends into
   * — one file rather than a node's set. Without it, a file no node points at, like
   * CIVIL.md, could not be reached at all.
   */
  const openFile = useCallback((path: string) => {
    setSelectedId(null);
    setStack((current) => {
      const label = path.split('/').pop() ?? path;
      const top = current[current.length - 1];

      // Code contexts do not nest: opening a file while already looking at one adds a
      // tab rather than pushing another level, so Escape still returns to the canvas
      // you came from rather than walking back through files you happened to visit.
      if (top?.kind === 'code') {
        const files = top.files.includes(path) ? top.files : [...top.files, path];
        return [...current.slice(0, -1), { ...top, label, files, active: path }];
      }
      return [...current, { kind: 'code' as const, label, files: [path], active: path }];
    });
  }, []);

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
  const canCommit = bundle?.project.sourceKind === 'github';

  /**
   * The keyboard dispatches into the command registry, and an agent will dispatch
   * into the same one (CLAUDE.md). Each handler returns what it did in words, which
   * is what the toast shows — and what an agent transcript will show later.
   */
  const { effect, report } = useCommands(
    {
      where: atHome ? 'home' : current.kind === 'code' ? 'code' : 'canvas',
      hasSelection: selectedId !== null,
      pendingCount,
      canCommit,
      depth: stack.length - 1,
    },
    {
      'nav.home': () => {
        goHome();
        return 'Showing all projects.';
      },
      'project.switch': () => {
        setPickerOpen((v) => !v);
        return 'Project picker.';
      },
      'nav.ascend': () => {
        if (stack.length <= 1) return undefined;
        const leaving = stack[stack.length - 1]!;
        ascend();
        return `Left ${leaving.label}.`;
      },
      'canvas.clearSelection': () => {
        if (!selectedId) return undefined;
        setSelectedId(null);
        return 'Selection cleared.';
      },
      'project.sync': () => {
        if (!canCommit) return undefined;
        void doSync();
        return 'Checking the repository…';
      },
      'project.settings': () => {
        setSettingsOpen((v) => !v);
        return 'Settings.';
      },
      'help.keys': () => {
        setKeyHelpOpen((v) => !v);
        return 'Every shortcut and what it does.';
      },
      'node.add': () => {
        if (current.kind === 'code') return undefined;
        // A repository with no manifests has nothing to add a node to. Saying that is
        // more useful than letting the op fail with "app.yaml could not be read",
        // which is true and tells you nothing about what to do next.
        if (load.status === 'ready' && !load.bundle.composition) {
          report({
            title: 'Add node',
            detail: `${load.bundle.compositionPath} does not exist yet — this repository is not a Civil project.`,
            refused: true,
          });
          return undefined;
        }
        setAddNodeOpen(true);
        return 'Choose a node type.';
      },
      'project.commit': () => {
        if (pendingCount === 0) return undefined;
        setPickerOpen(false);
        // Committing needs a message, so the shortcut opens the prompt rather than
        // committing silently — PRD 7 makes commits explicit.
        return `${pendingCount} pending change${pendingCount === 1 ? '' : 's'} ready. Add a message to commit.`;
      },
    },
  );

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
  // PRD 4: nothing executes at the composition altitude. Nor is there anything to run
  // while looking at a file — Run belongs to a graph, and enabling it anywhere else
  // offers something that cannot happen.
  const runDisabled = current.kind !== 'graph' || runBlockedCount > 0 || fatalCount > 0;
  const runTitle =
    current.kind === 'composition'
      ? 'Run has no meaning on the composition canvas'
      : current.kind === 'code'
        ? 'Run belongs to a graph, not to a file'
        : fatalCount > 0
        ? `${fatalCount} validation error${fatalCount === 1 ? '' : 's'}`
        : runBlockedCount > 0
          ? 'A flow cycle blocks Run until it is broken'
          : 'Runtime arrives with M4';

  /**
   * PRD 7.1: the client posts ops and the server applies them. The same call is what
   * an agent will make, which is why the placement and the id are decided here rather
   * than inside a component that only the keyboard can reach.
   */
  const addNode = useCallback(
    async (node: Record<string, unknown>) => {
      if (!activeId || load.status !== 'ready') return;
      const level = stack[stack.length - 1]!;
      const manifestPath =
        level.kind === 'graph' ? level.path : load.bundle.compositionPath;

      try {
        const { summary } = await applyOps(activeId, manifestPath, [
          { op: 'addNode', node },
          // Somewhere visible rather than at the origin. Where exactly is the open
          // question about what a command targets — see docs/roadmap.md.
          { op: 'setLayout', id: String(node['id']), x: 120, y: 420 },
        ]);
        await refresh();
        report({ title: 'Add node', detail: summary });
      } catch (error) {
        report({ title: 'Add node', detail: (error as Error).message, refused: true });
      }
    },
    [activeId, load, stack, refresh, report],
  );

  const initialize = useCallback(async () => {
    if (!activeId) return;
    setInitializing(true);
    try {
      const { files, summary } = await initializeProject(activeId);
      await refresh();
      report({ title: 'Add Civil', detail: summary });
      // Land in CIVIL.md: the scaffold's whole point is that you describe the project,
      // and an empty canvas does not invite that.
      if (files.includes('CIVIL.md')) openFile('CIVIL.md');
    } catch (error) {
      report({ title: 'Add Civil', detail: (error as Error).message, refused: true });
    } finally {
      setInitializing(false);
    }
  }, [activeId, refresh, report, openFile]);

  const doSync = useCallback(async () => {
    if (!activeId) return;
    try {
      const { summary, moved } = await syncProject(activeId);
      if (moved) await refresh();
      report({ title: 'Sync', detail: summary });
    } catch (error) {
      report({ title: 'Sync', detail: (error as Error).message, refused: true });
    }
  }, [activeId, refresh, report]);

  if (atHome) {
    return (
      <>
        <Toast effect={effect} />
        {keyHelpOpen ? <KeyHelp onClose={() => setKeyHelpOpen(false)} /> : null}
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
      <Toast effect={effect} />
      {keyHelpOpen ? <KeyHelp onClose={() => setKeyHelpOpen(false)} /> : null}
      {addNodeOpen && bundle ? (
        <AddNode
          altitude={current.kind === 'graph' ? 'graph' : 'composition'}
          existingIds={
            current.kind === 'graph'
              ? (bundle.graphs[current.path]?.spec.nodes ?? []).map((n) => n.id)
              : (bundle.composition?.spec.nodes ?? []).map((n) => n.id)
          }
          onAdd={(node) => void addNode(node)}
          onClose={() => setAddNodeOpen(false)}
        />
      ) : null}
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
        {/* The branch, and the way to pick up what has been pushed to it. Civil
            edits against a pinned commit, so this is deliberate rather than automatic. */}
        <button
          type="button"
          className="chip chip-branch"
          onClick={() => void doSync()}
          disabled={!canCommit}
          title={
            canCommit
              ? 'Sync: pick up commits pushed since this project was opened'
              : 'Only a repository-backed project has anything to sync with'
          }
        >
          <span className="dot" />
          {bundle?.project.defaultBranch ?? 'main'}
          {canCommit ? <span className="chip-sync">⟳</span> : null}
        </button>
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
        <ProjectTree
          bundle={bundle}
          onOpenFile={openFile}
          onInitialize={() => void initialize()}
          initializing={initializing}
        />
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
              active={current.active}
              onActiveChange={(path) =>
                setStack((s) => {
                  const top = s[s.length - 1];
                  if (top?.kind !== 'code' || top.active === path) return s;
                  return [
                    ...s.slice(0, -1),
                    { ...top, active: path, label: path.split('/').pop() ?? path },
                  ];
                })
              }
              onPendingChanged={(saved) => {
                void refresh();
                if (saved) report({ chord: '⌘S', title: 'Save', detail: `${saved} saved as a pending change.` });
              }}
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
