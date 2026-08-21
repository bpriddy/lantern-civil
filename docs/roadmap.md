# Roadmap

PRD §16 lists what was deferred at design time. This file lists what has been deferred
or gated *during implementation* — decisions taken with a reason and a trigger, so they
resurface when they should rather than when someone remembers.

Each entry says what it is, why it is not now, and what has to be true for it to
become now.

---

## Gates — things that must be decided before a milestone, not during it

### Sandbox isolation, before M4 executes anything — **RESOLVED: isolate first**

**The owner amended the PRD (v1.1, §12): execution is user-scoped.** Project code
never runs in a process holding platform credentials; the credential-free runner
is M4's first deliverable. The analysis below is kept for the record.

**Trigger: the first user-authored code node the runner executes.**

PRD §2 excludes sandbox isolation of untrusted code from v1. That was sound when there
was one user running their own code. Sign-in is now open to anyone with a Google
account, which changes what the exclusion means: any person who signs in can have
Civil clone their repository and execute their code, in a process holding the database
credentials and every other user's data.

Not live today — there is no runtime, so signing in grants an editor shell with
nothing to execute. That is what makes open signup safe *now* and unsafe *then*.

Before the runner executes its first user-authored code node, one of these must be
true:

1. Execution is isolated per run — a separate container or sandbox with no ambient
   credentials, or
2. Signup is closed back to an allowlist, or
3. The owner accepts the exposure explicitly, knowing it means arbitrary remote code
   execution by any signed-in stranger.

M4's exit criterion is about a graph running end to end and would otherwise sail past
this. See `prd-deltas.md` §10.

### Always-allocated CPU, before M4 owns jobs

**Trigger: the first run that must outlive its request.**

PRD §12 wants long runs decoupled from the request. The service runs one warm
instance, but with `cpu_idle = true` — its CPU is throttled between requests, so
background execution does not progress. §8.2's "runs outlive requests" needs
`cpu_idle = false`.

Deferred because nothing owns a job yet and always-allocated vCPU bills at roughly ten
times the idle rate — a material change to a bill that is currently around
$20–25/month. It is a one-line Terraform change, not a rebuild, but it should be a
decision rather than a surprise.

---

## Open questions

### What a command targets

**Deliberately unresolved. Deciding it badly is worse than leaving it open.**

Commands act on something, and right now that something is implicit and inconsistent.
`nav.descend` uses canvas selection. `file.save` uses the open Monaco tab. `node.add`
places a node at a hardcoded position because there is no answer to "where did the
user mean" — the first added node lands off-screen, which is the symptom.

Focus and blur is probably the mechanism, but it has to satisfy three things at once
and they pull apart:

- **The canvas** has a selection that survives clicking elsewhere in the shell.
- **Monaco** owns its own focus and must not have it stolen.
- **An agent** has no focus at all. "Add a node to the classify graph" names its
  target in the instruction, so a target model that only exists as DOM focus is one an
  agent cannot participate in.

That last one is why this is worth pausing on rather than reaching for `document.
activeElement`. Under CLAUDE.md's agent-first rule, the target belongs in the command
context — something a keystroke fills from focus and an agent fills from an
instruction — rather than being read off the DOM at the moment a handler runs.

Until it is decided, new nodes are placed at a fixed position and commands read from
the canvas selection.

## Deferred features

### Mobile

**Deferred. No trigger yet — revisit when there is something worth glancing at.**

PRD §15 is desktop only, ≥1280px, and the shell means it: `min-width: 1280px` in the
CSS and a fixed `width=1280` viewport meta.

**The hard part is already done.** Pending edits live in Postgres, not on any device
and not on any container, so state is device-independent by construction — sign in
anywhere and your uncommitted work is there. What is missing is only the interface.

Two very different scopes, worth not conflating:

- **Read-only run viewer.** Watch a run animate, read the event log, see a trace, cancel
  something. Small surface, no canvas editing, and genuinely useful on a phone — a
  research node runs for tens of minutes (§8.2) and wanting to check on it away from a
  desk is the obvious case. This is the one to build first if any.
- **Mobile editing.** The composition and dataflow canvases are pan-zoom-select
  surfaces with double-click descent. Touch descent, node selection at thumb size, and
  an inspector that is not a 320px sidebar are all real design work, not a media query.
  This cuts directly against §15 and should not be taken on without deciding §15 is
  wrong.

Prerequisite either way: the run event log (M4), because before that there is nothing
a phone could usefully show.

### Repository selection UX

**Deferred at the owner's request. Trigger: whenever the blast radius starts to matter.**

The GitHub App is installed with `repository_selection: all` — 62 repositories, with
`contents: write` on every one. Convenient to set up, and it means a bug in Civil's
commit path can write to any repo on the account, not just the one open in the editor.

That is blast radius rather than access control, and it is cheap to narrow: GitHub
already supports per-repository installation, so this is a settings screen that links
out to the App's installation page, plus honouring `repository_selection` when listing
what a project may point at.

### Richer conflict resolution

**Trigger: the first time re-parenting produces a result the author did not want.**

The owner's rule is that the Civil UI is canon. When the branch has moved, a commit is
re-parented onto the new HEAD and the pending changes re-applied: files Civil touched
take Civil's version, files it did not keep whatever landed. Nothing is destroyed and
history stays linear, which is force-push's outcome without force-push's cost.

What it does not do is ask. If someone changed the same file Civil is about to write,
their version is replaced without a prompt. For one person who occasionally pushes
from a laptop that is the right default and the failure is recoverable — the replaced
commit is still in the reflog and in the history.

