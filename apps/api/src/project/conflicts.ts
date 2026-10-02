import type { PendingChange } from './pending.js';

/**
 * A file both the author and upstream changed: the author's pending edit was made
 * against one commit, and since then the branch moved and the file changed under
 * it. Civil never merges and never picks a side (owner's rule, 2026-10-01): it
 * lists these, and the author chooses mine or theirs for each before committing.
 */
export interface Conflict {
  path: string;
  /** What the author's pending change does. */
  mine: PendingChange['kind'];
  /** What happened to the file upstream between the edit's base and the head now. */
  theirs: 'added' | 'modified' | 'deleted';
}

/** Reads a commit's tree: the blob id at a path, undefined when absent. */
export type BlobsAt = (commitSha: string) => Promise<(path: string) => string | undefined>;

/**
 * Compares each pending edit's base with the head now, by blob id — no content is
 * read. An edit whose base is the head, or unknown (saved before bases were
 * recorded), cannot be in conflict. Each distinct base tree is loaded once.
 */
export async function findConflicts(
  pending: readonly PendingChange[],
  headSha: string | null,
  blobsAt: BlobsAt,
): Promise<Conflict[]> {
  if (!headSha) return [];
  const moved = pending.filter((p) => p.baseCommitSha && p.baseCommitSha !== headSha);
  if (moved.length === 0) return [];

  const head = await blobsAt(headSha);
  const bases = new Map<string, (path: string) => string | undefined>();
  const conflicts: Conflict[] = [];
  for (const change of moved) {
    const baseSha = change.baseCommitSha!;
    if (!bases.has(baseSha)) bases.set(baseSha, await blobsAt(baseSha));
    const before = bases.get(baseSha)!(change.path);
    const after = head(change.path);
    if (before === after) continue; // upstream left this file alone
    conflicts.push({
      path: change.path,
      mine: change.kind,
      theirs: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
    });
  }
  return conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
