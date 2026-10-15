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
   `vite.config.*`, every `*.tf`, `docker-compose*.y(a)ml` / `compose*.y(a)ml` and
   `*.prisma`, then README.md and `docs/**/*.md`. Excluded:
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
   - `reader-stores.ts` reads datastores and which services use them (below,
     "Datastores").
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

## Claims

Decided with the owner 2026-10-10. Pillar 2 of Civil's value — interpreting a
codebase into a graph — is built so that several independent agents can analyse a
repository without the result depending on any one of them. They do not write
documents; they propose **claims** (`lift/claims.ts`), and only what survives is
drawn.

- **Altitude.** Claims are made at the canvas's altitude: servers (deployables),
  clients, services, agents, background work, and the relations between them
  (depends-on, exposes, calls, uses-agent). Routes, operations, and functions are
  attributes of those claims, never claims of their own — Civil verifies what the
  graph shows, nothing smaller.
- **Evidence.** Every claim cites where in the code it rests (file, line, an exact
  quote). Evidence is checked mechanically — no model: the file exists, the line is
  inside it, the quote appears near the line. Evidence that does not hold counts for
  nothing.
- **Weighing.** Claims about the same thing become one belief. High: the reader
  supports it with sound evidence, or two independent voices do. Medium: one other
  voice does. Low: contested, or with evidence problems. Dropped: refuted (with sound
  evidence) by as many voices as support it — a refutation citing nothing never
  outweighs code read exactly. A relation needs both ends believed.
- **The reader is one voice.** Its findings enter as claims like any other — strong,
  because it reads code exactly, but not infallible (a test double is not an agent).
  Restating them is lossless: reader → claims → skeleton reproduces the reader's
  skeleton exactly (tested, and checked on real repositories), so the mapper, Update's
  merge, and the registry see nothing new until another voice speaks.
