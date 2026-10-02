import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { GitHubApp, GitHubError, describeGitHubError } from '../github/app.js';
import { getGitHubConnection } from '../project/connections.js';
import { movePending } from '../project/pending.js';
import {
  getProject,
  listProjectBranches,
  setBranchPr,
  switchBranch,
  type ProjectRow,
} from '../project/repository.js';
import { GitHubSource } from '../github/source.js';

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

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  /** open, closed, or merged — GitHub reports merged as a closed state plus a flag. */
  state: 'open' | 'closed' | 'merged';
}

/**
 * A branch name git and GitHub will both accept, conservatively: path-like segments
 * of letters, digits, and . _ -, nothing git reserves (.., @{, a trailing .lock).
 */
export function validBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) &&
    !name.includes('..') &&
    !name.startsWith('-') &&
    !name.split('/').some((seg) => seg.startsWith('.') || seg.endsWith('.lock')) &&
    name.length <= 200
  );
}

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
  /** The branch's pull request as GitHub has it now, when one was opened. */
  pr?: PullRequest | null;
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

  /** The branch's pull request now — read as part of Check, never on its own. */
  const prStatus = async (
    project: ProjectRow & { repoOwner: string; repoName: string },
    installationId: string,
  ): Promise<PullRequest | null> => {
    if (!project.prNumber) return null;
    const pr = await githubApp!.asInstallation<{
      number: number; html_url: string; title: string; state: 'open' | 'closed'; merged: boolean;
    }>(installationId, `/repos/${project.repoOwner}/${project.repoName}/pulls/${project.prNumber}`);
    return { number: pr.number, url: pr.html_url, title: pr.title, state: pr.merged ? 'merged' : pr.state };
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
    const base = {
      repo,
      branch: project.branch,
      defaultBranch: project.defaultBranch,
      // Where this branch's pull request goes: the branch it was cut from.
      baseBranch: project.branch === project.defaultBranch ? null : (project.baseBranch ?? project.defaultBranch),
      pr: project.prNumber
        ? { number: project.prNumber, url: `${repo.url}/pull/${project.prNumber}` }
        : null,
    };
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
          `${repoPath}/git/ref/heads/${encodeURIComponent(project.branch)}`,
        );
        tip = ref.object.sha;
      } catch (error) {
        // An empty repository or a branch not created yet: nothing has landed.
        if (error instanceof GitHubError && (error.status === 404 || error.status === 409)) {
          return { ...shapeCheck(project.headSha, null), pr: await prStatus(project, installationId) };
        }
        throw error;
      }
      if (tip === project.headSha || !project.headSha) {
        return { ...shapeCheck(project.headSha, tip), pr: await prStatus(project, installationId) };
      }

      const compare = await githubApp!.asInstallation<{
        status: 'ahead' | 'behind' | 'diverged' | 'identical';
        ahead_by: number;
        commits: GitHubCommit[];
      }>(installationId, `${repoPath}/compare/${project.headSha}...${tip}`);
      return { ...shapeCheck(project.headSha, tip, compare), pr: await prStatus(project, installationId) };
    } catch (error) {
      return sendGitHubError(reply, error);
    }
  });

  /** GitHub's branches, merged with what Civil knows of each. Read when the menu opens. */
  app.get('/api/projects/:id/branches', async (request, reply) => {
    const { id } = request.params as { id: string };
    const resolved = await resolve(request.identity.id, id);
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body);
    const { project, installationId } = resolved;
    try {
      const remote = await githubApp!.asInstallation<{ name: string; commit: { sha: string } }[]>(
        installationId,
        `/repos/${project.repoOwner}/${project.repoName}/branches?per_page=100`,
      );
      const known = new Map((await listProjectBranches(pool, request.identity.id, project.id)).map((b) => [b.name, b]));
      const names = [...new Set([...remote.map((b) => b.name), ...known.keys()])].sort((a, b) =>
        a === project.defaultBranch ? -1 : b === project.defaultBranch ? 1 : a < b ? -1 : a > b ? 1 : 0,
      );
      return {
        current: project.branch,
        defaultBranch: project.defaultBranch,
        branches: names.map((name) => ({
          name,
          isDefault: name === project.defaultBranch,
          onGitHub: remote.some((b) => b.name === name),
          pending: known.get(name)?.pending ?? 0,
          prNumber: known.get(name)?.prNumber ?? null,
        })),
      };
    } catch (error) {
      return sendGitHubError(reply, error);
    }
  });

  /**
   * Creates a branch on GitHub at the commit the author is on, carries their pending
   * edits onto it, and switches to it — git's "checkout -b". Its pull request will
   * go back into the branch it was cut from.
   */
  app.post('/api/projects/:id/branches', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: unknown; carry?: unknown };
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!validBranchName(name)) {
      return reply.code(400).send({
        error: 'bad_branch_name',
        message: 'Use letters, digits, and . _ - / — for example feature/save-record.',
      });
    }
    const resolved = await resolve(request.identity.id, id);
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body);
    const { project, installationId } = resolved;
    if (!project.headSha) {
      return reply.code(409).send({ error: 'no_head', message: 'Commit once before branching — the repository is empty.' });
    }
    try {
      await githubApp!.asInstallation(installationId, `/repos/${project.repoOwner}/${project.repoName}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${name}`, sha: project.headSha }),
      });
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) {
        return reply.code(409).send({ error: 'branch_exists', message: `${name} already exists — switch to it instead.` });
      }
      return sendGitHubError(reply, error);
    }
    const carried = body.carry === false ? 0 : await movePending(pool, request.identity.id, project.id, project.branch, name);
    await switchBranch(pool, request.identity.id, project.id, {
      name,
      headSha: project.headSha,
      baseBranch: project.branch,
    });
    return {
      branch: name,
      carried,
      summary:
        `Created ${name} from ${project.branch} at ${project.headSha.slice(0, 7)} and switched to it` +
        (carried ? `, bringing ${carried} pending change${carried === 1 ? '' : 's'}.` : '.'),
    };
  });

  /**
   * Switches the branch the author works on. Pending edits stay with the branch they
   * were made on — switching back finds them. A branch Civil has worked on returns to
   * the commit it was pinned at; moving it forward is Sync's job, never a side effect.
   */
  app.post('/api/projects/:id/branches/switch', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: unknown };
    const name = typeof body?.name === 'string' ? body.name : '';
    if (!validBranchName(name)) return reply.code(400).send({ error: 'bad_branch_name' });
    const resolved = await resolve(request.identity.id, id);
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body);
    const { project, installationId } = resolved;
    if (name === project.branch) return { branch: name, summary: `Already on ${name}.` };

    const known = (await listProjectBranches(pool, request.identity.id, project.id)).find((b) => b.name === name);
    let headSha: string | null = null;
    if (!known?.headSha) {
      try {
        headSha = await GitHubSource.resolveHead(githubApp!, installationId, project.repoOwner, project.repoName, name);
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) {
          return reply.code(404).send({ error: 'no_such_branch', message: `${name} does not exist on GitHub.` });
        }
        return sendGitHubError(reply, error);
      }
    }
    await switchBranch(pool, request.identity.id, project.id, {
      name,
      headSha,
      baseBranch: name === project.defaultBranch ? null : project.defaultBranch,
    });
    const aside = (await listProjectBranches(pool, request.identity.id, project.id)).find((b) => b.name === project.branch)?.pending ?? 0;
    return {
      branch: name,
      summary:
        `Switched to ${name}.` +
        (aside ? ` ${aside} pending change${aside === 1 ? '' : 's'} stay on ${project.branch}.` : ''),
    };
  });

  /** Opens a pull request from the current branch into the branch it was cut from. */
  app.post('/api/projects/:id/pulls', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: unknown; body?: unknown };
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title) return reply.code(400).send({ error: 'title_required' });
    const resolved = await resolve(request.identity.id, id);
    if (!resolved.ok) return reply.code(resolved.status).send(resolved.body);
    const { project, installationId } = resolved;
    const base = project.baseBranch ?? project.defaultBranch;
    if (project.branch === base) {
      return reply.code(409).send({ error: 'same_branch', message: `You are on ${base}; create a branch to propose changes from.` });
    }
    const repoPath = `/repos/${project.repoOwner}/${project.repoName}`;
    try {
      const pr = await githubApp!.asInstallation<{ number: number; html_url: string }>(installationId, `${repoPath}/pulls`, {
        method: 'POST',
        body: JSON.stringify({
          title,
          head: project.branch,
          base,
          ...(typeof body.body === 'string' && body.body.trim() ? { body: body.body.trim() } : {}),
        }),
      });
      await setBranchPr(pool, request.identity.id, project.id, project.branch, pr.number);
      return { number: pr.number, url: pr.html_url, summary: `Opened pull request #${pr.number} into ${base}.` };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) {
        // Either nothing to propose, or a PR already exists for this branch — find it.
        const open = await githubApp!.asInstallation<{ number: number; html_url: string }[]>(
          installationId,
          `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${project.repoOwner}:${project.branch}`)}`,
        ).catch(() => []);
        if (open[0]) {
          await setBranchPr(pool, request.identity.id, project.id, project.branch, open[0].number);
          return { number: open[0].number, url: open[0].html_url, summary: `Pull request #${open[0].number} is already open.` };
        }
        return reply.code(409).send({
          error: 'nothing_to_propose',
          message: `${project.branch} has no commits that ${base} does not — commit first.`,
        });
      }
      if (error instanceof GitHubError && error.status === 403) {
        return reply.code(403).send({
          error: 'pr_permission',
          message: 'The Civil GitHub App needs "Pull requests: Read & write" to open pull requests.',
        });
      }
      return sendGitHubError(reply, error);
    }
  });
}
