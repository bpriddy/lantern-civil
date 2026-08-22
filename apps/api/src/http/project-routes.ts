import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { applyOps, type ManifestOp } from '../manifest/apply.js';
import { ManifestEditError } from '../manifest/document.js';
import { loadBundle } from '../project/bundle.js';
import { OverlaySource } from '../project/overlay.js';
import {
  ContentTooLargeError,
  clearPending,
  deletePending,
  listPending,
  revertPending,
  savePending,
} from '../project/pending.js';
import {
  createGitHubProject,
  getProject,
  listProjects,
  openExampleProject,
  setHeadSha,
} from '../project/repository.js';
import { EXAMPLES, findExample, openExample } from '../project/examples.js';
import { scaffoldFiles } from '../project/scaffold.js';
import { writeThroughToSession } from './session-routes.js';
import { markPatternsStale } from '../project/transpile.js';
import { type ProjectSource } from '../project/source.js';
import { GitHubApp, GitHubError, describeGitHubError } from '../github/app.js';
import { GitHubSource } from '../github/source.js';
import { SourceError, openProjectSource } from '../project/open.js';
import {
  BranchMovedError,
  NothingToCommitError,
  commitPendingChanges,
} from '../github/commit.js';
import { getGitHubConnection } from '../project/connections.js';
import type { ProjectRow } from '../project/repository.js';

