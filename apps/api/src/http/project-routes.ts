import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { loadBundle } from '../project/bundle.js';
import { OverlaySource } from '../project/overlay.js';
import {
  ContentTooLargeError,
  deletePending,
  listPending,
  revertPending,
  savePending,
} from '../project/pending.js';
import { getProject, listProjects } from '../project/repository.js';
import { LocalSource, type ProjectSource } from '../project/source.js';

interface ProjectDeps {
  config: Config;
  pool: pg.Pool;
}

/**
 * PRD 6.1: the repo is the truth. Nothing here caches a parsed manifest — every
 * request reads the files again. "Anything Civil knows that git doesn't is a bug",
 * and a cache is precisely a thing Civil would know that git doesn't.
 */
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectDeps): void {
  const { pool } = deps;

  app.get('/api/projects', async (request) => ({
    projects: await listProjects(pool, request.identity.id),
  }));

  app.get('/api/projects/:id/bundle', async (request, reply) => {
    const { id } = request.params as { id: string };

    const project = await getProject(pool, request.identity.id, id);
    // 404 rather than 403 for a project owned by someone else: distinguishing them
    // would confirm the project exists to a stranger holding a guessed id.
    if (!project) return reply.code(404).send({ error: 'not_found' });

    let source: ProjectSource;
    if (project.sourceKind === 'local' && project.localPath) {
      source = new LocalSource(project.localPath);
    } else {
      // PRD 12's GitHub App is not wired yet; say so plainly rather than returning an
      // empty canvas that looks like a project with no nodes.
      return reply.code(501).send({
        error: 'source_unsupported',
        message: 'GitHub-backed projects arrive with the App installation.',
      });
    }

    if (!source.exists('.')) {
      return reply.code(410).send({
        error: 'source_missing',
        message: `The project directory ${project.localPath} is no longer readable.`,
      });
    }

    // Uncommitted work is applied as a source, so the validator and both canvases
    // see edited manifests without knowing pending edits exist.
    const pending = await listPending(pool, request.identity.id, project.id, project.defaultBranch);
    const overlay = new OverlaySource(source, pending);

    return {
      project: { id: project.id, name: project.name, defaultBranch: project.defaultBranch },
      ...loadBundle(overlay),
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
    if (!project || project.sourceKind !== 'local' || !project.localPath) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // Read through the overlay: opening a file you have edited must show the edit,
    // not the committed version.
    const base = new LocalSource(project.localPath);
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
  app.put('/api/projects/:id/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { path?: unknown; content?: unknown };
    if (typeof body?.path !== 'string' || typeof body?.content !== 'string') {
      return reply.code(400).send({ error: 'path_and_content_required' });
    }

    const project = await getProject(pool, request.identity.id, id);
    if (!project || project.sourceKind !== 'local' || !project.localPath) {
      return reply.code(404).send({ error: 'not_found' });
    }

    // The base source decides add versus modify, and rejects paths outside the
    // project before anything is written.
    const base = new LocalSource(project.localPath);

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
