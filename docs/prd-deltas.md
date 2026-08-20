# PRD deltas

Places where the PRD was silent, self-contradictory, or where implementation forced a
choice. Each entry says what was decided and how to reverse it. Nothing here is a
complaint — a v1 PRD that specified all of this would have been guessing.

Anything marked **needs a call** is a decision the owner should make; the current
behaviour is a placeholder that works.

---

## 1. Node ids forbid underscores, but the example uses one — **resolved**

§6.4 is normative: `^[a-z][a-z0-9-]{0,63}$`. §6.3's example graph declares
`search_tools`, which that pattern rejects.

**Owner's call: widen the pattern.** `ID_PATTERN` is now
`^[a-z][a-z0-9_-]{0,63}$`, so a code node's id can match the Python module it points
at. The example keeps the PRD's own `search_tools` spelling.

**Consequence to watch:** two spellings of the same concept can now coexist across a
project and nothing forbids it. If that becomes noise, a lint rule is a better
remedy than narrowing the pattern, which would be a manifest migration.
**§6.4 of the PRD should be updated to match.**

## 2. Composition edges carry no `kind` — **resolved**

§4 says composition edges mean "depends-on / routes-to", two distinct relations. The
§6.2 example has no `kind` field, unlike graph edges which do.

**Owner's call: add it now,** before M3 writes real manifests and the change becomes
a migration. Composition edges now require `kind: routes-to | depends-on`.

Carrying the relation explicitly is what makes it checkable, so validation gained
rules the inferred version could not express:

| kind | source | target |
|---|---|---|
| `routes-to` | client | client or service, never a process |
| `depends-on` | service or process | service |

A process is never a `routes-to` target because it has a trigger, not a caller (§4).
Service→client stays a distinct diagnostic (`client-is-edge-target`) rather than
folding into these, because dragging an edge backwards is the likeliest way to
produce it and deserves its own message.

**§6.2 and §4 of the PRD should be updated to match.**

## 3. Diagnostics needed a `severity` the PRD's shape does not have

§6.4 specifies `{ file, jsonPointer, code, message }`, but also requires that a flow
cycle "mark it red, block Run — don't fail the save" while a subgraph containment
cycle is "rejected". Those are two different outcomes and the writer has to tell them
apart.

**Decided:** added `severity: 'error' | 'run-blocking'`. Also added optional `nodeId`,
`edgeId`, and `cyclePath`, because §6.4 requires diagnostics to "render on the
offending node" and to report "the full cycle path", neither of which is derivable
from a JSON pointer alone.

## 4. `civil.yaml` contents were never specified

§6.1 lists the file; nothing defines it.

**Decided:** a minimal `kind: Project` holding only what has nowhere else to live —
composition path, default model, language. See
`packages/schema/src/manifest/project.ts`.

## 5. The sync/async client default had no syntax

§8.1 says it is "configured on the client node where it's visible" and that Civil
infers the default from whether an agent appears on the flow path.

**Decided:** optional `invocation: { <serviceId>: sync | async }` on `api` and `mcp`
client nodes. Absent means inferred. Validation rejects an override for a service the
client does not expose. The inference itself is M4 work.

## 6. Added an io-direction rule §6.4 does not list

§5 says io nodes are directional specifically so the runner never meets a node that is
both source and sink, and that flow runs left to right. §6.4's rule list does not
forbid wiring *into* an input or *out of* an output.

**Decided:** enforced (`io-direction-violation`). It is the rule that makes §5's
justification true; without it you can draw the exact shape §5 says cannot exist.

## 7. The example's progress node is never wired

In §6.3's `classify` graph, the `thinking` io node has `kind: progress` but no edge
touches it. This validates fine — nothing requires an io node be connected — but it
means the PRD's one worked example never demonstrates emitting progress.

**Decided:** reproduced faithfully, including the dangling node. Flagged because when
M4 implements progress, this example will not exercise it.

## 8. Union errors are unwrapped before becoming diagnostics

Not a PRD gap, but a consequence of one. All three client flavours share
`type: client`, so composition nodes cannot be a zod discriminated union. A plain
union reports every branch's complaints, which is unusable on a node face.
`flattenIssues` in `validate.ts` picks the branch with the fewest issues.

## 9. "Write zero auth code" — kept, with one exception

§12 puts auth in IAP: no user table, no passwords, no sessions. That is followed
exactly — `owner_id` is the subject IAP asserts and there is no users table.

**The exception:** the `x-goog-authenticated-user-*` headers are trustworthy only if
nothing can reach the service except through IAP. That is an ingress setting, and an
ingress setting is one console click from turning the app into an open door that
still looks authenticated. So the signed assertion (`x-goog-iap-jwt-assertion`) is
verified against Google's JWKS in production. ~40 lines, in
`apps/api/src/http/identity.ts`.

Config refuses to boot on the combinations that fail open: a dev identity in
production, or verification enabled without an audience. Production without
verification is legal but warns loudly at boot.

