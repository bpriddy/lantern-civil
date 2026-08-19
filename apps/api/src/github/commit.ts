import type { PendingChange } from '../project/pending.js';
import { GitHubError, type GitHubApp } from './app.js';

/**
 * Committing without a clone.
 *
 * Git objects are content-addressed and immutable, so adding to the object database
 * is uploading objects and then moving a pointer. A clone is a local copy of that
 * database; you do not need one to write. `git commit` performs these same four steps
 * against .git/objects — this is the identical operation over HTTP.
 *
 * There is no push. Push reconciles two object databases, and there is only one here.
 */

/** Regular file. Civil does not create symlinks, submodules, or executables. */
const FILE_MODE = '100644';

export interface CommitRequest {
  installationId: string;
  owner: string;
  repo: string;
  branch: string;
  message: string;
  changes: readonly PendingChange[];
  /**
   * What to do when the branch moved between reading it and writing.
   *
   * `reparent` rebuilds the tree from the new HEAD and re-applies these changes on
   * top. Nothing is destroyed and history stays linear: files Civil touched take
   * Civil's version, files it did not keep whatever landed. This is "the Civil UI is
   * canon" implemented without force — a force update would discard the intervening
   * commits outright.
   *
   * `refuse` stops and hands back the current sha, for when a human should look.
   */
  onBranchMoved?: 'reparent' | 'refuse';
}

export interface CommitResult {
  commitSha: string;
  url: string;
  /** Set when the branch had moved and these changes were re-applied on top. */
  reparentedOnto?: string;
}

export class BranchMovedError extends Error {
  readonly currentSha: string;
  constructor(currentSha: string) {
    super('The branch has moved since these edits were made.');
    this.name = 'BranchMovedError';
    this.currentSha = currentSha;
  }
}

export class NothingToCommitError extends Error {
  constructor() {
    super('There are no pending changes to commit.');
    this.name = 'NothingToCommitError';
  }
}

export async function commitPendingChanges(
  app: GitHubApp,
  request: CommitRequest,
): Promise<CommitResult> {
  if (request.changes.length === 0) throw new NothingToCommitError();

  try {
    return await attemptCommit(app, request);
  } catch (error) {
    if (!(error instanceof BranchMovedError) || request.onBranchMoved === 'refuse') throw error;

    // One retry only. If the branch moves again during the retry, something is
    // pushing continuously and looping would just lose to it repeatedly.
    const result = await attemptCommit(app, { ...request, onBranchMoved: 'refuse' });
    return { ...result, reparentedOnto: error.currentSha };
  }
}

async function attemptCommit(app: GitHubApp, request: CommitRequest): Promise<CommitResult> {
  const { installationId, owner, repo, branch, changes } = request;

  const base = `/repos/${owner}/${repo}`;
  const call = <T>(path: string, init?: RequestInit) =>
    app.asInstallation<T>(installationId, `${base}${path}`, init);

  // 1. Where the branch is now.
  const ref = await call<{ object: { sha: string } }>(
    `/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  const headSha = ref.object.sha;
  const headCommit = await call<{ tree: { sha: string } }>(`/git/commits/${headSha}`);

  // 2. One blob per file whose bytes changed. A pure rename changes no bytes: the
  // blob already exists, and the tree entry simply points at it from a new path.
  const entries = await Promise.all(
    changes.map(async (change) => {
      if (change.kind === 'delete') {
        // A null sha at a path removes it from the tree.
        return { path: change.path, mode: FILE_MODE, type: 'blob' as const, sha: null };
      }

      if (change.content === null) {
        if (change.kind === 'rename' && change.baseBlobSha) {
          return {
            path: change.path,
            mode: FILE_MODE,
            type: 'blob' as const,
            sha: change.baseBlobSha,
          };
        }
        // content_ref means the body is in GCS, which is not wired yet. Committing an
        // empty file would be silent data loss, so refuse loudly instead.
        throw new Error(`pending change for ${change.path} has no readable content`);
      }

      const blob = await call<{ sha: string }>('/git/blobs', {
        method: 'POST',
        body: JSON.stringify({ content: change.content, encoding: 'utf-8' }),
      });
      return { path: change.path, mode: FILE_MODE, type: 'blob' as const, sha: blob.sha };
    }),
  );

  // A rename also vacates its old path.
  for (const change of changes) {
    if (change.kind === 'rename' && change.fromPath) {
      entries.push({ path: change.fromPath, mode: FILE_MODE, type: 'blob', sha: null });
    }
  }

  // 3. A tree describing only what changed. base_tree carries everything else
  // forward, which is why a hundred-file repo costs one call rather than a hundred.
  const tree = await call<{ sha: string }>('/git/trees', {
    method: 'POST',
    body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: entries }),
  });

  const commit = await call<{ sha: string; html_url: string }>('/git/commits', {
    method: 'POST',
    body: JSON.stringify({ message: request.message, tree: tree.sha, parents: [headSha] }),
  });

  // 4. Move the branch. Without `force`, GitHub refuses a non-fast-forward update —
  // so if someone pushed between step 1 and here, this fails rather than discarding
  // their work. That compare-and-swap is the real guarantee; the check above is
  // only there to fail earlier and more cheaply.
  try {
    await call(`/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: 'PATCH',
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
  } catch (error) {
    if (error instanceof GitHubError && (error.status === 422 || error.status === 409)) {
      const now = await call<{ object: { sha: string } }>(
        `/git/ref/heads/${encodeURIComponent(branch)}`,
      );
      throw new BranchMovedError(now.object.sha);
    }
    throw error;
  }

  return { commitSha: commit.sha, url: commit.html_url };
}
