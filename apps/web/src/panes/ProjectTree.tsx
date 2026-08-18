import { useMemo } from 'react';
import type { ProjectBundle } from '../project.js';

/**
 * PRD 7: left pane is the project tree and git status. PRD 6.1's layout is the shape
 * being rendered — manifests, graphs, agents, schemas, src, web.
 *
 * Git status arrives with M3, when there are pending changes to have a status about.
 */
export function ProjectTree({ bundle }: { bundle: ProjectBundle | undefined }) {
  const grouped = useMemo(() => groupByDirectory(bundle?.files ?? []), [bundle]);

  return (
    <>
      <div className="pane-title">Project</div>
      <div className="pane-body">
        {!bundle ? (
          <p className="muted">No project open.</p>
        ) : (
          <div className="tree-list">
            {grouped.map(([dir, files]) => (
              <div key={dir} className="tree-group">
                <div className="tree-dir">{dir === '' ? '/' : dir}</div>
                {files.map((file) => (
                  <div key={file} className="tree-file" title={file}>
                    {file.split('/').pop()}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
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
