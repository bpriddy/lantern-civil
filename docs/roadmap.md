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

### Civil projects in a subdirectory

**Undecided. Blocks using the example as a real GitHub-backed project.**

PRD §6.1 puts `civil.yaml` at the root of a project, and the implementation assumes a
project *is* a repository. `examples/doc-pipeline` inside `bpriddy/lantern-civil` is a
valid Civil project living in a subdirectory, and today there is no way to point at it
— loading the repo root correctly reports that `app.yaml` cannot be read.

Two options: a `root_path` on the project that every source prefixes, or the rule that
a repository holds exactly one Civil project at its root. The first is a column and a
prefix; the second is simpler but means the example has to move to its own repository
before it can be opened through GitHub.

### Three-way merge on pull

**Trigger: a second person pushing to the same repository.**

The no-local-file-storage rule (`prd-deltas.md` §11) means no working tree, so no
`git merge`. §14 M3's "pull with conflict handling" is per-file instead: `base_sha` on
each pending row detects divergence precisely, and resolution is keep-yours or
take-theirs.

Adequate for one person who occasionally pushed from a laptop. If a second person
appears, the answer is Filestore — genuinely POSIX, real git — not Cloud Storage FUSE,
which Google documents as unsuitable for version control. Filestore starts around
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