- **Provenance on the graph.** Each drawn unit's confidence and a handful of cited
  places go into civil/registry.yaml (`confidence`, `evidence`), so the graph can say
  how sure Civil is and why. There is no review step (owner's call): Civil has to be
  trustworthy on its own, uncertain parts are shown as uncertain, and the author
  corrects by editing the graph, which Update respects.

### The agent stage (analysts and verifiers; interpretation beside them)

`lift/analysts.ts` splits the repository into areas. When the reader found levels
(see "Views"), each domain is an area that carries the domain — its name, members,
unsure members and frontend surfaces — and the rest of the source shares at most six
areas by directory. Without levels, areas are by directory (a directory over 80 source
files is split by its subdirectories, small siblings share an analyst, at most 12
areas). Infrastructure files are an area of their own either way. The runner
(`runner/analyze.py`, POST /lift/analyze) gives each area to an **analyst** with
read-only tools over the files the API sent (list, read with line numbers, search) and
a bounded budget, ending in one forced `submit_claims`. Each analyst's claims then go to
a **verifier** that is shown the claims but not their evidence and must check each
against the code itself: support or refute. Analysts read any language, so when the
agent stage runs, the lift also loads the source files the reader does not understand.

**Domains are claims** (2026-10-13). The reader claims each domain and what it holds,
except members it placed on weak evidence. A domain's analyst names it (a reader name
from a directory gives way to an analyst's), describes it in one sentence, places its
unsure members with `contains` claims, and may refute it. A member goes where the
strongest live `contains` puts it (confidence, then voices), otherwise where the reader
put it; no domain is ever inside itself.

**How the prompts are written** (owner's rules, 2026-10-13). What can be decided from
the code is decided in code — reach, containment, roll-up, readability — and the model
is asked only what needs judgement: names, descriptions, unsure placements, and the
reading of flow and architecture. The prompts in `runner/analyze.py` and `runner/interpret.py` follow technical writing rules:
imperative mood, one instruction per sentence; each term defined once, with the
schema's word; checkable criteria rather than adjectives; no emphasis; no reasons
(those live in code comments and here); lists over prose; an example only when it
settles an ambiguity. Each prompt has a word budget its tests enforce.

Nothing the runner returns is trusted: claims are re-validated on the API side (a voice
may not speak as the reader, evidence must name listed files), and a new entity's
skeleton fields are filled only from its own claim — a process with no stated schedule
says "@unknown" rather than a guessed cron. Any failure leaves exactly the reader's lift.

**Behind the button** (stage 3, 2026-10-11). When a runner is configured, Generate /
Update graph from repo runs the agent stage:

- **One area per runner call**, a few at a time, so progress is real: the lift reports
  its stage (listing, reading, analysing *n of m areas*, refining, writing) to
  `lift_runs` (migration 9) under an id the client chose, and the canvas polls
  `GET /api/projects/:id/lift-runs/:runId` while the request is open. A failed area is
  reported and the others still count.
- **A memo per area** (`lift_area_memos`): an area's claims are kept under a fingerprint
  of its files, the reader's claims about it, the runner's analyze prompt version and
  model. An Update re-asks only areas whose code changed, so an unchanged repository
  proposes nothing (tested byte-for-byte) and a small change rewords only its area. A
  runner that cannot say its version gets nothing reused.
- **Provenance on the graph**: each unit's confidence, cited places, and voices (reader,
  analysts, verifiers) are in the registry and reach the inspector through liftStatus.
- **Time**: a first read of a large repository takes minutes — eight areas at a time,
  inside the API's 1800s request timeout (infra/terraform/run.tf). Later Updates reuse
  unchanged areas.

The CLI keeps `--analyze` for evaluation without the app.

First live run, on Civil's own repository (which the reader cannot read at all): 6
areas, 136 claims, 5 disbelieved by verifiers; the API, runner and session service,
their services, all six agents, and both kinds of background work were found. Lessons,
next: merge entities that two voices name differently but anchor in the same code;
keep example and sample apps out of the product's graph; ask explicitly for the calls
between deployables.

Second run, with all three (2026-10-11): exactly three deployables, the example app
left out and said so, and the calls between deployables found (the API's transpile,
lift and run services call the runner; the runner posts back to the API). What it
taught next: two agents in one file are two agents, so entities other than
deployables merge only when their names are related too; and two things Civil's
graph cannot yet say — a service calling another deployable, and data stores
(Postgres, a bucket) — which the lift now reports instead of dropping. Whether to
add them to the closed node and edge vocabulary is the owner's call. Run-to-run
variance (one analyst per area notices different things) is the open stability
question for stage 3.

## Reading composition that is built, not written

Added 2026-10-10, general rules recognised by code shape (never a project's names):

- **Static module factories.** A module produced by `X.m(...)` (forRoot, register, a
  project's own composition-root factory) is read by following `m` into `X` and taking
  every object literal it can return — union over branches, spreads, local consts,
  nested factories. An entry behind a recognisable check (`profiles.includes("web")`,
  `mode === "worker"`) records the value, so a server lists which services each role
  loads (`SkeletonServer.roles`).
- **Declaration registries.** An exported array whose elements are `@Controller`
  classes, or objects built by a `define*`/`create*`/`make*`/`register*` call with a
  contract-like argument, is a declaration: listed controllers are served even if no
  `@Module` names them; a directory of such declarations no module owns becomes a
  service; declarations attach to their service as `operations` (attributes, never
  nodes — with which are exposed to an agent as tools); scheduled ones are processes.
- **Custom route decorators.** A controller method's decorator that the repository
  defines is followed to its definition (imports, consts, a function or a factory that
  returns one, depth-limited) until it reaches Nest's own `Get`/`Post`/`Put`/`Patch`/
  `Delete`/`All`/`Options`/`Head` or `RequestMapping`, inside `applyDecorators`, an
  array, or returned directly. The outer function's parameters are bound to the
  arguments written at the use site, so a path passed through is the controller's, a
  literal inside is itself, and a path read from the argument (`spec.web.at`) is
  read from the object the use site names (a call with one object-literal argument,
  `defineEndpoint({...})`, is read as that object). A path that cannot be fixed is
  drawn as `<computed>` and reported.
- **Agents by file convention.** `<name>.agent.ts` anywhere, or `<name>.ts` directly in
  an agent/ or agents/ directory (not index, types, prompt, tools and the like), that
  exports a class, function or object is the agent `<name>` — whatever it calls the
  model through, an SDK or the project's own gateway. It owns its same-prefix parts
  (`<name>.prompt.ts`, `<name>.output.ts`, `<name>.tools.ts`); its tools are what a
  `tools` property or exported `…tools` array lists (code, names, or `{ name }`
  objects, through a const holding the list). Services that import its files use it,
  as with every agent. The SDK rule (import a model SDK and generate) still applies to
  everything else.
- **Feature labels.** A service found through a declaration registry is labelled by its
  directory: `orders` → `OrdersFeature`, never its registry array's name.
- **Test support is not product code.** testing, test-support, fixtures, `__mocks__`,
  mocks and fakes directories, and fake/mock/stub/integration/live/e2e files, are left
  out of path selection and of agent, service, and process detection.

## Datastores

Added 2026-10-11 (`reader-stores.ts`), general rules by shape:

- **Declared in Terraform.** A `resource` of a managed-store type is a datastore:
  `google_sql_database_instance` (engine from `database_version`: POSTGRES_* →
  postgres, MYSQL_* → mysql, SQLSERVER_* → sqlserver), `google_alloydb_cluster`,
  `google_storage_bucket` (gcs), `google_redis_instance`/`_cluster`,
  `google_firestore_database`, `google_pubsub_topic`, `google_bigquery_dataset`,
  `google_spanner_instance`, `google_bigtable_instance`; `aws_db_instance` and
  `aws_rds_cluster` (engine from `engine`), `aws_s3_bucket`, `aws_elasticache_cluster`/
  `_replication_group`, `aws_memorydb_cluster`, `aws_dynamodb_table`, `aws_sqs_queue`,
  `aws_docdb_cluster`, `aws_opensearch_domain`/`aws_elasticsearch_domain`; azurerm
  postgresql, mysql, mssql, storage account, redis cache and cosmosdb. The id is the
  resource name; a placeholder name (this, main, default, primary, instance) gives way
  to the block's own fixed `name`, else to the merged compose service's name, else to
  the engine. Terraform's own state buckets (`tfstate`/`terraform-state` in the name,
  or a bucket a `backend` block names) are not the application's and are left out.
- **Declared in docker-compose.** A service of `docker-compose*.y(a)ml` or
  `compose*.y(a)ml` whose image (last path segment, tag dropped) is a well-known store:
  postgres (also postgresql, postgis, pgvector, timescaledb), mysql (also mariadb,
  percona), mongo, redis (also valkey, keydb, dragonfly, redis-stack), rabbitmq,
  elasticsearch, opensearch, kafka (also cp-kafka, redpanda), nats, memcached, mssql,
  cockroach; local stand-ins count as what they stand in for (minio → s3,
  fake-gcs-server → gcs). The id is the compose service name.
- **Named in a Prisma schema.** A `datasource`'s `provider` (postgresql → postgres,
  mysql, sqlite, mongodb, sqlserver, cockroachdb). A datasource points at a database
  rather than creating one, so it is a store of its own only when nothing else
  declares that engine.
- **One per engine when unambiguous.** When every source declares at most one store of
  an engine, they are the same store (compose for local development, Terraform
  deployed, Prisma pointing at it), named Terraform first, then compose, then Prisma.
  When a source declares several of an engine, all are kept apart; nothing is merged.
- **Usage.** A service uses engine E when one of its own files imports a client for E —
  pg, postgres, pg-promise, @neondatabase/serverless, drizzle-orm/node-postgres (and
  the other drizzle dialect paths); mysql, mysql2; better-sqlite3, sqlite3, @libsql/client;
  mongodb, mongoose; ioredis, redis, @redis/client, bull, bullmq; @google-cloud/storage,
  /firestore, /pubsub, /bigquery; @aws-sdk/client-s3, client-dynamodb, client-sqs;
  amqplib, kafkajs, nats, @elastic/elasticsearch and others listed in the file —
  directly, or through one in-repo module it imports that does (followed through
  barrels to the declaring file, one level). `@prisma/client` takes the Prisma
  provider's engine; ORMs that serve several engines (typeorm, knex, kysely, sequelize,
  drizzle-orm, MikroORM) take the engine of the one database driver their package (or
  the root) depends on. Type-only imports are not use. The store joins the service's
  `dependsOn` only when exactly one store has that engine; several is reported in
  `unresolved` as ambiguous, none as a client with no declared store. The
  infrastructure module that owns the client wrapper uses the store too.

