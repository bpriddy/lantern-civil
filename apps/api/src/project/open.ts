import type pg from 'pg';
import { GitHubApp, GitHubError, describeGitHubError } from '../github/app.js';
import { GitHubSource } from '../github/source.js';
import { getGitHubConnection } from './connections.js';
import { openExample } from './examples.js';
import { setHeadSha, type ProjectRow } from './repository.js';
import { LocalSource, type ProjectSource } from './source.js';

/**
 * Resolving a project row to the files it is a projection of — shared by every
 * route family that reads a project (manifests, files, diffs, run bundles).
 */

/** A source that cannot be opened, carrying the status the client should see. */
export class SourceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function openProjectSource(
  deps: { pool: pg.Pool; githubApp: GitHubApp | undefined },
  ownerId: string,
  project: ProjectRow,
): Promise<ProjectSource> {
  const { pool, githubApp } = deps;
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
      // Resolve the branch only when Civil does not yet know which commit it is
      // editing against. After that the sha is pinned and every read is a cache
      // hit — see the sync route for how it advances.
      let sha = project.headSha;
      if (!sha) {
        sha = await GitHubSource.resolveHead(
          githubApp,
          connection.installationId,
          project.repoOwner,
          project.repoName,
          project.defaultBranch,
        );
        await setHeadSha(pool, ownerId, project.id, sha);
      }

      base = await GitHubSource.load(
        githubApp,
        connection.installationId,
        project.repoOwner,
        project.repoName,
        sha,
      );
    } catch (error) {
      // Without this, a rate limit, a deleted branch, or a network blip surfaces
      // as an opaque 500 with nothing actionable in it. GitHub already said what
      // was wrong; pass it on.
      if (error instanceof GitHubError) {
        const described = describeGitHubError(error);
        throw new SourceError(
          described.status,
          described.code,
          error.status === 404
            ? `${project.repoOwner}/${project.repoName} has no branch "${project.defaultBranch}", or the installation cannot see it.`
            : described.message,
        );
      }
      throw error;
    }
  } else {
    throw new SourceError(500, 'source_unresolvable', 'This project does not name a readable source.');
  }

  return base;
}