interface ProjectDeps {
  config: Config;
  pool: pg.Pool;
}

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectDeps): void {
  const { config, pool } = deps;

  const githubApp = config.github
    ? new GitHubApp({ appId: config.github.appId, privateKey: config.github.privateKey })
    : undefined;

  const openSource = (ownerId: string, project: ProjectRow): Promise<ProjectSource> =>
    openProjectSource({ pool, githubApp }, ownerId, project);

  app.get('/api/projects', async (request) => ({
    projects: await listProjects(pool, request.identity.id),
  }));

  /** The quickstarts bundled with Civil. */
  app.get('/api/examples', async () => ({ examples: EXAMPLES }));

  /** Opens a bundled example as a project of your own. */
  app.post('/api/examples/:slug/open', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const example = findExample(slug);
    if (!example) return reply.code(404).send({ error: 'unknown_example' });

    const project = await openExampleProject(pool, request.identity.id, slug, example.name);
    return reply.code(201).send({ project });
  });

  /** Opens a repository as a project. One project per repository. */
  app.post('/api/projects', async (request, reply) => {
    const body = request.body as {
      repoOwner?: unknown; repoName?: unknown; name?: unknown; branch?: unknown;
    };
    if (typeof body?.repoOwner !== 'string' || typeof body?.repoName !== 'string') {
      return reply.code(400).send({ error: 'repo_required' });
    }
    if (!githubApp) return reply.code(503).send({ error: 'github_not_configured' });

    const connection = await getGitHubConnection(pool, request.identity.id);
    if (!connection?.installationId) {
      return reply.code(409).send({ error: 'github_not_connected' });
    }

    // Confirm with GitHub that this installation reaches the repository, rather than
    // trusting what the client asked for.
    let repo: { default_branch: string };
    try {
      repo = await githubApp.asInstallation(
        connection.installationId,
        `/repos/${body.repoOwner}/${body.repoName}`,
      );
    } catch {
      return reply.code(404).send({
        error: 'repo_unreachable',
        message: 'That repository is not reachable by your GitHub installation.',
      });
    }

    const project = await createGitHubProject(pool, request.identity.id, {
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : body.repoName,
      repoOwner: body.repoOwner,
      repoName: body.repoName,
      defaultBranch: typeof body.branch === 'string' && body.branch ? body.branch : repo.default_branch,
      installationId: connection.installationId,
    });

    return reply.code(201).send({ project });
  });

  /**
   * Removing a project removes Civil's view of it, never the repository. Pending
   * changes go with it — they are Civil's own state and have nowhere else to live
   * once the project does not exist.
   */
  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    await pool.query('DELETE FROM projects WHERE id = $1 AND owner_id = $2', [
      project.id,
      request.identity.id,
    ]);
    return reply.code(204).send();
  });

  app.get('/api/projects/:id/bundle', async (request, reply) => {
    const { id } = request.params as { id: string };

    const project = await getProject(pool, request.identity.id, id);
    // 404 rather than 403 for a project owned by someone else: distinguishing them
    // would confirm the project exists to a stranger holding a guessed id.
    if (!project) return reply.code(404).send({ error: 'not_found' });

    let source: ProjectSource;
    try {
      source = await openSource(request.identity.id, project);
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }

    if (!source.exists('.')) {
      return reply.code(410).send({
        error: 'source_missing',
        message: 'The project source is no longer readable.',
      });
    }

    // Uncommitted work is applied as a source, so the validator and both canvases
    // see edited manifests without knowing pending edits exist.
    const pending = await listPending(pool, request.identity.id, project.id, project.defaultBranch);
    const overlay = new OverlaySource(source, pending);

    return {
      project: {
        id: project.id,
        name: project.name,
        defaultBranch: project.defaultBranch,
        // The client needs this to know whether committing is even possible.
        sourceKind: project.sourceKind,
      },
      ...(await loadBundle(overlay)),
      // PRD 7: the commit indicator shows a count, and the tree badges what changed.
      pending: pending.map((c) => ({ path: c.path, kind: c.kind, updatedAt: c.updatedAt })),
    };
  });

  // Raw file contents, for Monaco in M2 and the inspector's prompt view now.
  app.get('/api/projects/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const filePath = (request.query as Record<string, unknown>)['path'];
    if (typeof filePath !== 'string') {
      return reply.code(400).send({ error: 'path_required' });
    }

    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    // Read through the same resolution the canvas uses, so opening a file you have
    // edited shows the edit rather than the committed version.
    let base: ProjectSource;
    try {
      base = await openSource(request.identity.id, project);
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
    const pending = await listPending(pool, request.identity.id, project.id, project.defaultBranch);
    const overlay = new OverlaySource(base, pending);

    // Reads are sync; anything not prefetched — source files, mostly — is hydrated
    // here, once per commit. This is what lets Monaco open a .py the canvas never
    // needed.
    await overlay.ensure([filePath]);

    const content = overlay.read(filePath);
    if (content === undefined) return reply.code(404).send({ error: 'file_not_found' });

    return {
      path: filePath,
      content,
      language: languageFor(filePath),
      pending: pending.find((c) => c.path === filePath)?.kind ?? null,
    };
  });

  app.get('/api/projects/:id/pending', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    return {
      branch: project.defaultBranch,
      changes: await listPending(pool, request.identity.id, project.id, project.defaultBranch),
    };
  });

  /**
   * PRD 7: save writes a pending change. Nothing auto-commits — edits accumulate and
   * the commit indicator counts them.
   */
  /**
   * PRD 7: save writes a pending change. Nothing auto-commits — edits accumulate and
   * the commit indicator counts them.
   */
  app.put('/api/projects/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { path?: unknown; content?: unknown };
    if (typeof body?.path !== 'string' || typeof body?.content !== 'string') {
      return reply.code(400).send({ error: 'path_and_content_required' });
    }

    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    // The source decides add versus modify: a file absent at HEAD is an add, and
    // getting that wrong tells the committer to expect a blob that was never there.
    let base: ProjectSource;
    try {
      base = await openSource(request.identity.id, project);
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }

    try {
      const change = await savePending(pool, {
        ownerId: request.identity.id,
        projectId: project.id,
        branch: project.defaultBranch,
        path: body.path,
        content: body.content,
        existsAtHead: base.exists(body.path),
      });
      // A handwritten code save is one of the pattern analyzer's two triggers
      // (docs/emitted-code.md); civil documents and manifests are not code.
      if (/\.(py|tsx?|js)$/.test(body.path) && !body.path.startsWith('civil/')) {
        await markPatternsStale(pool, request.identity.id, project.id);
      }
      // The save is durable above; the running app hears about it here, or never
      // needs to (docs/app-session.md's two-tier rule — HMR is a side effect).
      await writeThroughToSession(config.sessionUrl, project.id, body.path, body.content);
      return { path: change.path, kind: change.kind, updatedAt: change.updatedAt };
    } catch (error) {
      if (error instanceof ContentTooLargeError) {
        return reply.code(413).send({ error: 'content_too_large', message: error.message });
      }
      throw error;
    }
  });

  /**
   * PRD 7: commits are explicit. Edits accumulate and nothing auto-commits, so this
   * is the only thing that writes to a repository.
   */
  app.post('/api/projects/:id/commit', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { message?: unknown };
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) return reply.code(400).send({ error: 'message_required' });

    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    // An example ships inside Civil and has no repository to commit to. Saying so is
    // better than a confusing failure deeper in the GitHub client.
    if (project.sourceKind !== 'github' || !project.repoOwner || !project.repoName) {
      return reply.code(409).send({
        error: 'not_committable',
        message:
          project.sourceKind === 'example'
            ? 'Examples have no repository. Open one of your own to commit.'
            : 'This project has no GitHub repository.',
      });
    }

    if (!githubApp) return reply.code(503).send({ error: 'github_not_configured' });
    const connection = await getGitHubConnection(pool, request.identity.id);
    if (!connection?.installationId) return reply.code(409).send({ error: 'github_not_connected' });

    const changes = await listPending(pool, request.identity.id, project.id, project.defaultBranch);
    if (changes.length === 0) return reply.code(409).send({ error: 'nothing_to_commit' });

    try {
      const result = await commitPendingChanges(githubApp, {
        installationId: connection.installationId,
        owner: project.repoOwner,
        repo: project.repoName,
        branch: project.defaultBranch,
        message,
        changes,
        // The owner's rule: the Civil UI is canon. A branch that moved is re-parented
        // rather than refused, which keeps Civil's version of the files it touched
        // without discarding anything that landed in between.
        onBranchMoved: 'reparent',
      });

      // Only after the ref moved. Clearing first would lose the edits if the commit
      // failed, and these rows are the only copy.
      await clearPending(pool, request.identity.id, project.id, project.defaultBranch);

      // Civil is now editing against what it just wrote. Without this the next read
      // would serve the tree from before the commit.
      await setHeadSha(pool, request.identity.id, project.id, result.commitSha);

      request.log.info(
        { projectId: project.id, commit: result.commitSha, files: changes.length },
        'committed',
      );
      return {
        commit: result.commitSha,
        url: result.url,
        files: changes.length,
        // Surfaced rather than silent: the author should know their commit landed on
        // top of work that arrived while they were editing.
        reparentedOnto: result.reparentedOnto ?? null,
      };
    } catch (error) {
      if (error instanceof BranchMovedError) {
        // The pending rows are deliberately left alone: the work still exists and the
        // author decides what to do with it.
        return reply.code(409).send({
          error: 'branch_moved',
          message: error.message,
          currentSha: error.currentSha,
        });
      }
      if (error instanceof NothingToCommitError) {
        return reply.code(409).send({ error: 'nothing_to_commit' });
      }
      if (error instanceof GitHubError) {
        const described = describeGitHubError(error);
        request.log.warn({ err: error }, 'commit failed at GitHub');
        return reply.code(described.status).send({ error: described.code, message: described.message });
      }
      throw error;
    }
  });

  /**
   * Picks up whatever has been pushed since.
   *
   * Civil edits against a pinned commit, so it does not notice external pushes on its
   * own — deliberately. Constantly re-checking is what made browsing a project cost a
   * GitHub call per interaction, and a repository the user is not sharing does not
   * move on its own. Advancing is therefore something you ask for.
   *
   * Pending changes are left alone. They are edits to files, not to a commit, and
   * their base_blob_sha is what detects whether the file underneath them moved.
   */
  app.post('/api/projects/:id/sync', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    if (project.sourceKind !== 'github' || !project.repoOwner || !project.repoName) {
      return reply.code(409).send({
        error: 'not_syncable',
        message: 'Only a repository-backed project has anything to sync with.',
      });
    }
    if (!githubApp) return reply.code(503).send({ error: 'github_not_configured' });

    const connection = await getGitHubConnection(pool, request.identity.id);
    if (!connection?.installationId) return reply.code(409).send({ error: 'github_not_connected' });

    try {
      const latest = await GitHubSource.resolveHead(
        githubApp,
        connection.installationId,
        project.repoOwner,
        project.repoName,
        project.defaultBranch,
      );

      const moved = latest !== project.headSha;
      if (moved) await setHeadSha(pool, request.identity.id, project.id, latest);

      return {
        headSha: latest,
        moved,
        summary: moved
          ? `Updated to ${latest.slice(0, 8)}.`
          : `Already at ${latest.slice(0, 8)}.`,
      };
    } catch (error) {
      if (error instanceof GitHubError) {
        const described = describeGitHubError(error);
        return reply.code(described.status).send({ error: described.code, message: described.message });
      }
      throw error;
    }
  });

  /**
   * Adds Civil to a repository that does not have it yet.
   *
   * Written as pending changes rather than committed, so the scaffold is reviewed and
   * committed like any other edit (PRD 7: nothing auto-commits).
   */
  app.post('/api/projects/:id/initialize', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    let base: ProjectSource;
    try {
      base = await openSource(request.identity.id, project);
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }

    const pending = await listPending(pool, request.identity.id, project.id, project.defaultBranch);
    const overlay = new OverlaySource(base, pending);

    // Refuse rather than overwrite. A repository that already has a civil.yaml is a
    // Civil project, and replacing it would discard whatever it says.
    if (overlay.exists('civil.yaml')) {
      return reply.code(409).send({
        error: 'already_initialized',
        message: 'This repository already has a civil.yaml.',
      });
    }

    const written: string[] = [];
    for (const file of scaffoldFiles(project.name)) {
      // Never clobber a file that is already there — a repository may well have its
      // own CIVIL.md or app.yaml for unrelated reasons.
      if (overlay.exists(file.path)) continue;
      await savePending(pool, {
        ownerId: request.identity.id,
        projectId: project.id,
        branch: project.defaultBranch,
        path: file.path,
        content: file.content,
        existsAtHead: false,
      });
      written.push(file.path);
    }

    return { files: written, summary: `Added ${written.join(', ')} as pending changes.` };
  });

  /**
   * PRD 7.1: the client never constructs YAML. It posts ops, the server applies them
   * to the document, and returns what changed.
   *
   * This is also the seam the command registry and the future agent both use — there
   * is one way to mutate a manifest, and it is this.
   *
   * Note what this route does *not* do: it does not validate the result. An op is
   * refused only when it cannot be applied to the text at all. A structurally legal
   * edit that produces an invalid project is saved, and the diagnostics appear when
   * the bundle is next built — which is PRD 6.4's rule that a cycle "marks it red,
   * blocks Run, doesn't fail the save". The client refreshes the bundle after every
   * op, so the red arrives in the same beat, but it arrives from there and not here.
   */
  app.post('/api/projects/:id/ops', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { path?: unknown; ops?: unknown };
    if (typeof body?.path !== 'string' || !Array.isArray(body?.ops) || body.ops.length === 0) {
      return reply.code(400).send({ error: 'path_and_ops_required' });
    }

    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    let base: ProjectSource;
    try {
      base = await openSource(request.identity.id, project);
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }

    // Ops apply on top of pending work, not on top of HEAD: editing twice before
    // committing must build on the first edit rather than discard it.
    const pending = await listPending(pool, request.identity.id, project.id, project.defaultBranch);
    const overlay = new OverlaySource(base, pending);

    const current = overlay.read(body.path);
    if (current === undefined) {
      return reply.code(404).send({ error: 'manifest_not_found', message: `${body.path} could not be read.` });
    }

    let applied;
    try {
      applied = applyOps(current, body.ops as ManifestOp[]);
    } catch (error) {
      if (error instanceof ManifestEditError) {
        return reply.code(422).send({ error: 'op_refused', message: error.message });
      }
      throw error;
    }

    const change = await savePending(pool, {
      ownerId: request.identity.id,
      projectId: project.id,
      branch: project.defaultBranch,
      path: body.path,
      content: applied.source,
      existsAtHead: base.exists(body.path),
    });

    return {
      path: change.path,
      kind: change.kind,
      summary: applied.summary,
      // What the file said before this application, and whether that state was
      // itself a pending edit. Together they are exactly what undoing this op needs:
      // restore `previous` as a pending change, or discard the pending row entirely
      // when the op was the first thing to touch the file.
      previous: current,
      hadPending: pending.some((p) => p.path === body.path),
    };
  });

  /**
   * PRD 7: the commit indicator shows "a count and a diff preview". This is the
   * preview's data — for every pending change, what HEAD says and what the pending
   * edit says, side by side. Rendering the difference is the client's job; deciding
   * what is different is not, because only this side can see HEAD.
   *
   * It is also CLAUDE.md's fifth agent-first constraint made concrete: everything an
   * agent could do to a project surfaces here as inspectable before-and-after text
   * before any of it reaches the repository.
   */
  app.get('/api/projects/:id/diff', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    let base: ProjectSource;
    try {
      base = await openSource(request.identity.id, project);
    } catch (error) {
      if (error instanceof SourceError) {
        return reply.code(error.status).send({ error: error.code, message: error.message });
      }
      throw error;
    }

    const pending = await listPending(pool, request.identity.id, project.id, project.defaultBranch);
    // The base half of each diff can be a source file outside the manifest
    // prefetch; hydrate them so "original" is the text and not a blank pane.
    await base.ensure?.(pending.map((change) => change.path));
    return {
      branch: project.defaultBranch,
      files: pending.map((change) => ({
        path: change.path,
        kind: change.kind,
        base: base.exists(change.path) ? (base.read(change.path) ?? null) : null,
        current: change.kind === 'delete' ? null : change.content,
      })),
    };
  });

  /** Discards a pending edit; the file reverts to whatever HEAD says. */
  app.delete('/api/projects/:id/pending', async (request, reply) => {
    const { id } = request.params as { id: string };
    const filePath = (request.query as Record<string, unknown>)['path'];
    if (typeof filePath !== 'string') return reply.code(400).send({ error: 'path_required' });

    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    const reverted = await revertPending(
      pool, request.identity.id, project.id, project.defaultBranch, filePath,
    );
    return reply.code(reverted ? 204 : 404).send();
  });

  /** Marks a committed file for deletion. Distinct from discarding an edit. */
  app.post('/api/projects/:id/file/delete', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { path?: unknown };
    if (typeof body?.path !== 'string') return reply.code(400).send({ error: 'path_required' });

    const project = await getProject(pool, request.identity.id, id);
    if (!project) return reply.code(404).send({ error: 'not_found' });

    await deletePending(pool, request.identity.id, project.id, project.defaultBranch, body.path);
    return reply.code(204).send();
  });
}

/** Enough for Monaco to pick a grammar. PRD 15 makes Python the only parsed one. */
function languageFor(file: string): string {
  switch (path.extname(file)) {
    case '.py':
      return 'python';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.json':
      return 'json';
    case '.md':
      return 'markdown';
    case '.ts':
    case '.tsx':
      return 'typescript';
    default:
      return 'plaintext';
  }
}
