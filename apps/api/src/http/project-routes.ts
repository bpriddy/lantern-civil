import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Config } from '../config.js';
import { loadBundle } from '../project/bundle.js';
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

    return {
      project: { id: project.id, name: project.name, defaultBranch: project.defaultBranch },
      ...loadBundle(source),
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

    // LocalSource does the containment check; this only decides the status code.
    const content = new LocalSource(project.localPath).read(filePath);
    if (content === undefined) return reply.code(404).send({ error: 'file_not_found' });

    return { path: filePath, content, language: languageFor(filePath) };
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
