import { useEffect, useMemo, useState } from 'react';
import {
  fetchExamples,
  isAbortError,
  fetchRepositories,
  openExample,
  openRepository,
  removeProject,
  type ExampleDefinition,
  type ProjectSummary,
  type RepositorySummary,
} from '../project.js';

/**
 * Choosing what to work on. PRD 6.1 makes a project a projection of a repository, so
 * this is mostly a list of repositories — but which ones is GitHub's answer, not
 * Civil's: it asks the installation rather than assuming the account.
 *
 * Examples sit alongside them because a new account has no repositories connected yet
 * and an empty list is a dead end.
 */
export function ProjectPicker({
  projects,
  activeId,
  onSelect,
  onChanged,
  onClose,
}: {
  projects: ProjectSummary[];
  activeId: string | undefined;
  onSelect: (id: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [repos, setRepos] = useState<RepositorySummary[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [examples, setExamples] = useState<ExampleDefinition[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRepositories(controller.signal)
      .then((result) => {
        if ('error' in result) setReposError(result.error);
        else setRepos(result.repositories);
      })
      // An aborted load is a cancelled one, not a failed one.
      .catch((error: unknown) => {
        if (!isAbortError(error)) setReposError((error as Error).message);
      });

    void fetchExamples(controller.signal)
      .then(setExamples)
      .catch((error: unknown) => {
        if (!isAbortError(error)) setExamples([]);
      });
    return () => controller.abort();
  }, []);

  // Which repositories are already open, so the list can say so rather than letting
  // you "open" something twice and wonder why nothing happened.
  const openedRepos = useMemo(
    () => new Set(projects.filter((p) => p.repoOwner).map((p) => `${p.repoOwner}/${p.repoName}`)),
    [projects],
  );

  const visible = useMemo(() => {
    if (!repos) return [];
    const needle = filter.trim().toLowerCase();
    const matched = needle
      ? repos.filter((r) => r.fullName.toLowerCase().includes(needle))
      : repos;
    // 62 repositories is a scroll, not a decision. Filtering is the way through.
    return matched.slice(0, 40);
  }, [repos, filter]);

  const open = async (action: () => Promise<{ id: string }>, key: string) => {
    setBusy(key);
    try {
      const project = await action();
      onChanged();
      onSelect(project.id);
      onClose();
    } catch (error) {
      setReposError((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="picker">
      <div className="picker-head">
        <input
          autoFocus
          className="picker-filter"
          placeholder="Filter repositories…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="link" onClick={onClose}>close</button>
      </div>

      <div className="picker-body">
        {projects.length > 0 ? (
          <>
            <div className="picker-section">Open</div>
            {projects.map((project) => (
              <div key={project.id} className={`picker-row${project.id === activeId ? ' is-active' : ''}`}>
                <button type="button" className="picker-pick" onClick={() => { onSelect(project.id); onClose(); }}>
                  <span className="picker-name">{project.name}</span>
                  <span className="picker-meta">
                    {project.sourceKind === 'example'
                      ? 'example'
                      : `${project.repoOwner}/${project.repoName} · ${project.defaultBranch}`}
                  </span>
                </button>
                <button
                  type="button"
                  className="picker-remove"
                  title="Remove from Civil. The repository is untouched."
                  onClick={async () => {
                    await removeProject(project.id);
                    onChanged();
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </>
        ) : null}

        <div className="picker-section">Repositories</div>
        {reposError ? (
          <p className="muted picker-note">{reposError}</p>
        ) : repos === null ? (
          <p className="muted picker-note">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="muted picker-note">No repository matches “{filter}”.</p>
        ) : (
          visible.map((repo) => {
            const already = openedRepos.has(repo.fullName);
            return (
              <div key={repo.fullName} className="picker-row">
                <button
                  type="button"
                  className="picker-pick"
                  disabled={already || busy !== null}
                  onClick={() => void open(() => openRepository(repo), repo.fullName)}
                >
                  <span className="picker-name">{repo.fullName}</span>
                  <span className="picker-meta">
                    {repo.defaultBranch}
                    {repo.private ? ' · private' : ''}
                    {already ? ' · already open' : ''}
                  </span>
                </button>
              </div>
            );
          })
        )}

        {examples.length > 0 ? (
          <>
            <div className="picker-section">Examples</div>
            {examples.map((example) => (
              <div key={example.slug} className="picker-row">
                <button
                  type="button"
                  className="picker-pick"
                  disabled={busy !== null}
                  onClick={() => void open(() => openExample(example.slug), example.slug)}
                >
                  <span className="picker-name">{example.name}</span>
                  <span className="picker-meta">bundled with Civil</span>
                </button>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
