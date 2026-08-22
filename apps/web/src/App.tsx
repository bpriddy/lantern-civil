import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor, descentTarget, type Altitude } from './canvas/Editor.js';
import { compositionToFlow, graphToFlow } from './canvas/model.js';
import type { NodeData } from './canvas/nodes.js';
/**
 * Monaco is about a megabyte gzipped — more than the rest of Civil combined. Loading
 * it eagerly would make every canvas session pay for an editor it may never open, so
 * it arrives on the first descent into code and is cached from then on.
 */
const CodeContext = lazy(() =>
  import('./code/CodeContext.js').then((m) => ({ default: m.CodeContext })),
);
/** The diff panel embeds Monaco's diff editor, so it arrives with the same chunk. */
const DiffPanel = lazy(() =>
  import('./panes/DiffPanel.js').then((m) => ({ default: m.DiffPanel })),
);
import { CommitBar } from './panes/CommitBar.js';
import { ConfirmDelete } from './panes/ConfirmDelete.js';
import { KeyHelp } from './commands/KeyHelp.js';
import { Toast } from './commands/Toast.js';
import { useCommands } from './commands/useCommands.js';
import { Home } from './panes/Home.js';
import { AddNode } from './panes/AddNode.js';
import { ProjectPicker } from './panes/ProjectPicker.js';
import { RunPanel } from './panes/RunPanel.js';
import { RunLog } from './panes/RunLog.js';
import { PreviewPane, type AppSessionState } from './panes/PreviewPane.js';
import { SessionLog } from './panes/SessionLog.js';
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
  revertFile,
  saveFile,
  startRun,
  fetchRunEvents,
  cancelRun,
  startSession,
  getSession,
  stopSession,
  syncProject,
  transpileProject,
  type ManifestOp,
  type RunEvent,
  type RunSummary,
  type ProjectBundle,
  type ProjectSummary,
} from './project.js';

/**
 * One undoable step: which file an op batch touched, what the file said before it,
 * and whether that earlier state was itself a pending edit. Undo either restores the
 * earlier pending content or, when the batch was the first thing to touch the file,
 * discards the pending row so the file falls back to HEAD.
 */
interface UndoEntry {
  path: string;
  previous: string;
  hadPending: boolean;
  summary: string;
}

