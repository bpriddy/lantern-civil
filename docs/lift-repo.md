# Lift a repository: Generate / Update graph from repo

Design note, 2026-10-05. The macro form of `docs/lift.md`: lift.md reads one
graph's flow back out of code Civil emitted; this reads an **existing codebase
Civil never saw** and writes Civil's own documents for it. First target: a
NestJS server plus a Vite React client in one repository.

## The gesture

One named command, `project.liftRepo` (key **U**). It reads **Generate graph from
repo** on a project with no composition and **Update graph from repo** once it
has one. It is also a button in the empty project tree and a row in Source
control. It calls `POST /api/projects/:id/lift-repo`.

The result is **pending changes and nothing else**. Nothing is committed and
nothing is applied without the author seeing it (CLAUDE.md). The author reviews
the proposal in the diff panel, discards what they don't want, and commits the
rest.

The files it proposes:

| Path | What |
|---|---|
| `civil/civil.yaml` | `spec.language: typescript`, `spec.composition: civil/app.yaml` |
| `civil/app.yaml` | clients, one api boundary per deployment, product services, schedules, edges |
| `civil/graphs/<service>.graph.yaml` | one per service that uses agents: its code, the agents, their tools |
| `civil/registry.yaml` | which repo files each node stands for (`role: repo`, content hash); the rest under `shared` |
| `civil/architecture.md` | what was found, in prose: nodes, routes, infrastructure, what is unresolved |

## The pipeline

`apps/api/src/lift/`, orchestrated by `index.ts` (`liftRepository`):

1. **Select** (`read.ts` `selectLiftPathsReport`). Every package.json and
   tsconfig, the root workspace file (`pnpm-workspace.yaml`, `.yarnrc.yml`,
   `bunfig.toml`), the .ts/.tsx files under each package's `src/`, each
   `vite.config.*`, every `*.tf`, then README.md and `docs/**/*.md`. Excluded:
   node_modules, dist, build, e2e, tests, `.terraform`, `*.spec`, `*.test`,
   `*.d.ts`, lockfiles. Capped at 2,500 files, code before prose. Hitting the cap
   is reported first in the diagnostics, never silently; so is a selected file
   that did not come back, and a truncated GitHub listing.
2. **Load** through the project source's `ensure` + `read` into an in-memory
   `FileMap`. There is no clone and no working tree; every reader is a pure
   function over that map.
