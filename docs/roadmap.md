# Roadmap

PRD §16 lists what was deferred at design time. This file lists what has been deferred
or gated *during implementation* — decisions taken with a reason and a trigger, so they
resurface when they should rather than when someone remembers.

Each entry says what it is, why it is not now, and what has to be true for it to
become now.

---

## The value prop, and the burn-down that serves it

Settled with the owner on 2026-09-16, deconstructing an earlier feature-shaped list.

**The value prop, in one line:** Civil is a new, higher layer of abstraction for
building applications — the graph altitude — that is **backwards compatible**: you can
start at the top and transpile down into a whole ordinary application, or bring
existing code up into the graph, and neither the layer below nor the code you already
have is ever broken or locked away.

The techniques we build (transpilation, lift, the engine interface, seed-where-none-
exists, boundary type-sync) are not the point. They are the machinery that keeps a
higher abstraction layer backwards compatible — which is the thing no prior attempt at
raising app-building altitude (low-code, visual builders, framework-as-platform) has
done. Those are one-way doors; Civil is not. The layer is **symmetric and reversible**:
either end is a first-class entry point, and neither altitude is ever severed.

Two framing calls that set the priority order below:
- **Top-down devex is the center of gravity.** "I graph an application and get real
  application code back," that loop being tight and propulsive, matters most.
  Bottom-end ingestion is required for the story to be *complete*, but it is later.
- **Agents are normal, not a tout.** Agent code analysis, testing, orchestration are
  the ambient mechanism of the coding experience, woven through the tiers where they
  belong — not a feature category. Agent *piloting* (an agent operating the whole
  layer) is a different, higher-order context, so it sequences last.

The invariants the value prop demands, each an axis the burn-down is measured on:
A — down-transpile is whole and idiomatic (graph → an app you own); B — up-lift is
faithful (code → graph, lossless within conventions); C — either end is a valid start;
D — the layer below is never severed; E — the two layers never silently diverge;
F — the app actually runs and is trustworthy at both altitudes.

**The burn-down, in priority order:**

- **P1 — The graph → code loop is tight, trustworthy, propulsive** *(A + E).*
  Emission reliability (kill the transient malformed-`emit_files` flakiness — the loop
  randomly fails until this is fixed); transpiler hardening (generative → templates,
  tighten determinism); agent code analysis always-on and seamless (normal, not a
  special trigger); complete the emission surfaces (multi-vendor engines, boundary
  type-sync follow-ups — function-backed/composite/progress typing, call-site
  adoption); hot re-transpile + stale/superseded-emission cleanup. (agent.yaml
  dissolution has landed: config is code kwargs, prompts are prompts/<node-id>.md.)
- **P2 — Building & running at altitude is rich and end-to-end** *(F + top-down
  authorship).* Harness authoring / attaching; app testing (project's own tests
  in-session, agent testing as normal); observability in dev end-to-end (trace viewer,
  replay, node result cache, progress wiring); substrate hardening (incl. npm-install
  >5min → 502).
- **P3 — You're never trapped; the altitudes round-trip** *(B + D).* Lift maturation
  (node / capability / composition lift, a persisted node↔file map, orphan handling);
  full mine-or-theirs reconciliation (hand-edit vs regenerate). Real, but the ownership
  safety net is less urgent day-to-day than P1/P2.
- **P4 — Bottom-end ingestion** *(C — completes the value prop, explicitly later).*
  Existing repo → induced graph (the macro of lift); harness import.
- **P5 — Agent piloting** *(operating the layer autonomously — a different context).*
  Intent in, agent edits graph + code through the same diff/commit path. Depends on P1
  (loop) and P3 (lossless reconciliation) being solid.

Housekeeping: consolidate the (now very long) project memory.

The chapter detail below predates this reframing and remains accurate as a record of
what shipped; the tiers above are how the remaining work is now prioritized.

---

## The next chapter: transpilation

`docs/transpilation.md` (2026-08-21) redefines what Civil produces: the canvas
edits documents in `civil/`, commit transpiles them into ordinary code in the
repo, and the deployed app is standard software with a small runtime library.
The M5 client work now flows through this design — the boundary server and
orchestration are transpiled into the repo, not hosted by the platform. Build
order sketch: the transpiler (graph → orchestration, composition → boundary
server) → the app session and preview pane (`docs/app-session.md`: Run runs the
app; write-through editing; session logs) → commit-path integration with
mine-or-theirs → document migration into `civil/` → lift-on-open → boundary
type-sync → the testing ladder.

**What the transpiler writes is settled** (`docs/emitted-code.md`, 2026-08-21):
two first-class rules (the user's pattern IS the pattern; composed and
modularized, interfaces for anything per-project configurable), proportional
emission (vanilla → stdlib asyncio → an earned civil-runtime import, judged by
the strong-engineer test), agents as plain functions calling one `Engine`
facade (vendor identity as data, Claude default), agent.yaml dissolved into
code kwargs and prompt assets, instrumentation observer-side. The transpiler
is two components: the **pattern analyzer** (LLM code analysis, triggered by
inbound or hand-written changes, writing the `civil/patterns.md` helper
prompt, runner-side) and the **transpiler** proper (documents + pattern prompt
in, code out). It can start; its golden tests encode this contract.

