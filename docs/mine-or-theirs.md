# Mine or theirs: reconciling hand edits to maintained files

Design note, 2026-08-22. The deferred half of commit integration
(docs/transpilation.md's ownership map: orchestration and boundary files are
"regenerated; mine-or-theirs on drift"). Transpile-at-commit shipped without
it, made safe in the interim by the review diff — a regeneration is *shown*
before the user confirms, never silent. This note is how it becomes a real choice.

**Correction (2026-08-22):** an earlier claim that the commit review *surfaces*
an interim clobber was wrong. The pre-commit transpile overwrites the
hand-edited pending file before the diff fetches, so the diff shows only
HEAD→regenerated; the discarded hand edit was an intermediate pending state and
is never shown. So today, hand-editing a maintained (orchestration/boundary)
file and then transpiling/running/committing loses that edit silently. This is
consistent with the ownership map (those files are transpiler-owned; handlers
are the human surface and are exempt), but it is a real footgun until this
design ships. First task of the build below, or a cheaper stopgap: make
maintained files read-only in the editor so the hand edit cannot happen.

## The problem the schema creates

`pending_changes` records no provenance (see migration 003): a file Civil
transpiled and a file a human saved in Monaco are the same row, written by the
same `savePending`. So "who wrote this?" cannot be read back from the pending
state. That is what makes detection non-trivial.

Naive content comparison is not enough. For a maintained path P, let F be what
the transpiler emits *now* and C be the current content (pending, else HEAD):

- `C == F` — no drift; nothing to reconcile.
- `C != F` — **ambiguous**: either C is a *stale prior emission* the current
  transpile legitimately supersedes (regenerate, no question), or C is a *human
  hand edit* that must not be clobbered without asking. Content alone cannot
  tell these apart, because both differ from F.

## Provenance is the missing bit

The disambiguator is *every content Civil has ever emitted for P* — call the set
H(P). NOT just the latest emission: documents can cycle (edit A → B → back to A),
so the current content may match an older emission that is still legitimately
Civil's. Latest-only would false-flag that return-to-A as a hand edit.

- `C ∈ H(P)` — C is some emission of Civil's own (current or a prior one it is
  cycling back to). Safe to regenerate: **mine**, silently.
- `C ∉ H(P)` — no emission ever produced C, so a human wrote it after Civil last
  did. **Drift**: surface it and let the owner pick.

H already exists, unstamped: `transpilations` rows hold `output.files` across
every distinct emission, so H(P) is the set of `row.output.files[P]` over all
rows (compared by content, or a content hash to keep it cheap). Mine-or-theirs
needs **no schema change**. (A `pending_changes.authored_by` enum —
'human' | 'transpiler' — would make it a one-column read; recorded as the
alternative if the memo is ever pruned below H's needs. Not preferred: a column
is state that can lie, where emitted content cannot.)

## The resolution flow

At transpile (which already runs at commit and on structural ops):

1. For each maintained path P with `C != F`:
   - `C ∈ H(P)` → regenerate to F (mine). No prompt.
   - `C ∉ H(P)` → a conflict: record {path, theirs: C, mine: F}.
2. If any conflicts, the commit (or the transpile-sync) pauses on a
   reconciliation step rather than proceeding. Per-file, the owner picks:
   - **Mine** — take the canvas: write F, discard the hand edit.
   - **Theirs** — keep the hand edit: leave C, and *lift* it so the civil
     documents reflect what the code now says (contract discovery is the seed;
     for orchestration this is the harder, later lift). Until lift for a given
     file class exists, "theirs" means "leave C and stop regenerating it" with a
     drift marker, not a full lift.
3. No merging, ever (the single-user stance the whole model takes). The choice
   is whole-file.

## Where it lives

- Detection is a pure function over (maintained paths, current overlay, fresh
  output, latest memo): `conflicts(overlay, output, lastEmitted) -> Conflict[]`.
  Unit-testable with no runner, like the retirement math.
- The commit route already transpiles first; it gains a pre-commit conflict
  check that 409s with the conflict list when unresolved, the same shape the
  branch-moved path already uses.
- The UI is the diff panel's territory: a conflict is a per-file mine/theirs
  toggle above the diff, defaulting to nothing chosen so a commit cannot
  proceed past an unacknowledged clobber.

## Open questions

- Lift fidelity for orchestration: "theirs" on a boundary server means reading a
  hand-edited FastAPI file back into the composition. Contract discovery handles
  signatures; full orchestration lift is the harder problem the roadmap already
  names.
- Memo pruning vs. provenance: if `transpilations` rows are ever garbage
  collected, L for an old path could vanish. Either keep the latest row per
  project unpruned, or adopt the `authored_by` column then.
- Interaction with the session's hot re-transpile: a live session auto-syncs on
  structural ops; a conflict there should surface without blocking the canvas,
  unlike commit which can block.