3. **Read** (`readRepo` → `nest.ts`, `vite.ts`). This uses the TypeScript
   compiler API's parser only, with no Program and no type checker.
   - A package depending on `@nestjs/core` is a server; one with `vite` plus a
     script that runs its dev server is a client.
   - The server is read the way Nest reads it: bootstrap → root module → module
     imports, controllers, providers → routes with the global prefix → services,
     agents and scheduled processes.
   - A bootstrap that picks its root (`mode === 'worker' ? WorkerModule :
     AppModule`) is one package deployed twice, so each root is its own server
     with its own routes. One that serves nothing under the global prefix while
     the other does is `internal`: clients are not linked to it.
   - Every code file has one owner. A module alone in its directory owns the whole
     directory; a module beside the bootstrap owns its own file, its controllers,
     and the same-directory helpers they import. Files under an agent directory are
     the agent's. The rest is the server's `sharedFiles`.
   - An agent reached only through another agent's code (a scorer inside an
     analyzer) is recorded in `agentsVia`, and its graph draws agent → agent.
   - A service whose code names another deployment's internal route (a queued
     task's path constant) `dispatchesTo` that route's service: a depends-on edge.
   - `schedules.ts` reads Terraform `google_cloud_scheduler_job` blocks: the cron
     and the path their uri ends in (through the module's string `locals`). A job
     whose path is a route becomes a process calling that route's service; one
     that is not is reported in `unresolved`, never drawn as a guess.
   - The output is a `Skeleton` (`skeleton.ts`, the shared contract). Whatever
     can't be resolved goes to `unresolved` with a reason. Nothing is guessed.
   - A repo with no framework the reader knows gives an empty skeleton and a
     reason; it never throws. The route answers 422 `nothing_recognized` and
     writes nothing.
4. **Refine**, optional (`refine.ts` → runner `POST /lift/refine` → `runner/refine.py`).
   The model may only:
   - **rename** ids it was given, one to one, to valid ids;
   - **mark** services as infrastructure;
   - **describe** an id in at most two sentences;
   - write a **summary**.

   It can't add or remove anything, and it can't file a service that serves
   routes, runs agents, or is a deployment's root under infrastructure — both
   sides drop such a call and the note says so. A summary that arrives
   JSON-encoded is decoded to prose. The runner validates the answer and retries
   up to three times; the API validates it again. If there is no runner or any
   failure, the deterministic skeleton is used, and the `note` says why — unless
   an earlier lift recorded an answer, which is then reused (below).
5. **Map** (`to-documents.ts`, `documents-*.ts`) into the files above. The
   output is validated with `@civil/schema` (`zProject`, `validateProject`) and
   anything reported is returned as diagnostics. A lift of a supported repo is
   expected to have none.
6. **Land** (`http/lift-routes.ts`): each file goes through `savePending`.
   - A file that already says exactly this is skipped.
   - A file whose proposal equals HEAD only has its pending row dropped.
   - So an Update over an unchanged repository proposes no change at all.

### The refine wire shape

Request `{ skeleton, docs }`:
- `skeleton` is `skeletonSummary(...)`: ids, paths, files, controller and
  provider names, dependsOn, agents, infrastructure, a route count with up to 12
  samples per server, and an unresolved count.
- `docs` is `{ path: markdown }`. The runner caps docs at 60k characters,
  README first.

Responses:

| Status | Body |
|---|---|
| 200 | `{ refinement: { renames, infrastructure, descriptions, summary }, attempts, docsCut, promptVersion }` |
| 400 | malformed body |
| 422 | `{ error, issues, attempts }`, validation exhausted |
| 502 | no model client, or the model failed |

`descriptions` and `infrastructure` use the ids after the renames.

### Asked once per version of the code

The model words things differently each time it is asked. If every Update asked
again, an unchanged repository would still produce a diff of rephrasings.

So the registry records what the lift was read from:

```yaml
lifted_from:
  fingerprint: sha256:…   # the reader's skeleton + the docs the model was shown
  refinement: { … }       # the validated answer, absent when there was none
```

On Update, if the fingerprint is unchanged and an answer is recorded, that answer
is re-validated against today's skeleton and reused, and the model isn't called.
Re-validation is lenient: an entry about something that has since gone is
dropped on its own, not with the whole answer. The fingerprint ignores line
numbers, so moving code down a line asks nothing new. Any other change to the
code or the docs moves the fingerprint, and the model is asked about the new
code.

If that call fails (or there is no runner), the recorded answer is reused anyway
and the note says so: a failed call should not take back names and words the
author already reviewed. It is recorded under its old fingerprint, so the next
Update asks the model again.

## Update: the merge

The rules are written out at the top of `documents-merge.ts`; in short:

- **Nothing is removed.** A node the lift no longer finds is kept. It is flagged
  as stale if the previous registry recorded it as lifted, and reported as the
  author's own addition otherwise.
- **A deletion sticks.** A lifted node the author removed (its registry unit is
  gone from the document, and no node could be it renamed) is not added back,
  nor are edges to it. The registry remembers it in `lifted_from.removed`, so the
  next Update does not forget; adding the node back by hand ends that.
- **The author's ids win.** A node is matched by id, then by the files the
  previous registry recorded for its unit, then by its path or entrypoint, then
  by a canvas rename. A rename on the canvas survives every later Update, and so
  does an id the model would now name differently.
- **The author's layout wins.** New nodes are placed in their column, clear of
  everything already placed.
- **The lift owns only what it reads from code.** That is a client's directory
  and dev command, a boundary's routes, a service's implementation, a schedule,
  and a code node's files. Display names are only filled in when they are empty.
  `exposes` and `calls` are unioned.
- **Every change is a manifest op**, spliced into the existing text, so the
  author's comments and formatting survive and an unchanged node costs no bytes.
  A document with no `layout:` block (schema-valid) gets one before new nodes
  are placed.
- **civil.yaml's composition is the one merged into**, wherever it points. If it
  names a file the project doesn't have, civil.yaml is pointed at the one
  written, and the diagnostics say so.

## Projects it refuses

Refused with 422 and a reason, before anything is read into the project:

- **A Python project Civil generates for**: civil.yaml says python, the
  composition has nodes, and the registry is not a lift's (no `lifted_from`).
  Reading it would switch it to TypeScript and drop the registry's record of
  what Apply generated. The command is not offered there, and Source control
  says why.
- **Documents still at the repository root** (`civil.yaml` with no
  `civil/civil.yaml`): a new civil/civil.yaml would shadow them. Move into
  civil/ first.

Only a server makes a project TypeScript: a repository whose only app is a Vite
client leaves civil.yaml's language alone.

## A TypeScript project generates nothing

`civil.yaml` `spec.language` is `python` (the default, so every earlier project
is unchanged) or `typescript`. A lifted project is `typescript`: **the
repository's own code is the implementation**, and `civil/registry.yaml`
records it with `role: repo`.

Civil's generator emits Python only, so it never runs for a TypeScript project:
- `applyState` reads `unsupported`.
- `transpileProject` refuses with 409 `language_unsupported` before any model or
  database work, and so does composition Run, which calls it.
- `currentEmission` never offers `repo` files for revision.
- The UI says "Code generation isn't available for TypeScript projects — the
  repo's code is the implementation." where Apply would be.

Generating Python next to the repo's TypeScript would be two implementations of
one design, and Civil refuses to make one.

Commit isn't held. Only a `stale` Python sketch blocks a commit, and a
TypeScript project is never stale.

## Development only

`apps/api/scripts/lift-dir.mjs` runs the same pipeline over a local directory
and writes the documents to an output directory. It exists for evaluating the
reader on real repositories. It reads the disk, which the server never does, so
it is not a server path and is not part of the product.

## The canvas

- Services are laid out in columns by dependency: each sits right of what
  depends on it, at most four service columns; processes sit beside the
  boundaries. Generate fits the view to the result.
- Depends-on edges are dashed without a label.
- A lifted service's card counts the files its registry unit lists, and opens
  them; a graph with no io nodes shows what it holds ("3 nodes · 2 agents").
- The inspector shows a lifted node's description and files.
- The result stays on screen until dismissed, and under the Source control row
  after that, with links to architecture.md and the diff.
- Run is disabled on a TypeScript project, with the reason as its title.

## Known gaps

- **Schedules outside Terraform** (a gcloud YAML, a Kubernetes CronJob) are not
  read; the internal routes they call still show on the internal boundary.
- **Agents bound behind injection tokens** in a different module from their
  consumer are attributed to the module that binds them (an agent bound by a
  worker root but called from a feature module's job code).
- **A root module that declares only plumbing** (health, version, lifecycle) is
  infrastructure; its boundary stands for it on the canvas.
- **A large GitHub repository** costs one blob request per selected file, up to
  the 2,500 cap; reads are cached per commit.