**Transpiler v1 is BUILT** (2026-08-21). `civil_runtime.engines` (the Engine
facade, vendor identity as data, Claude adapter private), `runner/patterns.py`
+ `runner/transpile.py` (POST /analyze, POST /transpile, GET /transpile/meta;
forced emit_files structured output; deterministic validators with a two-retry
feedback loop), and the API layer (migration 007, memoization keyed by
documents+context+patterns+model+promptVersion, staleness triggers, pending-
change emission, the `project.transpile` command, key T). Proven live: the
doc-pipeline classify graph transpiled in one attempt and the emitted code —
three ordinary modules, one facade import — executed end-to-end against real
Claude (invoice, 0.97, enriched). The emission is frozen as golden test #1
(`runner/tests/golden/doc-pipeline/`). Next in the chapter: the app session
and preview pane.

**App session increment 1 is BUILT** (2026-08-21). Boundary-server emission
(roles on emit_files, PROMPT_VERSION 3, FastAPI default per the strong-engineer
test), the local session service (`session/server.py`: materialize, shared
venv, curated child env — secrets never reach app processes, model key the one
exception — process supervision, logs, idle reap), API session routes (one
session per project, per-project port bases, process derivation from the
composition), and the preview pane (composition Run starts/attaches the
session; graph Run stays the module debugger). Proven live end-to-end:
doc-pipeline's composition Run brought up vite + the emitted FastAPI boundary
in the IDE preview, and POST /classify on the running boundary returned a real
classification through the emitted stack. Known warts: superseded pending
emissions from older prompt versions linger until reverted; npm installs past
~5 min can mislabel as 502 (undici dependency is the full fix; the UI re-probe
mitigates). Next: write-through editing + hot re-transpile, then commit-path
integration with mine-or-theirs.

**Transpiler hardening path** (owner's call, 2026-08-21): v1 emits
generatively — LLM emission steered by the pattern helper prompt, input-hash
memoized for stability, with the diff panel and mine-or-theirs as the review
gates. The analyzer's prompts start deliberately less prescriptive. As
patterns stabilize, the transpiler evolves to have — or to *write* — templates
that harden them: recurring emissions crystallize into deterministic
templates, prompt refinement narrows the generative surface, and the
generative path remains for whatever templates don't yet cover. Direction of
travel: judgment first, determinism earned.

**Boundary type-sync is BUILT** (2026-09-16; renamed from "the typed web SDK"
after the owner caught the earlier framing smuggling in an opinion). The value
is narrow and honest: **keep the frontend's understanding of the boundary from
silently drifting from the backend's.** The boundary schema is the source of
truth; when it changes, the web client's types for that boundary update, so
drift surfaces in the editor and at build. That is all Civil owns here —
propagating a fact, not imposing a style. It is *not* a prescribed client.
`docs/boundary-type-sync.md` is the design. What shipped: a deterministic,
API-side generator (`apps/api/src/project/boundary-client.ts`) — faithful types,
never LLM-paraphrased, because drift-prevention is only as good as the types
being exact — that resolves the composition's api boundary to its exposed
services' io schemas, renders JSON Schema to TypeScript, and emits a client into
`web/src/civil/client.ts` under the new `boundary-client` role. It merges into
the transpile output before the memo is stored, so it inherits pending → diff →
provenance → retirement → session with no special-casing, and a client signature
folds into the input hash so a schema edit regenerates while a project with no
web client hashes exactly as before. v1 seeds the greenfield case (thin typed
fetch wrappers); reading a call-site convention out of `civil/patterns.md` and
emitting into it (rule 1), function-backed types via contract discovery, and the
progress/SSE channel are the recorded next increments. Proven: the doc-pipeline
client generates faithful `ClassifyInput`/`ClassifyOutput` types and type-checks
clean under strict TS.

## The horizon after the chapter — owner's additions, 2026-08-22

- **Harnesses as a first-class experience.** The founding intent named "loops,
  graph patterns and harnesses" as what building in the AI-stack era involves;
  this makes a harness a thing you can hold. Specific UX for **importing** a
  harness (bringing an existing one — a repo's, a package's, another
  project's — into a project), **authoring** one in Civil, and **attaching**
  one (wiring it around an agent, a graph, or the app). Open design
  territory: what the unit is (a subgraph, a template family, a library the
  emitted code imports), how attachment reads on the canvas, and how rule 1
  applies when a harness arrives from outside the repo.
- **Agent piloting of the entire app.** An agent builds and evolves the
  application through both surfaces at once: civil generation (the op layer
  has been the agent seam since PRD §7.1) and code generation (handlers,
  prompts, frontends). The user states intent; the pilot edits documents and
  files with the same tools the human uses, reviewed through the same diff
  panel and commit path — piloted, never opaque.
- **Propulsive devex, continued.** In the same spirit as the harness work:
  keep adding the affordances that make AI-stack app development intuitive
  and propulsive. The founding intent, standing as a roadmap directive — the
  test every future item answers to.

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
