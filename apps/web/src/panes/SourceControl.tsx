import { useEffect, useState } from 'react';
import type { BranchList, Conflict, GitCheck, GitInfo, PendingChange } from '../project.js';

/**
 * The git flow, in one place and always on screen (owner's rule, 2026-10-01: no
 * automated git interactions, and very visible UI to control the git flow).
 *
 * Every git action here is a button the author presses: Check asks GitHub whether
 * the branch moved, Sync moves to it, Commit writes. Nothing polls, nothing syncs
 * itself, nothing commits for you — and every one of these is also a named command,
 * so an agent drives the same flow through the same handlers.
 */

/** `unsupported`: a non-Python project (lifted from a TypeScript repo) — no Apply. */
export type ApplyStateValue = 'never' | 'stale' | 'current' | 'unsupported' | undefined;

/** Said wherever Apply would otherwise be offered to a project Civil cannot generate. */
export const GENERATION_UNSUPPORTED =
  "Code generation isn't available for TypeScript projects — the repo's code is the implementation.";

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
  onLiftRepo,
  lifting,
  liftTitle,
  liftRefusal = null,
  lifted = false,
  lastLift = null,
  onOpenFile,
  onCommit,
  onReview,
  onRevert,
  onResolve,
  branchMenuOpen,
  branches,
  branchesError,
  onToggleBranchMenu,
  onSwitchBranch,
  onCreateBranch,
  prFormOpen,
  onTogglePrForm,
  onOpenPr,
  gitBusy,
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
  /** Read the repo's code into civil/ documents, as pending changes (project.liftRepo). */
  onLiftRepo: () => void;
  /** A read of the repo is in flight — it can take a while with the model pass. */
  lifting: boolean;
  /** "Generate graph from repo" or "Update graph from repo", from the command. */
  liftTitle: string;
  /** Why reading the repo is not offered on this project, in words; null when it is. */
  liftRefusal?: string | null;
  /** The project's documents were read from the repo (its registry records a lift). */
  lifted?: boolean;
  /** The last lift's result in words, kept here after its toast is dismissed. */
  lastLift?: string | null;
  /** Opens a file in the editor: the lift's inventory, civil/architecture.md. */
  onOpenFile?: (path: string) => void;
  onCommit: (message: string) => void;
  onReview: (path?: string) => void;
  onRevert: (path: string) => void;
  onResolve: (path: string, side: 'mine' | 'theirs') => void;
  branchMenuOpen: boolean;
  /** Read from GitHub when the menu opens; undefined while loading. */
  branches: BranchList | undefined;
  branchesError: string | null;
  onToggleBranchMenu: () => void;
  onSwitchBranch: (name: string) => void;
  onCreateBranch: (name: string) => void;
  prFormOpen: boolean;
  onTogglePrForm: () => void;
  onOpenPr: (title: string) => void;
  /** A branch switch, branch creation, or pull request is in flight. */
  gitBusy: boolean;
}) {
  const [message, setMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [prTitle, setPrTitle] = useState('');
  // However the form was opened — its button or the P command — it starts from the
  // last commit's message, the usual first draft of a PR title.
  const draftTitle = git?.head?.message ?? git?.branch ?? '';
  useEffect(() => {
    if (prFormOpen) setPrTitle(draftTitle);
  }, [prFormOpen, draftTitle]);
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
              <button
                type="button"
                className={`scm-branch${branchMenuOpen ? ' open' : ''}`}
                onClick={onToggleBranchMenu}
                title="Switch branch or create one (B)"
              >
                {git.branch} ▾
              </button>
            </div>
            {branchMenuOpen ? (
              <div className="scm-branch-menu">
                {branchesError ? (
                  <div className="muted">{branchesError}</div>
                ) : !branches ? (
                  <div className="muted">Reading branches…</div>
                ) : (
                  <ul className="scm-list">
                    {branches.branches.map((b) => (
                      <li key={b.name}>
                        <button
                          type="button"
                          className={`scm-branch-row${b.name === branches.current ? ' current' : ''}`}
                          disabled={gitBusy || b.name === branches.current}
                          onClick={() => onSwitchBranch(b.name)}
                          title={b.name === branches.current ? 'You are on this branch' : `Switch to ${b.name}`}
                        >
                          <span className="scm-grow">
                            {b.name === branches.current ? '✓ ' : ''}
                            {b.name}
                          </span>
                          {b.isDefault ? <span className="muted">default</span> : null}
                          {b.pending ? <span className="scm-badge">{b.pending} pending</span> : null}
                          {b.prNumber ? <span className="scm-badge">#{b.prNumber}</span> : null}
                          {!b.onGitHub ? <span className="muted">not on GitHub</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  className="scm-commit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (newBranch.trim() && !gitBusy) {
                      onCreateBranch(newBranch.trim());
                      setNewBranch('');
                    }
                  }}
                >
                  <input
                    className="commit-message"
                    placeholder="New branch from here"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                  />
                  <button type="submit" className="connect" disabled={gitBusy || !newBranch.trim()} title="Create it at this commit, bring your pending changes, and switch to it">
                    Create
                  </button>
                </form>
              </div>
            ) : null}
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

      {/* A branch's way back: its pull request. */}
      {committable && git?.baseBranch ? (
        <div className="scm-block">
          {git.pr ? (
            <div className="scm-row">
              <span className={`dot ${check?.pr ? (check.pr.state === 'merged' ? 'ok' : check.pr.state === 'open' ? 'warn' : '') : ''}`} />
              <a className="scm-grow" href={check?.pr?.url ?? git.pr.url} target="_blank" rel="noreferrer">
                Pull request #{git.pr.number} → {git.baseBranch}
              </a>
              <span className="muted">{check?.pr ? check.pr.state : 'Check for status'}</span>
            </div>
          ) : (
            <>
              <div className="scm-row">
                <span className="scm-grow">No pull request into {git.baseBranch}</span>
                <button
                  type="button"
                  className="link"
                  onClick={onTogglePrForm}
                  title="Propose this branch's commits for merging (P)"
                >
                  {prFormOpen ? 'Cancel' : 'Open PR'}
                </button>
              </div>
              {prFormOpen ? (
                <form
                  className="scm-commit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (prTitle.trim() && !gitBusy) onOpenPr(prTitle.trim());
                  }}
                >
                  <input className="commit-message" placeholder="Pull request title" value={prTitle} onChange={(e) => setPrTitle(e.target.value)} />
                  <button type="submit" className="connect" disabled={gitBusy || !prTitle.trim()}>
                    Open
                  </button>
                </form>
              ) : null}
              {prFormOpen && pending.length > 0 ? (
                <div className="scm-why muted">Pending changes are not part of a pull request until committed.</div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {/* The sketch and its code. */}
      <div className="scm-block">
        {applyState === 'unsupported' ? (
          // A project lifted from a TypeScript repo: its own code is the
          // implementation, so there is nothing to apply — and saying so beats an
          // Apply button that could only refuse.
          <div className="scm-row">
            <span className="dot" />
            <span className="scm-grow scm-unsupported">{GENERATION_UNSUPPORTED}</span>
          </div>
        ) : (
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
                {/* "Generate code", not "Generate": the row below generates the graph
                    from the code, the opposite direction, and two bare "Generate"
                    buttons a line apart do not say which is which. */}
                {applyState === 'never' ? 'Generate code' : 'Apply'}
              </button>
            ) : null}
          </div>
        )}
        {/* The other direction: the code read back into the sketch. Proposes civil/
            documents as pending changes — reviewed below, never committed for you. */}
        {liftRefusal ? (
          // Not offered here, and why — a button that could only refuse is worse.
          <div title={liftRefusal}>
            <div className="scm-row">
              <span className="dot" />
              <span className="scm-grow scm-unsupported">Reading the graph from the repo isn't offered here</span>
            </div>
            <div className="scm-why muted">{liftRefusal.split('. ')[0]}.</div>
          </div>
        ) : (
          // Wraps rather than squeezing: the button carries the command's full title,
          // and the status beside it should read as one line, not a word per line.
          <div className="scm-row is-wrap">
            <span className={`dot ${lifting ? 'warn pulse' : lifted ? 'ok' : ''}`} />
            <span className="scm-grow scm-nowrap">
              {lifting
                ? 'Reading the repository — this can take a minute…'
                : lifted
                  ? 'Graph read from the repo'
                  : 'Not read from the repo yet'}
            </span>
            {!lifting ? (
              <button
                type="button"
                className="connect"
                onClick={onLiftRepo}
                title={`${liftTitle} (U) — proposes civil/ documents as pending changes to review; nothing is committed`}
              >
                {liftTitle}
              </button>
            ) : null}
          </div>
        )}
        {lastLift && !lifting ? (
          <div className="scm-lift-result">
            <div>{lastLift}</div>
            {onOpenFile ? (
              <button type="button" className="link" onClick={() => onOpenFile('civil/architecture.md')}>
                Open architecture.md
              </button>
            ) : null}
            {pending.length > 0 ? (
              <button type="button" className="link" onClick={() => onReview()}>
                Review the diff
              </button>
            ) : null}
          </div>
        ) : null}
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