## Views

Added 2026-10-13, revised 2026-10-14. The lift writes the composition (every part and
edge, no grouping) and, when a runner is configured, two readings beside it: **flow**
(how the application thinks) and **architecture** (what it is built on). How they are
read is docs/interpretation.md. Capabilities, found as below, are the unit a flow is
traced in, and the area each analyst reads.

How capabilities are found:

Units are found by what the code **reaches**, not by where it is filed. Folder layout
is a filing choice (an MVC app files every model together); what belongs together is
what is reached together.

1. **Surfaces.** A client's feature root is the conventional directory (`features/`,
   `pages/`, `modules/`, `views/`, `screens/`, `routes/`, `areas/`, `domains/`,
   `apps/`) with the most child directories, at least two; each child is a product
   surface.
2. **Reach.** Each surface's imports are walked within its client, and each service's
   within its own files, collecting what each reaches outside itself — a contract, a
   route table, a type in a shared package. A file most units reach (a base contract, a
   client helper) says nothing and is ignored.
3. **Links.** A surface is the frontend of the service it shares reach with: the
   service named like it, when that one is linked; otherwise the best match and any
   near tie. Other services it reaches are services it uses.
4. **Capabilities.** The linked services, joined when one surface spans several (then
   named for the surface). Without surfaces, the services a server serves that nothing
   else depends on.
