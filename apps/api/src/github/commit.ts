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

  // A repository with no commits refuses the entire Git Data API — blobs and trees
  // both answer 409 "Git Repository is empty". Only the Contents API can create a
  // first commit, so an empty repository is bootstrapped through it and everything
  // afterwards takes the normal path.
  //
  // This is the state every new project starts in, so it is a first-class path.
  if (await isEmptyRepository(app, request)) {
    return bootstrapEmptyRepository(app, request);
  }

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

  // 1. Where the branch is now — or nowhere, if the repository has never been
  // committed to. An empty repository is the normal state of a new project, not an
  // edge case: it has no HEAD, so there is no base tree to build on and no parent to
  // point at, and the ref has to be created rather than moved.
  let headSha: string | undefined;
  let baseTreeSha: string | undefined;

  try {
    const ref = await call<{ object: { sha: string } }>(
      `/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    headSha = ref.object.sha;
    const headCommit = await call<{ tree: { sha: string } }>(`/git/commits/${headSha}`);
    baseTreeSha = headCommit.tree.sha;
  } catch (error) {
    // 409 is GitHub's answer for "this repository is empty"; 404 for "no such branch".
    const empty = error instanceof GitHubError && (error.status === 404 || error.status === 409);
    if (!empty) throw error;
  }

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
  // Without a base tree — the initial commit — the entries ARE the whole tree, and a
  // deletion in that set would name a path that has never existed.
  const tree = await call<{ sha: string }>('/git/trees', {
    method: 'POST',
    body: JSON.stringify({
      ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
      tree: baseTreeSha ? entries : entries.filter((e) => e.sha !== null),
    }),
  });

  const commit = await call<{ sha: string; html_url: string }>('/git/commits', {
    method: 'POST',
    body: JSON.stringify({
      message: request.message,
      tree: tree.sha,
      // An initial commit has no parent. Sending [undefined] would be rejected.
      parents: headSha ? [headSha] : [],
    }),
  });

  // 4. Move the branch. Without `force`, GitHub refuses a non-fast-forward update —
  // so if someone pushed between step 1 and here, this fails rather than discarding
  // their work. That compare-and-swap is the real guarantee; the check above is
  // only there to fail earlier and more cheaply.
  try {
    if (headSha) {
      await call(`/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
      });
    } else {
      // Creating the branch rather than moving it. This also fails if someone
      // committed to the empty repository in the meantime, which is the same
      // compare-and-swap guarantee by a different route.
      await call('/git/refs', {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
      });
    }
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


async function isEmptyRepository(app: GitHubApp, request: CommitRequest): Promise<boolean> {
  try {
    await app.asInstallation(
      request.installationId,
      `/repos/${request.owner}/${request.repo}/git/ref/heads/${encodeURIComponent(request.branch)}`,
    );
    return false;
  } catch (error) {
    // 409 is "repository is empty"; 404 is "no such branch", which for our purposes
    // means the same thing — there is nothing to build on.
    return error instanceof GitHubError && (error.status === 409 || error.status === 404);
  }
}

/**
 * Writes the first file through the Contents API, which is the only endpoint that
 * will create a commit in an empty repository, then lets the ordinary path handle
 * the rest.
 *
 * With a single file this produces one commit carrying the caller's message. With
 * several it produces two: the bootstrap, and then the real one. Two commits in a
 * brand-new repository is unremarkable, and it avoids force-updating a ref or leaving
 * unreferenced objects behind to make it look like one.
 */
async function bootstrapEmptyRepository(
  app: GitHubApp,
  request: CommitRequest,
): Promise<CommitResult> {
  const writable = request.changes.filter((c) => c.kind !== 'delete' && c.content !== null);
  const first = writable[0];
  if (!first || first.content === null) {
    // Every change was a deletion, in a repository with nothing to delete.
    throw new NothingToCommitError();
  }

  const only = writable.length === 1 && request.changes.length === 1;

  const created = await app.asInstallation<{ commit: { sha: string; html_url: string } }>(
    request.installationId,
    `/repos/${request.owner}/${request.repo}/contents/${first.path.split('/').map(encodeURIComponent).join('/')}`,
    {
      method: 'PUT',
      body: JSON.stringify({
        message: only ? request.message : 'civil: initialize repository',
        content: Buffer.from(first.content, 'utf8').toString('base64'),
        branch: request.branch,
      }),
    },
  );

  if (only) {
    return { commitSha: created.commit.sha, url: created.commit.html_url };
  }

  // The repository now has a HEAD, so the normal path works for everything else.
  const remaining = request.changes.filter((c) => c !== first);
  return attemptCommit(app, { ...request, changes: remaining });
}
