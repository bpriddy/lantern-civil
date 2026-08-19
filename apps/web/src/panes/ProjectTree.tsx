import { useMemo } from 'react';
import type { ProjectBundle } from '../project.js';

/**
 * PRD 7: left pane is the project tree and git status. PRD 6.1's layout is the shape
 * being rendered — manifests, graphs, agents, schemas, src, web.
 *
 * Files open in Monaco. Before this they were labels, which meant a file with no node
 * pointing at it — a README, a CIVIL.md — could not be reached at all.
 */
export function ProjectTree({
  bundle,
  onOpenFile,
  onInitialize,
  initializing,
}: {
  bundle: ProjectBundle | undefined;
  onOpenFile: (path: string) => void;
  onInitialize: () => void;
  initializing: boolean;
}) {
  const grouped = useMemo(() => groupByDirectory(bundle?.files ?? []), [bundle]);

  const pending = useMemo(
    () => new Map((bundle?.pending ?? []).map((c) => [c.path, c.kind])),
    [bundle],
  );

  // A repository with no composition is not a Civil project yet. That is the one
  // state where the tree has something to offer besides a list of files.
  const needsCivil = bundle !== undefined && bundle.composition === undefined;

  return (
    <>
      <div className="pane-title">Project</div>
      <div className="pane-body">
        {!bundle ? (
          <p className="muted">No project open.</p>
        ) : (
          <>
            {needsCivil ? (
              <div className="add-civil">
                <button type="button" className="add-civil-button" onClick={onInitialize} disabled={initializing}>
                  {initializing ? 'Adding…' : 'Add Civil to this project'}
                </button>
                <p className="add-civil-note">
                  Creates <code>civil.yaml</code>, <code>app.yaml</code> and{' '}
                  <code>CIVIL.md</code> as pending changes. Nothing is committed until
                  you say so.
                </p>
              </div>
            ) : null}

            <div className="tree-list">
              {grouped.map(([dir, files]) => (
                <div key={dir} className="tree-group">
                  <div className="tree-dir">{dir === '' ? '/' : dir}</div>
                  {files.map((file) => {
                    const change = pending.get(file);
                    return (
                      <button
                        key={file}
                        type="button"
                        className={`tree-file${change ? ` is-${change}` : ''}`}
                        title={change ? `${file} — ${change}` : file}
                        onClick={() => onOpenFile(file)}
                      >
                        {change ? <span className="tree-mark">{markFor(change)}</span> : null}
                        {file.split('/').pop()}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** PRD 7's git status, as far as it goes before M3 has a diff view. */
function markFor(kind: string): string {
  switch (kind) {
    case 'add': return '+';
    case 'delete': return '−';
    case 'rename': return '→';
    default: return '•';
  }
}

function groupByDirectory(files: string[]): [string, string[]][] {
  const map = new Map<string, string[]>();
  for (const file of files) {
    const slash = file.lastIndexOf('/');
    const dir = slash === -1 ? '' : file.slice(0, slash);
    const list = map.get(dir) ?? [];
    list.push(file);
    map.set(dir, list);
  }
  // Root files first, then directories alphabetically — the manifests are what you
  // look for, and they live at the root.
  return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
}