5. **Membership.** A service no surface fronts is inside the one capability that uses
   it (through other such services, or through a surface); used by several, or by
   none (marked unsure), it is in the **foundation**. Scheduled work goes with the
   services it runs; a store goes inside the one capability that uses it, else stays
   at the top.
6. **Readability.** A foundation over twelve is split by the directory its code is
   filed in — layout as supporting evidence, never as the decider. A domain holding one
   thing is that thing. A top level still over twelve is noted for the model to judge.

Each capability carries its evidence (the surface, the shared files) and its unsure
members, which the area analysts are asked to place.

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

- A view switch (Parts, Concept, Architecture…; `v` cycles). In a view each level is
  laid out on its own grid; a domain's card counts what it holds and descends into
  its inside, and the inspector shows its description, members, evidence and file.
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

- **Unmounted features with several roots.** A service found through a declaration
  registry that nothing mounts is attached to the first root even when there are several.
- **Custom route decorators that compute their method** (`RequestMapping({ method })`
  from a value the source does not fix) are reported, not drawn; one that computes its
  path is drawn at `<computed>` and reported.

- **Datastores outside Terraform, compose and Prisma** (Pulumi, CDK, Helm charts, a
  connection string only in an env file) are not read; a service whose client has no
  declared store is reported, not drawn. Several stores of one engine are never
  attributed to a service (which bucket a client writes to is runtime configuration),
  and a compose store merges with a Terraform one only by engine, not by name.
- **Schedules outside Terraform** (a gcloud YAML, a Kubernetes CronJob) are not
  read; the internal routes they call still show on the internal boundary.
- **Agents bound behind injection tokens** in a different module from their
  consumer are attributed to the module that binds them (an agent bound by a
  worker root but called from a feature module's job code).
- **A root module that declares only plumbing** (health, version, lifecycle) is
  infrastructure; its boundary stands for it on the canvas.
- **A large GitHub repository** costs one blob request per selected file, up to
  the 2,500 cap; reads are cached per commit.