The richer version is per-file: `base_blob_sha` on each pending row already detects
exactly which files diverged, so the UI could offer keep-yours or take-theirs per file
rather than deciding for the whole commit. That is a UI, not a mechanism — the
detection is already there.

A true three-way merge needs a working tree, which the no-local-file-storage rule
(`prd-deltas.md` §11) rules out. If a second person ever edits the same repository,
the answer is Filestore — genuinely POSIX, real git — not Cloud Storage FUSE, which
Google documents as unsuitable for version control. Filestore starts around
$200/month, which is why it is not the answer today.

### Publishing the OAuth consent screen

**Trigger: wanting signup genuinely open.**

The consent screen is in **Testing**, so only listed test users can sign in. That is a
de facto allowlist and currently the only thing limiting who can reach the
application. Publishing invites a Google verification review the requested scopes
(`openid email profile`) do not need, but it is a real step with a real wait.

Note the interaction with the sandbox gate above: publishing turns "anyone I have
added" into "anyone at all", and should not happen before that gate is resolved.

---

## M3 — done

PRD §14's exit: *"a full app is authorable from empty, and the YAML looks
hand-written."* Every piece named there now exists and is exercised: structured ops
for both canvases (the full §7.1 vocabulary — add/remove/update/rename node, add/
remove/update edge, setLayout), the comment-preserving splice writer with its
byte-identical round-trip tests, drag to move and drag to connect, the diff preview
behind the commit indicator, commit + push against a pinned head with re-parenting,
and undo. `docs/ops.md` is the whole mutation path end to end.

The editable inspector is how §5's "everything inspector-editable" landed: each
field commits an `updateNode` patch, the id field commits a `renameNode`, and the
remove buttons send the same ops the Delete key does.

The connect gesture — flagged here earlier as unverified — has since been drawn with
a real pointer drag in a browser and produced the expected edge, correctly inferred
and correctly styled. The earlier automation failures were the handles being a
too-small target at default zoom, not the wiring.

### Findings from the M3 review, accepted rather than fixed

An adversarial review pass (five lenses, each finding attacked by a skeptic that had
to reproduce it) confirmed and fixed the splice-overlap corruptions, the undo/save
interactions, and the diff-panel keyboard leak. Three confirmed findings were left
as they are, each on purpose:

- **Undo across browser tabs.** Tab A commits; tab B's undo stack predates that
  commit, and undoing in B resurrects pre-commit text as a new pending change.
  Recoverable (it is only a pending change) and symptomatic of the larger fact that
  a second tab's bundle is stale after any external change — cross-tab sync is one
  problem, not an undo problem, and it is not M3's.
- **`runOps` reports success when the op landed but the refresh failed.** The op
  *did* apply; the bundle on screen is transiently stale and heals on the next
  fetch. Making refresh loud here would make every transient network blip a toast.
- **The ops route trusts `apply.ts` refusals rather than zod-validating the batch.**
  A malformed op fails with a specific `op_refused` message, which is adequate;
  schema validation would improve the 400s an agent sees and can come with the
  agent.

One pre-existing gap the review surfaced in passing — `GitHubSource` prefetched
only manifest-shaped files, so repository projects could not open source files or
discover committed contracts — was fixed as M4's first commit: sources now expose
`ensure(paths)`, hydrating the sync cache on demand, once per commit.

### Vocabulary changes strand existing manifests

**Trigger: the next schema change to a manifest shape — decide before making it.**

The boundary/client split left a real project unrenderable: one node in the old
spelling fails the discriminated union at parse, and because graph discovery hangs
off the composition, the whole canvas emptied rather than showing five good nodes
and one bad one. The fix was a two-line edit, but a person had to know to make it.

Worth deciding before the vocabulary moves again: either a migration note in the
diagnostic itself ("client: api is now boundary: api — edit app.yaml") so the
error teaches the fix, or a `civil migrate` op that rewrites old spellings as a
pending change. And separately: a parse failure in one node should degrade to
that node, not blank the altitude.

### Fit-to-view — resolved

React Flow's queued fitView never flushes in this controlled setup (its own
Controls button included), so fit computes the viewport directly —
`getNodesBounds` + `getViewportForBounds` + `setViewport`, the same non-queued
path the descent restore uses. The long hunt's confusing tail was HMR-corrupted
dev pages; on a clean load the direct implementation works, verified.

### Left open on purpose, small

- **Redo.** PRD §7 lists `Cmd+Z` only. The undo stack discards what it pops.
- **`updateEdge` has no gesture.** The op exists and is tested; nothing in the UI
  sends it yet. Its first caller will probably be an agent.
- **`invocation` overrides** (PRD §8.1) have no inspector field; editing them is a
  Monaco job until M4 makes invocation mean something.
- **Escape while a field is focused** reverts the field (and deliberately does not
  also clear the canvas selection). A second Escape ascends. Worth revisiting only
  if it feels wrong in use.

## Shipped since this file was written

Both entries that used to sit under "near-term" are done, kept here because the
reasoning still explains why the code looks the way it does.

- **The GitHub App.** Short-lived tokens minted server-side, never sent to the
  browser (PRD §12). Reads go through the Git Data API; commits are blobs → tree →
  commit → update-ref. No clone, ever.
- **`pending_changes`, replacing `working_trees`.** Migration 004. `working_trees`
  modelled a `clone_path` that cannot exist under no-local-file-storage, so it was
  replaced rather than amended. This is what makes "start on one device, continue on
  another, without committing" true.
