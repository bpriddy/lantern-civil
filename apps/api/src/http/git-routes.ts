import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { GitHubApp, GitHubError, describeGitHubError } from '../github/app.js';
import { getGitHubConnection } from '../project/connections.js';
import { getProject, type ProjectRow } from '../project/repository.js';

/**
 * The source-control panel's reads (owner's rule, 2026-10-01: no automated git
 * interactions, and very visible UI to control the git flow). Nothing here writes.
 *
 * Two kinds of read, deliberately separate:
 * - GET .../git describes the commit the author is editing against — its message,
 *   author, and history. That commit is pinned, so every answer is immutable per
 *   sha and cached.
 * - POST .../git/check asks GitHub whether the branch has moved since. It is the
 *   only call that looks at the remote's present, and it runs only when the author
 *   presses Check — nothing polls.
 */

export interface GitCommit {
  sha: string;
  /** The first line only — the panel is a summary. */
  message: string;
  author: string;
  date: string;
  url: string;
}

interface GitDeps {
  config: Config;
  pool: pg.Pool;
}

export interface GitHubCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name?: string; date?: string } | null };
}

const HISTORY_LENGTH = 10;
const CHECK_LIST_LENGTH = 20;
/** Entries are immutable per sha; the cap only bounds memory on a long-lived instance. */
const CACHE_LIMIT = 200;

export const toCommit = (c: GitHubCommit): GitCommit => ({
  sha: c.sha,
  message: c.commit.message.split('\n', 1)[0] ?? '',
  author: c.commit.author?.name ?? 'unknown',
  date: c.commit.author?.date ?? '',
  url: c.html_url,
});

export interface CheckResult {
  /** The branch's tip on GitHub now; null when the branch does not exist yet. */
  tip: string | null;
  /** The commit the author is editing against. */
  head: string | null;
  /** Commits on the branch the author does not have; null when unknowable. */
  behind: number | null;
  diverged: boolean;
  /** The newest first, at most CHECK_LIST_LENGTH. */
  commits: GitCommit[];
}

/** GitHub's compare answer, reduced to what the panel says. Pure, so it is tested. */
export function shapeCheck(
  head: string | null,
  tip: string | null,
  compare?: { status: string; ahead_by: number; commits: GitHubCommit[] },
): CheckResult {
  if (tip === null) return { tip, head, behind: 0, diverged: false, commits: [] };
  if (tip === head) return { tip, head, behind: 0, diverged: false, commits: [] };
  if (!head || !compare) return { tip, head, behind: null, diverged: false, commits: [] };
  return {
    tip,
    head,
    behind: compare.ahead_by,
    // History was rewritten under the pinned head (a force push): sync still works,
    // but the author should know their base is gone from the branch.
    diverged: compare.status === 'diverged',
    commits: compare.commits.slice(-CHECK_LIST_LENGTH).reverse().map(toCommit),
  };
}

export function registerGitRoutes(app: FastifyInstance, deps: GitDeps): void {
  const { config, pool } = deps;
  const githubApp = config.github
    ? new GitHubApp({ appId: config.github.appId, privateKey: config.github.privateKey })
    : undefined;
  const historyCache = new Map<string, GitCommit[]>();

  /** The project and an installation to read it with, or the reason there is none. */
  const resolve = async (
    ownerId: string,
    id: string,
  ): Promise<
    | { ok: true; project: ProjectRow & { repoOwner: string; repoName: string }; installationId: string }
    | { ok: false; status: number; body: Record<string, unknown> }
  > => {
    const project = await getProject(pool, ownerId, id);
    if (!project) return { ok: false, status: 404, body: { error: 'not_found' } };
    if (project.sourceKind !== 'github' || !project.repoOwner || !project.repoName) {
      return { ok: false, status: 409, body: { error: 'no_repository', sourceKind: project.sourceKind } };
    }
    if (!githubApp) return { ok: false, status: 503, body: { error: 'github_not_configured' } };
    const connection = await getGitHubConnection(pool, ownerId);
    if (!connection?.installationId) return { ok: false, status: 409, body: { error: 'github_not_connected' } };
    return {
      ok: true,
      project: project as ProjectRow & { repoOwner: string; repoName: string },
      installationId: String(connection.installationId),
    };
  };

  const sendGitHubError = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    if (!(error instanceof GitHubError)) throw error;
    const described = describeGitHubError(error);
    return reply.code(described.status).send({ error: described.code, message: described.message });
  };

  app.get('/api/projects/:id/git', async (request, reply) => {
    const { id } = request.params as { id: string };
    const resolved = await resolve(request.identity.id, id);
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body);
    const { project, installationId } = resolved;

    const repo = {
      owner: project.repoOwner,
      name: project.repoName,
      url: `https://github.com/${project.repoOwner}/${project.repoName}`,
    };
    const base = { repo, branch: project.defaultBranch };
    // No pinned head: an empty repository, or one not opened yet. Nothing to describe.
    if (!project.headSha) return { ...base, head: null, history: [] };

    const key = `${project.repoOwner}/${project.repoName}@${project.headSha}`;
    let history = historyCache.get(key);
    if (!history) {
      try {
        const commits = await githubApp!.asInstallation<GitHubCommit[]>(
          installationId,
          `/repos/${project.repoOwner}/${project.repoName}/commits?sha=${project.headSha}&per_page=${HISTORY_LENGTH}`,
        );
        history = commits.map(toCommit);
      } catch (error) {
        return sendGitHubError(reply, error);
      }
      if (historyCache.size >= CACHE_LIMIT) historyCache.delete(historyCache.keys().next().value!);
      historyCache.set(key, history);
    }
    return { ...base, head: history[0] ?? null, history };
  });

  app.post('/api/projects/:id/git/check', async (request, reply) => {
    const { id } = request.params as { id: string };
    const resolved = await resolve(request.identity.id, id);
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body);
    const { project, installationId } = resolved;
    const repoPath = `/repos/${project.repoOwner}/${project.repoName}`;

    try {
      let tip: string;
      try {
        const ref = await githubApp!.asInstallation<{ object: { sha: string } }>(
          installationId,
          `${repoPath}/git/ref/heads/${encodeURIComponent(project.defaultBranch)}`,
        );
        tip = ref.object.sha;
      } catch (error) {
        // An empty repository or a branch not created yet: nothing has landed.
        if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) {
          return shapeCheck(project.headSha, null);
        }
        throw error;
      }
      if (tip === project.headSha || !project.headSha) return shapeCheck(project.headSha, tip);

      const compare = await githubApp!.asInstallation<{
        status: 'ahead' | 'behind' | 'diverged' | 'identical';
        ahead_by: number;
        commits: GitHubCommit[];
      }>(installationId, `${repoPath}/compare/${project.headSha}...${tip}`);
      return shapeCheck(project.headSha, tip, compare);
    } catch (error) {
      return sendGitHubError(reply, error);
    }
  });
}