/** Enough for a long session of canvas edits; manifests are small. */
const UNDO_LIMIT = 50;

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
  /** Selection is plural — shift-drag boxes and shift-clicks accumulate it. */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  /** What Delete is asking about, while it asks. */
  const [confirming, setConfirming] = useState<{ nodes: string[]; edges: string[] } | null>(null);
  const clearSelection = useCallback(() => {
    setSelectedIds([]);
    setSelectedEdgeIds([]);
  }, []);
  const [committing, setCommitting] = useState(false);
  const [commitNote, setCommitNote] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  /** The run being watched: its identity, where it stands, and its story so far. */
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [activeRun, setActiveRun] = useState<{ id: string; status: RunSummary['status'] } | null>(null);
  const [runEvents, setRunEvents] = useState<RunEvent[]>([]);
  const [runLogOpen, setRunLogOpen] = useState(false);

  /** The app session (docs/app-session.md): what composition Run starts. */
  const [appSession, setAppSession] = useState<AppSessionState>({ phase: 'idle' });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sessionLogOpen, setSessionLogOpen] = useState(false);

  /**
   * The op history, most recent last. In a ref because pushing must not re-render;
   * undoDepth mirrors the length so `enabled(canUndo)` sees changes.
   */
  const undoStack = useRef<UndoEntry[]>([]);
  /** Which graph the active run belongs to, for routing top-level events. */
  const runGraphRef = useRef<string | undefined>(undefined);
  const [undoDepth, setUndoDepth] = useState(0);
  const clearUndo = useCallback(() => {
    undoStack.current = [];
    setUndoDepth(0);
  }, []);

  /** The canvas's own verbs, registered by the Editor when it mounts. */
  const canvasActions = useRef<{ fit: () => void } | null>(null);

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
      // Undo stops at a commit. Walking back past one would resurrect pre-commit
      // text as a new pending change — an edit war with your own history.
      clearUndo();
      await refresh();
    } catch (error) {
      setCommitNote((error as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [activeId, refresh, clearUndo]);

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
        clearSelection();
        setDiffOpen(false);
        // History is per project; entries name files in the one being left.
        clearUndo();
        // So is the app session — sessionId IS the project id. The probe below
        // re-attaches if this project has one running.
        setAppSession({ phase: 'idle' });
        setPreviewOpen(false);
        setSessionLogOpen(false);
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
  /**
   * Stable identity on purpose. An inline arrow is a new value every render, and the
   * effect that reports the active file depends on it — which would run the effect on
   * every render forever.
   */
  const reportActiveFile = useCallback((path: string) => {
    setStack((s) => {
      const top = s[s.length - 1];
      if (top?.kind !== 'code' || top.active === path) return s;
      return [...s.slice(0, -1), { ...top, active: path, label: path.split('/').pop() ?? path }];
    });
  }, []);

  const openFile = useCallback((path: string) => {
    clearSelection();
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
  }, [clearSelection]);

  const enterProject = useCallback((id: string) => {
    setActiveId(id);
    setAtHome(false);
  }, []);

  const goHome = useCallback(() => {
    setAtHome(true);
    setPickerOpen(false);
  }, []);

  const descend = useCallback((altitude: Altitude) => {
    clearSelection();
    setStack((s) => [...s, altitude]);
  }, [clearSelection]);

  const ascend = useCallback(() => {
    clearSelection();
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, [clearSelection]);

  const ascendTo = useCallback((index: number) => {
    clearSelection();
    setStack((s) => s.slice(0, index + 1));
  }, [clearSelection]);

  const bundle = load.status === 'ready' ? load.bundle : undefined;
  const current = stack[stack.length - 1]!;
  const pendingCount = bundle?.pending.length ?? 0;
  const canCommit = bundle?.project.sourceKind === 'github';

  const fatalCount = useMemo(
    () => bundle?.diagnostics.filter((d) => d.severity === 'error').length ?? 0,
    [bundle],
  );
  const runBlockedCount = useMemo(
    () => bundle?.diagnostics.filter((d) => d.severity === 'run-blocking').length ?? 0,
    [bundle],
  );

  // docs/app-session.md supersedes PRD 4's "Run has no meaning on the composition
  // canvas": composition Run runs the APP — the session — while graph Run keeps the
  // module loop untouched. PRD 6.4 still holds on a graph: a flow cycle blocks Run
  // without failing the save, and validation errors block both altitudes.
  const sessionReady = current.kind === 'composition' && load.status === 'ready' && fatalCount === 0;
  const sessionActive = appSession.phase === 'starting' || appSession.phase === 'live';
  const runDisabled =
    current.kind === 'graph' ? runBlockedCount > 0 || fatalCount > 0 : !sessionReady;

  /**
   * The keyboard dispatches into the command registry, and an agent will dispatch
   * into the same one (CLAUDE.md). Each handler returns what it did in words, which
   * is what the toast shows — and what an agent transcript will show later.
   */
  const { effect, report } = useCommands(
    {
      // The diff panel is a location, not an overlay: while it is open, canvas
      // commands must not fire underneath it, or the diff on screen stops being
      // the diff that commits.
      where: atHome ? 'home' : diffOpen ? 'diff' : current.kind === 'code' ? 'code' : 'canvas',
      hasSelection: selectedIds.length > 0 || selectedEdgeIds.length > 0,
      pendingCount,
      canCommit,
      canUndo: undoDepth > 0,
      canRun: current.kind === 'graph' && !runDisabled,
      runActive: activeRun?.status === 'queued' || activeRun?.status === 'running',
      canSession: sessionReady,
      sessionActive,
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
      'nav.descend': () => {
        // The same question the double-click asks, asked of the one selected node.
        if (current.kind === 'code' || !bundle) return undefined;
        if (selectedIds.length !== 1 || selectedEdgeIds.length > 0) {
          return selectedEdgeIds.length > 0 ? 'An edge has no interior.' : undefined;
        }
        const context = {
          graphs: bundle.graphs,
          agents: bundle.agents,
          files: bundle.files,
          contracts: bundle.contracts,
        };
        const flow =
          current.kind === 'composition'
            ? bundle.composition &&
              compositionToFlow(bundle.composition, bundle.compositionPath, bundle.diagnostics, context)
            : bundle.graphs[current.path] &&
              graphToFlow(bundle.graphs[current.path]!, current.path, bundle.diagnostics, context);
        const flowNode = flow?.nodes.find((n) => n.id === selectedIds[0]);
        const target = flowNode ? descentTarget(flowNode.data as NodeData) : undefined;
        if (!target) return `“${selectedIds[0]}” is a leaf — nothing to enter.`;
        descend(target);
        return `Entered ${target.label}.`;
      },
      'canvas.fit': () => {
        if (!canvasActions.current) return undefined;
        canvasActions.current.fit();
        // The motion is its own feedback.
        return null;
      },
      'canvas.clearSelection': () => {
        if (selectedIds.length === 0 && selectedEdgeIds.length === 0) return undefined;
        clearSelection();
        return 'Selection cleared.';
      },
      'canvas.delete': () => {
        // Deleting destroys information, so it asks first. The modal is the
        // feedback, so the command itself is silent.
        if (selectedIds.length === 0 && selectedEdgeIds.length === 0) return undefined;
        setConfirming({ nodes: selectedIds, edges: selectedEdgeIds });
        return null;
      },
      'edit.undo': () => {
        const entry = undoStack.current[undoStack.current.length - 1];
        if (!entry) return undefined;
        void undoLast();
        return `Undoing: ${entry.summary}`;
      },
      'run.start': () => {
        setRunPanelOpen(true);
        // The input panel is the next thing on screen; it speaks for itself.
        return null;
      },
      'run.cancel': () => {
        if (!activeRun || !activeId) return undefined;
        void cancelRun(activeId, activeRun.id).catch(() => undefined);
        return 'Cancellation requested — the run stops at the next node boundary.';
      },
      'session.start': () => {
        void beginSession();
        return sessionActive
          ? 'Attached — the app session is already up.'
          : 'Starting the app session…';
      },
      'session.stop': () => {
        if (!sessionActive) return undefined;
        void endSession();
        return 'Stopping the app session.';
      },
      'project.diff': () => {
        if (pendingCount === 0) return undefined;
        setDiffOpen(true);
        return 'Every pending change, as a diff, before it commits.';
      },
      'project.sync': () => {
        if (!canCommit) return undefined;
        void doSync();
        return 'Checking the repository…';
      },
      'project.transpile': () => {
        void doTranspile();
        return 'Transpiling the civil documents…';
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
        // Committing needs a message and deserves the diff in front of it, so the
        // shortcut opens the review panel rather than committing silently — PRD 7
        // makes commits explicit and gives the indicator a diff preview.
        setDiffOpen(true);
        return `${pendingCount} pending change${pendingCount === 1 ? '' : 's'}. Review, add a message, commit.`;
      },
    },
  );

  const runTitle =
    current.kind === 'composition'
      ? fatalCount > 0
        ? `${fatalCount} validation error${fatalCount === 1 ? '' : 's'}`
        : sessionActive
          ? 'The app session is up — Run reopens the preview'
          : 'Run the app: transpile, start every process, open the preview'
      : current.kind === 'code'
        ? 'Run belongs to a canvas, not to a file'
        : fatalCount > 0
        ? `${fatalCount} validation error${fatalCount === 1 ? '' : 's'}`
        : runBlockedCount > 0
          ? 'A flow cycle blocks Run until it is broken'
          : 'Run this graph';

  /**
   * PRD 7.1: the client posts ops and the server applies them. The same call is what
   * an agent will make, which is why the placement and the id are decided here rather
   * than inside a component that only the keyboard can reach.
   */
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
      if (moved) {
        // The head this history was recorded against is gone.
        clearUndo();
        await refresh();
      }
      report({ title: 'Sync', detail: summary });
    } catch (error) {
      report({ title: 'Sync', detail: (error as Error).message, refused: true });
    }
  }, [activeId, refresh, report, clearUndo]);

  /**
   * The emitted files arrive as pending changes, so the refresh is what makes them
   * appear in the tree and the commit indicator — the same beat every other
   * mutation follows.
   */
  const doTranspile = useCallback(async () => {
    if (!activeId) return;
    try {
      const { files, cached, patternsRefreshed } = await transpileProject(activeId);
      await refresh();
      const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
      report({
        title: 'Transpile',
        detail: cached
          ? `Transpiled ${count} — unchanged inputs, replayed from cache.`
          : `Transpiled ${count}.${patternsRefreshed ? ' Pattern prompt refreshed.' : ''}`,
      });
    } catch (error) {
      report({ title: 'Transpile', detail: (error as Error).message, refused: true });
    }
  }, [activeId, refresh, report]);

  /**
   * Watching is reading (PRD 8.2): poll the event log from the last seq while the
   * run is live. The runner never hears from us; reconnecting after a reload would
   * be the same range read from wherever the log left off.
   */
  useEffect(() => {
    if (!activeRun || !activeId) return;
    if (activeRun.status !== 'queued' && activeRun.status !== 'running') return;

    let lastSeq = runEvents.length > 0 ? runEvents[runEvents.length - 1]!.seq : -1;
    let stopped = false;

    const tick = async () => {
      try {
        const { status, events } = await fetchRunEvents(activeId, activeRun.id, lastSeq);
        if (stopped) return;
        if (events.length > 0) {
          lastSeq = events[events.length - 1]!.seq;
          setRunEvents((current) => [...current, ...events]);
        }
        if (status !== activeRun.status) {
          setActiveRun({ id: activeRun.id, status });
        }
      } catch {
        /* a missed poll is not a failed run; the next tick reads on */
      }
    };

    void tick();
    const interval = window.setInterval(() => void tick(), 800);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
    // runEvents deliberately absent: lastSeq advances inside the closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, activeRun?.status, activeId]);

  /**
   * A session may already be running — started before a reload, or from another
   * tab. Attaching is reading the same status the poll reads; a 404 or an
   * unconfigured service leaves the phase at idle, silently, because there is
   * nothing to attach to and nothing has gone wrong.
   */
  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    void getSession(activeId, controller.signal)
      .then((status) => {
        if (!status || controller.signal.aborted) return;
        setAppSession({
          phase: status.processes.some((p) => p.running) ? 'live' : 'starting',
          previews: status.previews,
          boundaries: status.boundaries ?? [],
          processes: status.processes,
          filesVersion: status.filesVersion,
        });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [activeId]);

  /**
   * Composition Run (docs/app-session.md): start the session, or attach to the one
   * already up — Run on a live session brings the pane back, it does not knock the
   * app over to start it again.
   */
  const beginSession = useCallback(async () => {
    if (!activeId) return;
    setPreviewOpen(true);
    if (appSession.phase === 'starting' || appSession.phase === 'live') return;
    setAppSession({ phase: 'starting', previews: [], boundaries: [], processes: [] });
    try {
      const { previews, boundaries } = await startSession(activeId);
      // Still 'starting': live is what the status poll says, not what the POST
      // hopes. Unless a stop raced the start — then the stop stands.
      setAppSession((cur) =>
        cur.phase === 'starting' ? { ...cur, previews, boundaries: boundaries ?? [] } : cur,
      );
    } catch (error) {
      // A start that timed out on the wire may still have started the app; one
      // probe settles it, and a session that answers is attached, not mourned.
      const status = await getSession(activeId).catch(() => undefined);
      if (status) {
        setAppSession({
          phase: status.processes.some((p) => p.running) ? 'live' : 'starting',
          previews: status.previews,
          boundaries: status.boundaries ?? [],
          processes: status.processes,
          filesVersion: status.filesVersion,
        });
        return;
      }
      // The pane is the surface for this failure (not just a toast): a transpile
      // error arrives as a paragraph of validator issues, and it needs the room.
      setAppSession({ phase: 'error', message: (error as Error).message });
    }
  }, [activeId, appSession.phase]);

  const endSession = useCallback(async () => {
    if (!activeId) return;
    try {
      await stopSession(activeId);
      setAppSession({ phase: 'idle' });
    } catch (error) {
      report({ title: 'Stop app', detail: (error as Error).message, refused: true });
    }
  }, [activeId, report]);

  /**
   * The status strip's heartbeat: while the pane is open on a session, ask where
   * every process stands. Watching is reading, the same rule as runs — the session
   * never hears from the poll. 'starting' holds until something is actually
   * running (or everything has already exited, which is also an answer).
   */
  useEffect(() => {
    if (!activeId || !previewOpen || !sessionActive) return;
    let stopped = false;

    const tick = async () => {
      try {
        const status = await getSession(activeId);
        if (stopped) return;
        if (!status) {
          // Gone: stopped elsewhere, or reaped idle. Idle is the honest state.
          setAppSession({ phase: 'idle' });
          return;
        }
        const someRunning = status.processes.some((p) => p.running);
        const allExited =
          status.processes.length > 0 && status.processes.every((p) => p.exitCode !== null);
        setAppSession((cur) => {
          if (cur.phase !== 'starting' && cur.phase !== 'live') return cur;
          return {
            phase: cur.phase === 'live' || someRunning || allExited ? 'live' : 'starting',
            previews: status.previews.length > 0 ? status.previews : cur.previews,
            boundaries: status.boundaries ?? cur.boundaries,
            processes: status.processes,
            filesVersion: status.filesVersion ?? cur.filesVersion,
          };
        });
      } catch {
        /* a missed poll is not a dead session; the next tick reads on */
      }
    };

    void tick();
    const interval = window.setInterval(() => void tick(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [activeId, previewOpen, sessionActive]);

  /** Node states for the canvas overlays, from the story so far. */
  const runStates = useMemo(() => {
    const states: Record<string, string> = {};
    const here = current.kind === 'graph' ? current.path : undefined;
    if (!here) return states;
    for (const event of runEvents) {
      // Top-level events carry no graphPath; subgraph events carry theirs.
      const at = event.graphPath ?? (activeRun ? runGraphRef.current : undefined);
      if (at !== here || !event.nodeId) continue;
      if (event.type === 'node.started') states[event.nodeId] = 'running';
      else if (event.type === 'node.finished' || event.type === 'node.output') states[event.nodeId] = 'finished';
      else if (event.type === 'node.failed') states[event.nodeId] = 'failed';
    }
    return states;
  }, [runEvents, current, activeRun]);

  const beginRun = useCallback(
    async (input: unknown) => {
      if (!activeId || current.kind !== 'graph') return;
      try {
        const run = await startRun(activeId, current.path, input);
        runGraphRef.current = current.path;
        setActiveRun({ id: run.id, status: run.status });
        setRunEvents([]);
        setRunLogOpen(true);
      } catch (error) {
        report({ title: 'Run', detail: (error as Error).message, refused: true });
      }
    },
    [activeId, current, report],
  );

  /**
   * Which manifest the current canvas is a view of. Every op needs it, and getting it
   * from the altitude rather than from the gesture is what keeps a graph edit out of
   * the composition file.
   */
  const manifestPath = useMemo(() => {
    const level = stack[stack.length - 1];
    if (level?.kind === 'graph') return level.path;
    return load.status === 'ready' ? load.bundle.compositionPath : undefined;
  }, [stack, load]);

  const runOps = useCallback(
    async (ops: ManifestOp[], title: string, opts?: { quiet?: boolean }): Promise<boolean> => {
      if (!activeId || !manifestPath) return false;
      try {
        const { summary, previous, hadPending } = await applyOps(activeId, manifestPath, ops);
        // Every application is one undoable step, whatever gesture produced it.
        undoStack.current.push({ path: manifestPath, previous, hadPending, summary });
        if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
        setUndoDepth(undoStack.current.length);
        await refresh();
        // Direct manipulation announces itself — the node moves, the edge appears,
        // the field changes — so `quiet` skips the toast there. Indirect invocations
        // (a key chord now, an agent later) keep it: their effect needs saying. The
        // summary still exists either way, which is what agent-first rule 4 requires
        // — reportable is about the string, not about always rendering it.
        if (!opts?.quiet) report({ title, detail: summary });
        return true;
      } catch (error) {
        // Refusals always speak, quiet or not: when a gesture does nothing, silence
        // reads as a bug.
        report({ title, detail: (error as Error).message, refused: true });
        return false;
      }
    },
    [activeId, manifestPath, refresh, report],
  );

  /**
   * PRD 7 lists Cmd+Z. An op's inverse is not computed — the file's previous text was
   * kept, and restoring a whole small manifest is simpler and safer than reversing a
   * splice. When the op was the first touch on the file, the pending row itself is
   * discarded, so undoing everything returns the project to "no pending changes".
   */
  const undoLast = useCallback(async () => {
    const entry = undoStack.current.pop();
    setUndoDepth(undoStack.current.length);
    if (!entry || !activeId) return;
    try {
      if (entry.hadPending) {
        await saveFile(activeId, entry.path, entry.previous);
      } else {
        await revertFile(activeId, entry.path);
      }
      // What was selected may be what was just unmade; a ghost selection keeps
      // Delete enabled against a node that is no longer there.
      clearSelection();
      await refresh();
      report({ title: 'Undo', detail: `Undid: ${entry.summary}` });
    } catch (error) {
      // The entry is already popped; putting it back would retry against whatever
      // just failed. Report and leave the file as it is.
      report({ title: 'Undo', detail: (error as Error).message, refused: true });
    }
  }, [activeId, refresh, report, clearSelection]);

  /**
   * What a confirmed Delete performs: every selected node (each cascading its own
   * edges), plus every selected edge whose fate is not already sealed by a selected
   * endpoint — one batch, one pending change, one undo step.
   */
  const performDelete = useCallback(async () => {
    if (!confirming) return;
    setConfirming(null);
    const graphOrComposition =
      current.kind === 'graph' ? bundle?.graphs[current.path] : bundle?.composition;
    const doomed = new Set(confirming.nodes);
    const ops: ManifestOp[] = [
      ...confirming.nodes.map((id): ManifestOp => ({ op: 'removeNode', id })),
      ...confirming.edges
        .filter((id) => {
          const edge = graphOrComposition?.spec.edges.find((e) => e.id === id);
          return !edge || (!doomed.has(edge.from.node) && !doomed.has(edge.to.node));
        })
        .map((id): ManifestOp => ({ op: 'removeEdge', id })),
    ];
    if (ops.length === 0) return;
    const ok = await runOps(ops, 'Delete', { quiet: true });
    if (ok) clearSelection();
  }, [confirming, current, bundle, runOps, clearSelection]);

  /**
   * Drawing an edge, with one added meaning: a flow edge is the moment a code
   * context becomes a step (PRD 5), and a step must have a callable boundary. If an
   * endpoint is a code node with no entrypoint, the gesture makes that true — a
   * typed identity handler written beside the node's files, and the field set, in
   * the same application. Never over anything that exists: if main.py is already
   * there it was written by someone with intentions, and the inspector is where an
   * entrypoint gets chosen deliberately.
   */
  const connectEdge = useCallback(
    async (edge: Record<string, unknown>) => {
      const ops: ManifestOp[] = [];

      if (edge['kind'] === 'flow' && activeId && bundle && manifestPath) {
        const graph = bundle.graphs[manifestPath];
        const known = new Set([...bundle.files, ...bundle.pending.map((p) => p.path)]);

        for (const end of ['from', 'to'] as const) {
          const endpoint = (edge[end] as { node?: string } | undefined)?.node;
          const node = graph?.spec.nodes.find((n) => n.id === endpoint);
          if (!node || node.type !== 'code' || node.entrypoint) continue;

          // The node's own directory: where its include already points, or a fresh
          // one named after it when the include list is empty.
          const glob = node.include[0];
          const starAt = glob ? glob.search(/[*?[]/) : -1;
          const dir = (starAt > 0 ? glob!.slice(0, starAt) : `src/${node.id.replace(/-/g, '_')}/`)
            .replace(/\/+$/, '');
          const path = `${dir}/main.py`;
          if (known.has(path)) continue;

          try {
            const { codeStub } = await import('./panes/AddNode.js');
            await saveFile(activeId, path, codeStub(node.id));
          } catch (error) {
            report({ title: 'Connect', detail: (error as Error).message, refused: true });
            return;
          }
          const patch: Record<string, unknown> = { entrypoint: path };
          if (node.include.length === 0) patch['include'] = [`${dir}/**/*.py`];
          ops.push({ op: 'updateNode', id: node.id, patch });
        }
      }

      ops.push({ op: 'addEdge', edge });
      await runOps(ops, 'Connect', { quiet: true });
    },
    [activeId, bundle, manifestPath, runOps, report],
  );

  const addNode = useCallback(
    async (node: Record<string, unknown>, scaffold: { path: string; content: string }[]) => {
      // A node whose references point at nothing arrives broken — unresolved
      // entrypoint, unresolved ref — so the files it needs are written first, as
      // pending changes. For a code context that file is a typed identity function:
      // the least prescriptive thing that still HAS an input and an output, since
      // PRD 7.2 keeps i and o in the source rather than in configuration. Paths
      // that already exist are left alone — a node may point at real code.
      if (activeId) {
        const existing = new Set([
          ...(bundle?.files ?? []),
          ...(bundle?.pending.map((p) => p.path) ?? []),
        ]);
        try {
          for (const file of scaffold) {
            if (!existing.has(file.path)) await saveFile(activeId, file.path, file.content);
          }
        } catch (error) {
          report({ title: 'Add node', detail: (error as Error).message, refused: true });
          return;
        }
      }
      await runOps(
        [
          { op: 'addNode', node },
          // Somewhere visible rather than at the origin. Where exactly is the open
          // question about what a command targets — see docs/roadmap.md.
          { op: 'setLayout', id: String(node['id']), x: 120, y: 420 },
        ],
        'Add node',
      );
    },
    [runOps, activeId, bundle, report],
  );


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
    <div className={`shell${previewOpen ? ' with-preview' : ''}`}>
      <Toast effect={effect} />
      {keyHelpOpen ? <KeyHelp onClose={() => setKeyHelpOpen(false)} /> : null}
      {diffOpen && bundle ? (
        <Suspense fallback={null}>
          <DiffPanel
            projectId={bundle.project.id}
            // Asserted, not assumed: `=== 'github'` fails closed when the field is
            // missing — an older server, a shape change — rather than offering to
            // commit something with no repository behind it.
            committable={bundle.project.sourceKind === 'github'}
            committing={committing}
            onCommit={(message) => void commit(message)}
            onClose={() => setDiffOpen(false)}
          />
        </Suspense>
      ) : null}
      {runPanelOpen && bundle && current.kind === 'graph' ? (
        <RunPanel
          projectId={bundle.project.id}
          graphPath={current.path}
          onRun={(input) => void beginRun(input)}
          onClose={() => setRunPanelOpen(false)}
        />
      ) : null}
      {confirming ? (
        <ConfirmDelete
          nodes={confirming.nodes}
          edges={confirming.edges}
          cascades={(() => {
            const doc =
              current.kind === 'graph' ? bundle?.graphs[current.path] : bundle?.composition;
            const doomed = new Set(confirming.nodes);
            const named = new Set(confirming.edges);
            return (doc?.spec.edges ?? []).filter(
              (e) => !named.has(e.id) && (doomed.has(e.from.node) || doomed.has(e.to.node)),
            ).length;
          })()}
          onConfirm={() => void performDelete()}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
      {addNodeOpen && bundle ? (
        <AddNode
          altitude={current.kind === 'graph' ? 'graph' : 'composition'}
          existingIds={
            current.kind === 'graph'
              ? (bundle.graphs[current.path]?.spec.nodes ?? []).map((n) => n.id)
              : (bundle.composition?.spec.nodes ?? []).map((n) => n.id)
          }
          onAdd={(node, scaffold) => void addNode(node, scaffold)}
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
        {/* PRD 7: the indicator shows a count; clicking it shows the diff preview. */}
        <CommitBar
          count={pendingCount}
          note={commitNote}
          onReview={() => setDiffOpen(true)}
          onDismissNote={() => setCommitNote(null)}
        />
        {activeRun ? (
          <button
            type="button"
            className={`chip runchip runchip-${activeRun.status}`}
            onClick={() => setRunLogOpen((v) => !v)}
            title="Show or hide the run log"
          >
            <span className="dot" />
            run · {activeRun.status}
          </button>
        ) : null}
        {appSession.phase !== 'idle' ? (
          <button
            type="button"
            className={`chip runchip appchip-${appSession.phase}`}
            onClick={() => setPreviewOpen((v) => !v)}
            title="Show or hide the app preview"
          >
            <span className="dot" />
            app · {appSession.phase}
          </button>
        ) : null}
        {/* One button, two meanings, split by altitude (docs/app-session.md):
            composition Run runs the app; graph Run runs the graph. */}
        <button
          className="run"
          type="button"
          disabled={runDisabled}
          title={runTitle}
          onClick={() =>
            current.kind === 'composition' ? void beginSession() : setRunPanelOpen(true)
          }
        >
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
              onActiveChange={reportActiveFile}
              onPendingChanged={(saved) => {
                if (saved) {
                  // The undo stack's snapshots of this file predate the manual save;
                  // restoring one would silently destroy it. Those entries die here
                  // rather than lying in wait.
                  undoStack.current = undoStack.current.filter((entry) => entry.path !== saved);
                  setUndoDepth(undoStack.current.length);
                }
                void refresh();
                if (saved) report({ chord: '⌘S', title: 'Save', detail: `${saved} saved as a pending change.` });
              }}
            />
          </Suspense>
        ) : (
          <Editor
            bundle={load.bundle}
            stack={stack}
            selectedIds={selectedIds}
            selectedEdgeIds={selectedEdgeIds}
            runStates={runStates}
            onDescend={descend}
            onAscend={ascend}
            onSelectionChange={(nodes, edgeIds) => {
              setSelectedIds(nodes);
              setSelectedEdgeIds(edgeIds);
            }}
            onRegisterActions={(actions) => {
              canvasActions.current = actions;
            }}
            onConnect={(edge) => void connectEdge(edge)}
            onRefuse={(reason) => report({ title: 'Connect', detail: reason, refused: true })}
            onMoveNode={(id, x, y) => void runOps([{ op: 'setLayout', id, x, y }], 'Move', { quiet: true })}
          />
        )}
        {/* One drawer at a time: they share the same strip of screen, and the run
            log — the more momentary of the two — wins while both are open. */}
        {activeRun && runLogOpen && current.kind !== 'code' ? (
          <RunLog
            status={activeRun.status}
            events={runEvents}
            onCancel={() => activeId && void cancelRun(activeId, activeRun.id).catch(() => undefined)}
            onClose={() => setRunLogOpen(false)}
          />
        ) : activeId && sessionLogOpen && appSession.phase !== 'idle' && current.kind !== 'code' ? (
          <SessionLog
            projectId={activeId}
            live={sessionActive}
            onClose={() => setSessionLogOpen(false)}
          />
        ) : null}
      </main>

      {previewOpen ? (
        <PreviewPane
          session={appSession}
          logsOpen={sessionLogOpen}
          onToggleLogs={() => setSessionLogOpen((v) => !v)}
          onStart={() => void beginSession()}
          onStop={() => void endSession()}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}

      <aside className="pane inspector">
        {settingsOpen ? (
          <Settings me={me} onClose={() => setSettingsOpen(false)} />
        ) : (
          <Inspector
            bundle={bundle}
            altitude={current}
            selectedIds={selectedIds}
            selectedEdgeIds={selectedEdgeIds}
            onPatch={(id, patch) => void runOps([{ op: 'updateNode', id, patch }], 'Edit', { quiet: true })}
            onPatchEdge={(id, patch) => void runOps([{ op: 'updateEdge', id, patch }], 'Edit', { quiet: true })}
            onRename={(from, to) =>
              void runOps([{ op: 'renameNode', from, to }], 'Rename', { quiet: true }).then((ok) => {
                // The selection follows the node to its new name — unless the user
                // has already selected something else mid-flight.
                if (ok) setSelectedIds((cur) => cur.map((id) => (id === from ? to : id)));
              })
            }
            // The inspector's remove buttons ask the same question the Delete key asks.
            onRemoveNode={(id) => setConfirming({ nodes: [id], edges: [] })}
            onRemoveEdge={(id) =>
              void runOps([{ op: 'removeEdge', id }], 'Disconnect', { quiet: true }).then((ok) => {
                if (ok) setSelectedEdgeIds((cur) => cur.filter((e) => e !== id));
              })
            }
          />
        )}
      </aside>
    </div>
  );
}
