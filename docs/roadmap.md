# Roadmap

PRD §16 lists what was deferred at design time. This file lists what has been deferred
or gated *during implementation* — decisions taken with a reason and a trigger, so they
resurface when they should rather than when someone remembers.

Each entry says what it is, why it is not now, and what has to be true for it to
become now.

---

## Gates — things that must be decided before a milestone, not during it

### Sandbox isolation, before M4 executes anything

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

## Finishing M3

The op layer exists and is the seam PRD §7.1 describes: the client posts ops, the
server splices them into the source, and the same route serves the keyboard today and
an agent later. What is missing is most of the vocabulary.

- **The rest of the ops.** `removeNode`, `updateNode`, `renameNode`, and the three
  edge ops. `renameNode` is the interesting one — PRD §7.1 gives it
  `updateReferences`, so it has to rewrite edge endpoints and layout keys atomically
  or leave the manifest referring to a node that no longer exists.
- **Dragging.** Nodes are fixed in place. Dragging should emit `setLayout`, which
  already works — this is wiring React Flow's drag to the op, plus deciding when to
  send it (on drop, not per frame).
- **A diff preview.** PRD §7 says the commit indicator "shows a count and a diff
  preview". It shows the count. Committing without seeing what you are committing is
  the gap most likely to cause a bad commit.
- **Undo.** PRD §7 lists `Cmd+Z`. Every op would need an inverse, or the previous
  source kept per step — the second is simpler and, given manifests are small, likely
  correct.

None of these is blocked on anything. They are the reason M3 is not done.

## Near-term, not deferred

### GitHub App

The next piece of work, and the reason the deployed instance shows "No project open".

PRD §12 specifies a GitHub App with short-lived tokens minted server-side, never sent
to the browser. Until it exists, a project can only point at a local directory, which
`CLAUDE.md` marks as a development affordance that must not become a deployment
mechanism. Creating the App is an account action only the owner can take.

### `pending_changes`, replacing `working_trees`

Migration 004. `working_trees` models a `clone_path` that will never exist under the
no-local-file-storage rule; it is replaced rather than amended. This is what makes
"start on one device, continue on another, without committing" true.
