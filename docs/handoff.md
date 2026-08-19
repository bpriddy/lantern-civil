# Handoff

Paste the block below into a new session, alongside the PRD. It is written to be read
cold — it assumes the reader has `civil-prd.md` and nothing else.

Keep it current. A handoff that describes a state the repo has left is worse than no
handoff, because it will be believed.

---

## The prompt

> We're building **Civil**, a web IDE for building applications at graph altitude.
> The PRD is attached and is the design document. The repo is at
> `/Users/alanternguides/Documents/0_LANTERN/0_PRODUCTS/3_CIVIL/`, pushed to
> `git@github.com:bpriddy/lantern-civil.git`, deployed at
> `https://civil-35752011174.us-central1.run.app`.
>
> **Read these first, in this order, before writing anything:**
>
> 1. `CLAUDE.md` — the invariants. These are load-bearing and each one exists because
>    violating it is expensive to undo. Do not relitigate them.
> 2. `docs/prd-deltas.md` — every place implementation diverged from the PRD, with the
>    reason and how to reverse it. **Read this before treating any PRD section as
>    current.** Several are superseded: §12's IAP auth is gone (delta §10), §6.4's id
>    pattern is widened (§1), composition edges gained a `kind` the PRD's examples do
>    not show (§2), and §7/§12's working-tree model is replaced by no-local-file-storage
>    (§11).
> 3. `docs/ops.md` — how every mutation travels, gesture to commit. This is the seam
>    everything else plugs into.
> 4. `docs/roadmap.md` — what is deferred, gated, or deliberately unresolved, each with
>    the trigger that should bring it back.
>
> **Where we are:** M0–M2 are done. M3 (the editor: ops, canvas gestures, Monaco,
> commit flow) is most of the way there — `addNode`, `setLayout`, `addEdge`, and
> `removeEdge` all work, nodes drag, edges draw and delete. `docs/roadmap.md` §
> "Finishing M3" lists exactly what remains and why each piece is not trivial.
>
> **First task, before anything else:** open the app locally with `./scripts/dev.sh`,
> open the doc-pipeline example, and drag a connection between two node ports with a
> real mouse. The edge code is unit-tested and typechecked but the gesture itself was
> never confirmed by hand — React Flow uses pointer capture and does not respond to
> synthesised events, so browser automation could not verify it. Expect a toast
> reading "Connected X → Y", the pending count to increment, and a new edge in
> `app.yaml`. If it works, say so and move on to `removeNode`. If it does not, that
> is the bug to fix.
>
> **Then:** finish M3 in the order given in `docs/roadmap.md` — `removeNode` with
> `cascadeEdges`, `updateNode`, `renameNode` with `updateReferences`, the diff
> preview, undo.
>
> **How I work:**
>
> - Run `npm test` before claiming anything works. 13 schema + 43 API + 13 web + 24
>   Python checks, plus `npm run typecheck`.
> - Deploy only with `./scripts/deploy.sh`, never from a dirty tree. It builds,
>   migrates as a Cloud Run job from the same image, deploys, then smoke tests.
> - Never put a secret in your context. If one is needed, I will write it to Secret
>   Manager myself, or you pipe it without printing it.
> - Do not create accounts, OAuth clients, or authenticate as me.
> - Tell me when something is unverified rather than describing it as working. Several
>   of the worst bugs in this project looked like working software from outside.

---

## Context the prompt above compresses

Things a next session will want and cannot infer from the code.

### Decisions that are settled

These were argued through once and should not be reopened without new information:

- **No local file storage.** Nothing on the container filesystem may be the only copy
  of anything. GCS-as-a-working-tree and clone-as-a-cache were both considered and
  rejected with reasons — `prd-deltas.md` §11.
- **One project, one repository.** Examples are the single exception, and only
  because they are not repositories at all.
- **Open signup**, deliberately. The owner's call: "I don't care about keeping people
  out right now." The risk is real but not yet live — there is no runtime to exploit —
  and it is recorded as an M4 gate in `roadmap.md`, not as an open question.
- **Agent first**, from `CLAUDE.md`. Every mutation is an op, every action is a named
  command, every command describes itself and reports what it did. The copilot is
  deferred; this is what keeps the deferral cheap.

### The open question, deliberately unresolved

**What a command targets.** `nav.descend` uses canvas selection, `file.save` uses the
open Monaco tab, and `node.add` places a node at a hardcoded position because there is
no answer to "where did the user mean". The owner's instruction was explicit: *"the
answer is probably focus/blur, but I don't want to rush that."*

The reason it is hard is the third constraint. The canvas has a selection that
survives clicking elsewhere; Monaco owns its own focus and must not have it stolen;
and **an agent has no focus at all**. "Add a node to the classify graph" names its
target in the instruction, so a target model that exists only as DOM focus is one an
agent cannot participate in. `roadmap.md` has the full statement.

Do not solve this by reaching for `document.activeElement`.

### The failure mode this project keeps producing

Every serious bug so far looked like working software from outside:

- Contract discovery was broken in **every deployed revision** because
  `python3-minimal` ships without the `json` module. Caught by a boot probe added one
  commit earlier, not by anything failing.
- A cached `410` survived page reloads and made a deleted project look permanently
  broken.
- An effect with a changing dependency aborted and retried its own fetches forever;
  the visible symptom was a flicker between two files.
- `GitHubSource.exists('.')` returned false because git trees have no root entry, so
  every repository project failed its own liveness check.

The boot probe and the deploy smoke test exist because of this and have each caught a
live one. **When adding a surface that can fail quietly, add the thing that makes it
fail loudly at the same time.**

### Practicalities

- **Stack:** TypeScript monorepo (npm workspaces) + a Python package. `packages/schema`
  is the one shared contract, imported by both the API and the browser. Fastify, React,
  React Flow (`@xyflow/react`), Monaco bundled and lazy-loaded, Vite, `yaml` (eemeli),
  node-pg-migrate.
- **GCP:** project `lantern-civil`, `us-central1`, Cloud Run + Cloud SQL (Postgres 17,
  `db-f1-micro`, edition `ENTERPRISE` — `ENTERPRISE_PLUS` rejects that tier and costs
  ~10× as much) + Secret Manager + Cloud Build. Around $20–25/month.
- **Six migrations, all applied against Cloud SQL.** Never rewrite one that has run.
- **The dev shim** supplies the same identity shape the OAuth path does, so there is
  one code path rather than two. There is no login locally.
- **`docs/deploy.md`** documents the one step that cannot be scripted.
