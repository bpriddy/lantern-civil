import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { CIVIL_THEME } from './monaco-setup.js';
import { fetchFile, saveFile, type FileContents } from '../project.js';

/**
 * PRD 7: "Double-click a code node or function-backed service → viewport takeover
 * with Monaco." A takeover rather than a panel, because PRD 1's navigation model puts
 * you INSIDE a context rather than looking at it — the same reason descending into a
 * subgraph replaces the canvas instead of opening a drawer.
 *
 * It brings its own file list, since the shell's tree is the project and this is one
 * node's slice of it.
 */

interface OpenFile {
  path: string;
  saved: string;
  draft: string;
  language: string;
}

export interface CodeContextProps {
  projectId: string;
  /** Files belonging to the node that was descended into, or opened from the tree. */
  files: string[];
  /** Which one to bring to the front. Set when the tree opens a file. */
  active?: string | undefined;
  /** Which file is in front, so the breadcrumb names what you are looking at. */
  onActiveChange?: (path: string) => void;
  onPendingChanged: (savedPath?: string) => void;
}

export function CodeContext({
  projectId,
  files,
  active,
  onActiveChange,
  onPendingChanged,
}: CodeContextProps) {
  const [openPath, setOpenPath] = useState<string | undefined>(active ?? files[0]);
  const [tabs, setTabs] = useState<Map<string, OpenFile>>(new Map());
  const [error, setError] = useState<string | null>(null);
  /** Paths already fetched, tracked outside state so loading cannot restart itself. */
  const loaded = useRef<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loaded.current = new Set();
    setTabs(new Map());
  }, [projectId]);

  // Told to the shell rather than kept here: the breadcrumb names where you are, and
  // switching tabs is moving.
  useEffect(() => {
    if (openPath) onActiveChange?.(openPath);
  }, [openPath, onActiveChange]);

  const current = openPath ? tabs.get(openPath) : undefined;
  const dirty = current ? current.draft !== current.saved : false;

  // Held in a ref so the keyboard handler does not need re-binding on every keystroke.
  const state = useRef({ projectId, openPath, tabs });
  state.current = { projectId, openPath, tabs };

  // Follow the file the shell asked for. Opening one from the tree while this is
  // already mounted has to bring it forward, or the tab appears and nothing changes.
  useEffect(() => {
    if (active && files.includes(active)) setOpenPath(active);
  }, [active, files]);

  // The component is reused when the file set changes, so state can be left pointing
  // at a file that is no longer here — which showed as a list that had changed and an
  // editor that had not.
  useEffect(() => {
    if (openPath && files.includes(openPath)) return;
    setOpenPath(active ?? files[0]);
  }, [files, openPath, active]);

  /**
   * Loads a file's contents once.
   *
   * `tabs` must not be a dependency here. Loading calls setTabs, which changes its
   * identity, which re-runs this effect, which aborts the fetch that was about to
   * populate it — an endless abort-and-retry that shows as an editor stuck on
   * "Opening…" and a view flickering between two files. Reading it through a ref asks
   * the same question without subscribing to the answer.
   */
  useEffect(() => {
    if (!openPath || loaded.current.has(openPath)) return;
    loaded.current.add(openPath);

    const controller = new AbortController();
    void fetchFile(projectId, openPath, controller.signal)
      .then((file: FileContents) => {
        setTabs((prev) =>
          new Map(prev).set(file.path, {
            path: file.path,
            saved: file.content,
            draft: file.content,
            language: file.language,
          }),
        );
      })
      .catch((e: unknown) => {
        // A cancelled load is retryable, so it must not stay marked as loaded.
        loaded.current.delete(openPath);
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [projectId, openPath]);

  const save = useCallback(async () => {
    const { projectId: id, openPath: path, tabs: open } = state.current;
    if (!path) return;
    const file = open.get(path);
    if (!file || file.draft === file.saved) return;

    setSaving(true);
    setError(null);
    try {
      await saveFile(id, path, file.draft);
      setTabs((prev) => {
        const next = new Map(prev);
        const entry = next.get(path);
        if (entry) next.set(path, { ...entry, saved: entry.draft });
        return next;
      });
      onPendingChanged(path.split('/').pop());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [onPendingChanged]);

  // Cmd/Ctrl+S is what everyone's hands already do. Monaco swallows it inside the
  // editor, so it is also bound there in onMount.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const onMount = useCallback<OnMount>((editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
  }, [save]);

  const openTabs = useMemo(() => [...tabs.keys()], [tabs]);

  /**
   * The file list is the contents of a code node — PRD 5 calls one "a named set of
   * files", and seeing that set is the point of descending into it. A single file
   * opened from the tree has no set to show, so a column listing one thing is noise
   * and an extra click.
   */
  const showFileList = files.length > 1;

  return (
    <div className={`code-context${showFileList ? '' : ' is-single'}`}>
      {showFileList ? (
      <aside className="code-files">
        <div className="code-files-title">Files</div>
        {files.length === 0 ? (
          <p className="muted" style={{ padding: '0 12px' }}>This node matches no files.</p>
        ) : (
          files.map((file) => (
            <button
              key={file}
              type="button"
              className={`code-file${file === openPath ? ' is-open' : ''}`}
              onClick={() => setOpenPath(file)}
              title={file}
            >
              {tabs.get(file) && tabs.get(file)!.draft !== tabs.get(file)!.saved ? (
                <span className="code-dirty" aria-label="unsaved">●</span>
              ) : null}
              {file.split('/').pop()}
            </button>
          ))
        )}
      </aside>
      ) : null}

      <div className="code-main">
        <div className="code-tabs">
          {openTabs.map((path) => {
            const entry = tabs.get(path)!;
            const dirty = entry.draft !== entry.saved;
            return (
              <span key={path} className={`code-tab${path === openPath ? ' is-active' : ''}`}>
                <button type="button" className="code-tab-pick" onClick={() => setOpenPath(path)}>
                  {dirty ? <span className="code-dirty">●</span> : null}
                  {path.split('/').pop()}
                </button>
                <button
                  type="button"
                  className="code-tab-close"
                  title={dirty ? 'Close. Unsaved edits are lost.' : 'Close'}
                  onClick={() => {
                    setTabs((prev) => {
                      const next = new Map(prev);
                      next.delete(path);
                      return next;
                    });
                    if (path === openPath) setOpenPath(openTabs.find((p) => p !== path));
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
          <span className="code-tabs-spacer" />
          {error ? <span className="code-error">{error}</span> : null}
          <button type="button" className="code-save" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>

        {current ? (
          <Editor
            key={current.path}
            theme={CIVIL_THEME}
            language={current.language}
            value={current.draft}
            onChange={(value) => {
              setTabs((prev) => {
                const next = new Map(prev);
                const entry = next.get(current.path);
                if (entry) next.set(current.path, { ...entry, draft: value ?? '' });
                return next;
              });
            }}
            onMount={onMount}
            options={{
              fontSize: 12,
              fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderWhitespace: 'selection',
              tabSize: 4,
              automaticLayout: true,
              padding: { top: 12 },
            }}
          />
        ) : (
          <div className="code-empty">{openPath ? 'Opening…' : 'Select a file.'}</div>
        )}
      </div>
    </div>
  );
}
