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
} from '../project/repository.js';
import { EXAMPLES, findExample, openExample } from '../project/examples.js';
import { LocalSource, type ProjectSource } from '../project/source.js';
import { GitHubApp, GitHubError } from '../github/app.js';
import { GitHubSource } from '../github/source.js';
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

/** A source that cannot be opened, carrying the status the client should see. */
class SourceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * PRD 6.1: the repo is the truth. Nothing here caches a parsed manifest — every
 * request reads the files again. "Anything Civil knows that git doesn't is a bug",
 * and a cache is precisely a thing Civil would know that git doesn't.
 */
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectDeps): void {
  const { config, pool } = deps;

  const githubApp = config.github
    ? new GitHubApp({ appId: config.github.appId, privateKey: config.github.privateKey })
    : undefined;

  /**
   * Resolves a project to the files it is a projection of.
   *
   * A project is a repository, whole. Civil does not open a subdirectory, which keeps
   * "what does app.yaml mean" answerable without a second notion of root — see
   * docs/prd-deltas.md.
   */
  async function openSource(ownerId: string, project: ProjectRow): Promise<ProjectSource> {
    let base: ProjectSource;

    if (project.sourceKind === 'example' && project.exampleSlug) {
      const example = openExample(project.exampleSlug);
      if (!example) {
        throw new SourceError(410, 'example_missing', 'That example is no longer bundled with Civil.');
      }
      base = example;
    } else if (project.sourceKind === 'local' && project.localPath) {
      base = new LocalSource(project.localPath);
    } else if (project.sourceKind === 'github' && project.repoOwner && project.repoName) {
      if (!githubApp) throw new SourceError(503, 'github_not_configured', 'GitHub is not configured on this server.');
      const connection = await getGitHubConnection(pool, ownerId);
      if (!connection?.installationId) {
        throw new SourceError(409, 'github_not_connected', 'Connect GitHub in settings first.');
      }
      try {
        base = await GitHubSource.load(
          githubApp,
          connection.installationId,
          project.repoOwner,
          project.repoName,
          project.defaultBranch,
        );
      } catch (error) {
        // Without this, a rate limit, a deleted branch, or a network blip surfaces
        // as an opaque 500 with nothing actionable in it. GitHub already said what
        // was wrong; pass it on.
        if (error instanceof GitHubError) {
          throw new SourceError(
            error.status === 404 ? 404 : 502,
            'github_unreachable',
            error.status === 404
              ? `${project.repoOwner}/${project.repoName} has no branch "${project.defaultBranch}", or the installation cannot see it.`
              : `GitHub could not be reached (${error.status}).`,
          );
        }
        throw error;
      }
    } else {
      throw new SourceError(500, 'source_unresolvable', 'This project does not name a readable source.');
    }

    return base;
  }

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
      throw error;
    }
  });

  /**
   * PRD 7.1: the client never constructs YAML. It posts ops, the server applies them
   * to the document, validates, and returns what changed.
   *
   * This is also the seam the command registry and the future agent both use — there
   * is one way to mutate a manifest, and it is this.
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

    return { path: change.path, kind: change.kind, summary: applied.summary };
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
