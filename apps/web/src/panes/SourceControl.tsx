import { useState } from 'react';
import type { Conflict, GitCheck, GitInfo, PendingChange } from '../project.js';

/**
 * The git flow, in one place and always on screen (owner's rule, 2026-10-01: no
 * automated git interactions, and very visible UI to control the git flow).
 *
 * Every git action here is a button the author presses: Check asks GitHub whether
 * the branch moved, Sync moves to it, Commit writes. Nothing polls, nothing syncs
 * itself, nothing commits for you — and every one of these is also a named command,
 * so an agent drives the same flow through the same handlers.
 */

export type ApplyStateValue = 'never' | 'stale' | 'current' | undefined;

const relativeTime = (iso: string): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

type Group = 'Sketch' | 'Generated' | 'Your code';

/** The pattern prompt is Civil's own analysis of the repo, written on Apply. */
const PATTERNS_PATH = 'civil/patterns.md';

/** Sketch is what the canvas edits; generated is what Apply produced; the rest is yours. */
const groupOf = (path: string, maintained: ReadonlySet<string>): Group =>
  maintained.has(path) || path === PATTERNS_PATH
    ? 'Generated'
    : path.startsWith('civil/')
      ? 'Sketch'
      : 'Your code';

export function SourceControl({
  sourceKind,
  git,
  gitError,
  check,
  checking,
  pending,
  conflicts,
  maintained,
  applyState,
  applying,
  committing,
  note,
  onCheck,
  onSync,
  onApply,
  onCommit,
  onReview,
  onRevert,
  onResolve,
}: {
  sourceKind: 'github' | 'local' | 'example';
  git: GitInfo | undefined;
  gitError: string | null;
  check: GitCheck | undefined;
  checking: boolean;
  pending: PendingChange[];
  conflicts: Conflict[];
  maintained: ReadonlySet<string>;
  applyState: ApplyStateValue;
  applying: boolean;
  committing: boolean;
  /** The last git outcome in words — a commit, a refusal — until dismissed. */
  note: string | null;
  onCheck: () => void;
  onSync: () => void;
  onApply: () => void;
  onCommit: (message: string) => void;
  onReview: (path?: string) => void;
  onRevert: (path: string) => void;
  onResolve: (path: string, side: 'mine' | 'theirs') => void;
}) {
  const [message, setMessage] = useState('');
  const committable = sourceKind === 'github';
  const unapplied = applyState === 'stale' || applying;
  const behind = check?.behind ?? 0;

  // Why Commit is unavailable, in words — a disabled button with no reason is a
  // dead end, and the reason is what an agent reports back too.
  const blocked = !committable
    ? sourceKind === 'example'
      ? 'Examples have no repository to commit to.'
      : 'This project has no repository.'
    : pending.length === 0
      ? 'Nothing to commit.'
      : conflicts.length > 0
        ? `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} changed on both sides — choose mine or theirs.`
      : unapplied
        ? 'The sketch has changes not yet applied — Apply first.'
        : behind > 0
          ? `${behind} new commit${behind === 1 ? '' : 's'} on GitHub — Sync first.`
          : committing
            ? 'Committing…'
            : !message.trim()
              ? 'Write a commit message.'
              : null;

  const commit = () => {
    if (blocked) return;
    onCommit(message.trim());
    setMessage('');
  };

  // A conflicted file is listed once, under Conflicts, where it has to be decided.
  const conflicted = new Set(conflicts.map((c) => c.path));
  const groups = (['Sketch', 'Generated', 'Your code'] as const)
    .map((group) => ({
      group,
      files: pending.filter((p) => !conflicted.has(p.path) && groupOf(p.path, maintained) === group),
    }))
    .filter((g) => g.files.length > 0);

  return (
    <section className="scm">
      <div className="pane-title">Source control</div>

      {/* Where you are. */}
      <div className="scm-block">
        {committable && git ? (
          <>
            <div className="scm-repo">
              <a href={git.repo.url} target="_blank" rel="noreferrer">
                {git.repo.owner}/{git.repo.name}
              </a>
              <span className="scm-branch">{git.branch}</span>
            </div>
            {git.head ? (
              <a className="scm-head" href={git.head.url} target="_blank" rel="noreferrer" title="The commit your edits are made against">
                <code>{git.head.sha.slice(0, 7)}</code> {git.head.message}
                <span className="muted">
                  {' '}
                  · {git.head.author} · {relativeTime(git.head.date)}
                </span>
              </a>
            ) : (
              <div className="muted">No commits yet — your first commit creates the branch.</div>
            )}
          </>
        ) : committable ? (
          <div className="muted">{gitError ?? 'Reading the repository…'}</div>
        ) : (
          <div className="muted">
            {sourceKind === 'example'
              ? 'Example project — no repository. Edits stay pending here.'
              : 'No repository behind this project.'}
          </div>
        )}
      </div>

      {/* GitHub: only ever asked when you press Check. */}
      {committable ? (
        <div className="scm-block scm-remote">
          <div className="scm-row">
            <span className={`dot ${check ? (behind > 0 || check.diverged ? 'warn' : 'ok') : ''}`} />
            <span className="scm-grow">
              {checking
                ? 'Checking GitHub…'
                : !check
                  ? 'Not checked'
                  : check.diverged
                    ? 'Branch history was rewritten on GitHub'
                    : behind > 0
                      ? `${behind} new commit${behind === 1 ? '' : 's'} on GitHub`
                      : check.behind === null
                        ? 'GitHub has commits — sync to pick them up'
                        : 'Up to date with GitHub'}
            </span>
            <button type="button" className="link" onClick={onCheck} disabled={checking} title="Ask GitHub whether the branch moved (nothing changes)">
              Check
            </button>
            <button
              type="button"
              className={behind > 0 || check?.diverged || check?.behind === null ? 'connect' : 'link'}
              onClick={onSync}
              title="Move to the latest commit on GitHub"
            >
              Sync
            </button>
          </div>
          {check && check.commits.length > 0 ? (
            <ul className="scm-list">
              {check.commits.map((c) => (
                <li key={c.sha}>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    <code>{c.sha.slice(0, 7)}</code> {c.message}
                  </a>
                  <span className="muted"> · {c.author}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* The sketch and its code. */}
      <div className="scm-block">
        <div className="scm-row">
          <span className={`dot ${applying ? 'warn pulse' : applyState === 'current' ? 'ok' : 'warn'}`} />
          <span className="scm-grow">
            {applying
              ? 'Applying the sketch…'
              : applyState === 'current'
                ? 'Code matches the sketch'
                : applyState === 'never'
                  ? 'No code generated yet'
                  : 'Sketch has changes not yet applied'}
          </span>
          {applyState !== 'current' && !applying ? (
            <button type="button" className="connect" onClick={onApply}>
              {applyState === 'never' ? 'Generate' : 'Apply'}
            </button>
          ) : null}
        </div>
      </div>

      {/* What would be committed. */}
      <div className="scm-block">
        <div className="scm-row">
          <span className="scm-grow">
            {pending.length === 0 ? 'No pending changes' : `${pending.length} pending change${pending.length === 1 ? '' : 's'}`}
          </span>
          {pending.length > 0 ? (
            <button type="button" className="link" onClick={() => onReview()}>
              Review all
            </button>
          ) : null}
        </div>
        {conflicts.length > 0 ? (
          <div className="scm-group scm-conflicts">
            <div className="scm-group-title">Changed on both sides</div>
            <ul className="scm-list">
              {conflicts.map((c) => (
                <li key={c.path} className="scm-conflict">
                  <button type="button" className="scm-path" onClick={() => onReview(c.path)} title="Show your version against GitHub's">
                    {c.path}
                  </button>
                  <div className="scm-conflict-what muted">
                    you {c.mine === 'add' ? 'added' : c.mine === 'delete' ? 'deleted' : 'changed'} it · GitHub {c.theirs} it
                  </div>
                  <div className="scm-conflict-actions">
                    <button type="button" className="link" onClick={() => onResolve(c.path, 'mine')} title="Keep your version; committing replaces the GitHub change">
                      Keep mine
                    </button>
                    <button type="button" className="link" onClick={() => onResolve(c.path, 'theirs')} title="Discard your edit; keep what GitHub has">
                      Take theirs
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {groups.map(({ group, files }) => (
          <div key={group} className="scm-group">
            <div className="scm-group-title">{group}</div>
            <ul className="scm-list">
              {files.map((f) => (
                <li key={f.path} className="scm-file">
                  <span className={`scm-kind scm-kind-${f.kind}`} title={f.kind}>
                    {f.kind === 'add' ? 'A' : f.kind === 'delete' ? 'D' : f.kind === 'rename' ? 'R' : 'M'}
                  </span>
                  <button type="button" className="scm-path" onClick={() => onReview(f.path)} title="Show the diff">
                    {f.path}
                  </button>
                  <button type="button" className="scm-revert" onClick={() => onRevert(f.path)} title="Discard this change">
                    ⟲
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {committable ? (
          <div className="scm-commit">
            <input
              className="commit-message"
              placeholder="Commit message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
              }}
            />
            <button
              type="button"
              className="connect"
              onClick={commit}
              disabled={blocked !== null}
              title={blocked ?? `Commit ${pending.length} file(s) to ${git?.branch ?? 'the branch'}`}
            >
              {committing ? 'Committing…' : `Commit ${pending.length || ''}`.trim()}
            </button>
          </div>
        ) : null}
        {committable && blocked && pending.length > 0 && !committing ? <div className="scm-why muted">{blocked}</div> : null}
        {note ? <div className="scm-note">{note}</div> : null}
      </div>

      {/* Where you came from. */}
      {committable && git && git.history.length > 1 ? (
        <div className="scm-block">
          <div className="scm-group-title">History</div>
          <ul className="scm-list">
            {git.history.slice(1).map((c) => (
              <li key={c.sha}>
                <a href={c.url} target="_blank" rel="noreferrer">
                  <code>{c.sha.slice(0, 7)}</code> {c.message}
                </a>
                <span className="muted"> · {relativeTime(c.date)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