**To reverse:** set `CIVIL_VERIFY_IAP_JWT=false`, which drops back to trusting the
headers. Only correct if Terraform has ingress locked to the load balancer.

---

## 10. IAP replaced by application-owned Google OAuth — **owner's decision, supersedes §12**

§12 puts auth in IAP: "write zero auth code", no user table, no sessions, and
"adding a person is an allowlist edit". §2 excludes multi-tenancy from v1 on the
grounds that there is one user.

**The owner chose to share the application instead.** That is incompatible with IAP
on this project: IAP's managed OAuth client admits "only users within the
organization", and a personal Google account has no organization, so the admissible
set is empty. Sharing was not a tuning problem; it was impossible.

### What changed

| | Before | After |
|---|---|---|
| Authentication | IAP, in front of Cloud Run | Google OAuth in the application |
| Ingress | Public, IAP-gated | Public, `roles/run.invoker` to `allUsers` |
| Identity | IAP-asserted subject | `users` row keyed on Google `sub` |
| Session | IAP cookie | Server-side `sessions` row, signed cookie |
| `owner_id` | IAP subject as `text` | `uuid` FK to `users(id)` |
| Who may sign in | One allowlisted email | Anyone with a Google account |
| Project visibility | n/a | One owner, invisible to everyone else |

Migration 001 was not rewritten. It had shipped and run against Cloud SQL, so 002
carries the change forward — which is what §2 means by real migrations from the first
commit, even while the tables are empty.

The cost §12 was avoiding is now real and paid: the OAuth dance, PKCE, `state`,
`nonce`, session issuance and revocation, cookie signing, and open-redirect
protection on `returnTo` are all code in this repo, covered by ten tests that each
fail *open* if the implementation is wrong.

### Tracked risk: open signup meets no sandbox — **revisit at M4**

§2 excludes "sandbox isolation of untrusted code" from v1. That was sound when the
one user ran only their own code.

With open signup, the exclusion means something different: **any person who signs in
can have Civil clone their repository and execute their code nodes and tools**, in a
process holding the database credentials and every other user's data, with no
isolation.

This is not yet live. There is no runtime — M4 builds it. Signing in today grants an
editor shell with nothing to execute, which is why the decision is safe to take now.

**The trigger is M4.** Before the runner executes its first user-authored code node,
one of these must be true:

1. Execution is isolated per run (a separate container or sandbox with no ambient
   credentials), or
2. Signup is closed back to an allowlist, or
3. The owner accepts the exposure explicitly, knowing it means arbitrary remote code
   execution by any signed-in stranger.

Recorded here rather than left implicit, because M4's exit criterion is about a graph
running end to end and would otherwise sail past this without anyone deciding.

---

## 11. No local file storage — **owner's rule, resolves a contradiction in §7 and §12**

Two rules in the PRD cannot both hold as written:

- §12: *"Never store repo contents as truth — any cache must be reconstructible by
  re-cloning."*
- §7: *"save writes to the working tree as a pending change… Nothing auto-commits."*

An uncommitted edit is not reconstructible by re-cloning. It exists in exactly one
place. So the PRD requires durable pending state and forbids storing it in the same
breath.

There is also a physical problem §12 does not account for: Cloud Run's filesystem is
in-memory, counts against the container's memory limit, and is destroyed whenever an
instance is recycled — which happens on every deploy and at Google's discretion. A
working tree on disk is not durable in the first place.

### The rule

**Nothing on the container filesystem may be the only copy of anything.** Everything
on disk must be reconstructible from Postgres, GCS, or GitHub.

This is §12's rule generalised rather than replaced. The carve-out it needs is small
and precise: pending edits are not repo contents, because they are not in the repo
yet. They are Civil's own state, in the same category as `runs` and `run_events`.

### What was considered and rejected

**Mounting a GCS bucket as a working tree.** Google's own documentation says Cloud
Storage FUSE is "unsuitable for applications requiring file locking, such as git or
other version control systems": no concurrency control, and rename cannot be atomic
because gcsfuse cannot meet the POSIX guarantee. Git's entire consistency model is
lock-write-rename-delete.

The owner asked whether single-user use dissolves this. Partly: file locking becomes
irrelevant with one writer. Two problems remain. Rename atomicity is about crash
safety, not concurrency, and Cloud Run kills containers as a matter of routine — the
usual result is a stale `index.lock` that wedges the repo until removed by hand.
Performance does not improve at all: git stats every file, and over FUSE each stat is
a network call.

**A local clone as a disposable cache, with the overlay as the durable record.** This
works and preserves three-way merge for §14 M3's conflict handling. It was rejected
because its one advantage — real `git merge` — only matters when someone else pushes
to the repo, and this is explicitly a single-user tool. The single-user framing does
not rescue the filesystem; it removes the only reason to want one.

### Consequences

- `working_trees` (migration 001) models a clone path and becomes obsolete. It is
  replaced by `pending_changes` in the M2 migration, not amended.
