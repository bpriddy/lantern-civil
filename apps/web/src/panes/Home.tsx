import { useEffect, useMemo, useState } from 'react';
import {
  fetchExamples,
  fetchRepositories,
  openExample,
  openRepository,
  removeProject,
  type ExampleDefinition,
  type ProjectSummary,
  type RepositorySummary,
} from '../project.js';
import { type Me } from '../identity.js';

/**
 * Where you land.
 *
 * Civil used to open whichever project was remembered, which meant a new account
 * arrived inside an example it had not chosen and an existing one had no way back
 * out. A project is a place you go, so there has to be somewhere to go from.
 */
export function Home({
  me,
  projects,
  onOpen,
  onChanged,
  onOpenSettings,
}: {
  me: Me;
  projects: ProjectSummary[];
  onOpen: (id: string) => void;
  onChanged: () => Promise<ProjectSummary[]> | void;
  onOpenSettings: () => void;
}) {
  const [repos, setRepos] = useState<RepositorySummary[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [examples, setExamples] = useState<ExampleDefinition[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchRepositories(controller.signal).then((result) => {
      if ('error' in result) setReposError(result.error);
      else setRepos(result.repositories);
    });
    void fetchExamples(controller.signal).then(setExamples).catch(() => setExamples([]));
    return () => controller.abort();
  }, []);

  const opened = useMemo(
    () => new Set(projects.filter((p) => p.repoOwner).map((p) => `${p.repoOwner}/${p.repoName}`)),
    [projects],
  );

  const visible = useMemo(() => {
    if (!repos) return [];
    const needle = filter.trim().toLowerCase();
    return (needle ? repos.filter((r) => r.fullName.toLowerCase().includes(needle)) : repos).slice(0, 30);
  }, [repos, filter]);

  const open = async (action: () => Promise<{ id: string }>, key: string) => {
    setBusy(key);
    try {
      const project = await action();
      await onChanged();
      onOpen(project.id);
    } catch (error) {
      setReposError((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="home">
      <header className="home-top">
        <span className="brand">Civil</span>
        <span className="home-tagline">A web IDE for building applications at graph altitude.</span>
        <span className="spacer" />
        <button type="button" className="link" onClick={onOpenSettings}>settings</button>
        <span className="home-account">{me.email}</span>
      </header>

      <div className="home-body">
        <section className="home-section">
          <h2 className="home-heading">Your projects</h2>
          {projects.length === 0 ? (
            <p className="muted">
              Nothing open yet. Open a repository below, or start from an example.
            </p>
          ) : (
            <div className="home-grid">
              {projects.map((project) => (
                <div key={project.id} className="home-card">
                  <button type="button" className="home-card-open" onClick={() => onOpen(project.id)}>
                    <span className="home-card-name">{project.name}</span>
                    <span className="home-card-meta">
                      {project.sourceKind === 'example'
                        ? 'example · bundled with Civil'
                        : `${project.repoOwner}/${project.repoName} · ${project.defaultBranch}`}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="home-card-remove"
                    title="Remove from Civil. The repository is untouched."
                    onClick={async () => {
                      await removeProject(project.id);
                      await onChanged();
                    }}
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="home-section">
          <h2 className="home-heading">
            Open a repository
            {repos ? <span className="home-count">{repos.length}</span> : null}
          </h2>

          {reposError ? (
            <div className="home-connect">
              <p className="muted">{reposError}</p>
              <button type="button" className="connect" onClick={onOpenSettings}>
                Connect GitHub
              </button>
            </div>
          ) : (
            <>
              <input
                className="picker-filter home-filter"
                placeholder="Filter repositories…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {repos === null ? (
                <p className="muted">Loading…</p>
              ) : (
                <div className="home-grid">
                  {visible.map((repo) => {
                    const already = opened.has(repo.fullName);
                    return (
                      <button
                        key={repo.fullName}
                        type="button"
                        className="home-card home-card-open"
                        disabled={already || busy !== null}
                        onClick={() => void open(() => openRepository(repo), repo.fullName)}
                      >
                        <span className="home-card-name">{repo.fullName}</span>
                        <span className="home-card-meta">
                          {repo.defaultBranch}
                          {repo.private ? ' · private' : ''}
                          {already ? ' · already open' : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>

        {examples.length > 0 ? (
          <section className="home-section">
            <h2 className="home-heading">Start from an example</h2>
            <div className="home-grid">
              {examples.map((example) => (
                <button
                  key={example.slug}
                  type="button"
                  className="home-card home-card-open"
                  disabled={busy !== null}
                  onClick={() => void open(() => openExample(example.slug), example.slug)}
                >
                  <span className="home-card-name">{example.name}</span>
                  <span className="home-card-meta">{example.description}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