- §14 M3's "pull with conflict handling" is per-file rather than a three-way merge.
  `base_sha` per pending row detects divergence precisely; resolution is keep-yours or
  take-theirs. Adequate for one person, and the point to revisit if that changes —
  with Filestore, which is genuinely POSIX, not FUSE.
- M4's runner may materialise files to execute Python. That is ephemeral scratch
  derived from a pinned commit, and the rule permits it: the test is whether losing
  the container would lose anything.

**PRD §7 and §12 should be updated to state this directly.**


---

## 12. One project per repository — **owner's decision**

PRD §6.1 shows a project at the root of its tree but never says whether a repository
may hold more than one. `examples/doc-pipeline` inside this repository is a valid
Civil project living in a subdirectory, which made the question concrete.

A `root_path` column and a `SubpathSource` wrapper were built and tested, then
removed. **The owner's rule is one project per repository.**

It is the more opinionated answer and the one that costs less to hold: a project's
identity and a repository's identity stay the same thing, which the commit path, the
branch model, and `pending_changes` all already assume. Supporting subdirectories
would have introduced a second notion of "root" that every path-handling surface has
to agree about, and the first place it disagreed would be silent.

The migration was never committed and never ran against Cloud SQL, so it was removed
rather than reversed with a forward migration — `CLAUDE.md`'s rule against rewriting
applied migrations did not apply.

**One exception, at the owner's direction:** example projects. They ship inside Civil
and exist to be opened as quickstarts, so they are not a repository question at all —
a third source kind, with no repository and no commit destination. `examples/` is now
copied into the container image and offered from the empty state.

That does not weaken no-local-file-storage. Examples are immutable, shipped with the
code, and reconstructible by rebuilding the image, exactly like the SPA bundle;
nothing on that disk is the only copy of anything. Pending edits against an example
still live in Postgres like any other project, so a quickstart is explorable rather
than read-only — only committing has nowhere to go.


---

## 13. Boundaries split from clients — **owner's decision, revises §4's vocabulary**

The PRD's composition altitude had three node types, and its "client" bundled two
different things: the surfaces the platform generates (api, mcp) and the
applications people author that consume them (web). The owner split them:

- **`boundary`** — a generated surface over the services it exposes. Sub-types
  `api` and `mcp`. Carries `exposes` and `invocation` (§8.1's override lives here
  now, since the boundary is the surface being configured).
- **`client`** — a consumer: authored code in a directory. Sub-types `web` and
  `mobile` ("etc." reserved — the vocabulary stays closed, adding a platform is a
  commit to Civil). Carries `path` and optional `dev`.

Traffic is `client → boundary → service`, checked in both the validator and the
connect gesture. Nothing routes *to* a client; a client cannot skip the boundary;
a boundary exposes services, not other boundaries. `frontend` as a spelling is
gone — the example manifests now say `client: web`.

Two knock-on effects worth recording: the composition node union is a real
discriminated union again (all four types have distinct `type` values), so delta
§8's fewest-issues unwrapping matters less; and process triggers stay
schedule-only at the owner's direction, reaffirming §15 rather than extending it.

**§4, §6.2, §9.2–9.4 of the PRD should be updated to match.**

## 14. A code context is born role-less — **owner's design, refines §5 and §7.2**

A new code node used to arrive pointing at files that did not exist — instantly
red, and prescriptively function-shaped. The owner's rule: creation must not
choose between §5's two roles (capability target vs flow participant), because
the role is derived from wiring, not declared. Utility modules, class
architectures, harnesses — all legitimate interiors.

So creation scaffolds one docstring-only `__init__.py` and sets only `include`.
The typed identity handler (one input, one output — §7.2's i and o, in source
where contracts live) appears at exactly two moments: creating a function-backed
service, whose contract IS a function; and wiring a flow edge into a code node
with no entrypoint, at which point being a step is a fact and App.connectEdge
makes it true in the same gesture. Never over an existing file.

Every node kind that references files now scaffolds them as pending changes on
creation (agent.yaml + prompt.md, graph files, web/index.html), so no node
arrives broken. The Add-node dialog is two-step — type, then sub-type — because
a sub-type is a real decision and defaulting it would decide silently.


---

## 15. The PRD learned the truth: users, scoping, and the runner — **v1.1 amendment**

Unlike every entry above, this one changed the PRD itself. At the owner's
direction, §12 was rewritten to state what is already true and what M4 must make
true:

- **A users table exists** (delta §10's pivot, now in the design rather than
  beside it).
- **Projects are user-scoped**, and access is the only permission: whoever can
  open a project can edit and run it. No finer-grained layer, deliberately.
- **Execution is user-scoped**: project code never runs in a process holding
  platform credentials. This resolves the sandbox gate (roadmap) by decision
  rather than acceptance — the credential-free runner is now M4's first
  deliverable, not a deferred option.

The gate's trigger — "before the runner executes its first user-authored code
node" — stands, now with its answer chosen: isolation, built first.
