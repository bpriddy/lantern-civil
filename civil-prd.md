# Civil — PRD v1

*A web IDE for building applications at graph altitude.*

**Audience:** Claude Code, building this. Plus the human reviewing it.
**Scope:** Core functionality only. Roadmap in §14, open questions in §13.
**Users:** One. See §2.

---

## 1. What Civil is

Civil is a bet that the next altitude of application development is the graph, and that AI and graph orchestration will be pervasive enough that building at that altitude is simply how applications get made.

It is a web IDE for building **whole applications**, not just their agent parts. The visual editor is the primary interface and the killer feature, but a Civil project is a complete app: clients, services, background work, and the code underneath all of it.

The navigation model is TouchDesigner's. Double-click descends into a context. You are then *inside* that context, not looking at it in a panel.

**Two altitudes, and the boundary between them is a descent:**

| | Composition canvas | Dataflow graph |
|---|---|---|
| Where | Top level | Inside a service |
| Nodes | clients, services, processes | agents, io, subgraphs, code |
| Edges mean | depends-on / routes-to | data flows |
| Run means | nothing — it is structural | execute the graph |

Keeping the two edge semantics on separate canvases is load-bearing. An edge that means "this route calls that handler" and an edge that means "this output feeds that input" look identical and mean unrelated things; they must never share a surface.

**The repo is the truth.** Everything the canvas shows is a projection of files in git. Anything Civil knows that git doesn't is a bug.

**Civil does not deploy.** Code is versioned in git and deployed from there by whatever the project already uses. Triggering a deploy from Civil is a later feature (§14).

## 2. Constraints that shape everything

This is a personal tool. One user, one owner, no growth plan. That is not an apology — it's a design constraint that removes most of what makes software slow to build.

**Not in v1, and not because of time:** multi-tenancy, RBAC, orgs, teams, presence, password flows, quotas, rate limiting, onboarding, empty-state tutorials, coverage targets, adoption metrics, sandbox isolation of untrusted code.

**Still required, because retrofitting them is brutal:**

- An `owner_id` on every table from the first migration, even with one owner.
- Real migrations from the first commit. Never `create_all()`.
- Secrets in env and Secret Manager, never in the repo.
- One command to run locally, one to deploy Civil itself.
- A typed contract shared between client and server — one schema package, both import it.
- Structured logs with a request id on every line.

**"Shippable" means:** someone else could deploy it from a clean checkout, and future-you can change it in six months without an archaeology dig. It does not mean it withstands load or abuse.

**Tests:** two that matter, both guarding silent corruption of real repos — the YAML round-trip test (§6.5) and the manifest validator (§6.4). Everything else you'll notice by clicking.

## 3. Principles for saying no

These exist to be quoted back at future feature requests.

**Node types are units of architecture, never units of computation.** A node earns its place by being something you'd draw on a whiteboard. Agents, services, graphs, processes — architecture. HTTP calls, transforms, conditionals, loops, retries — computation, and there is a perfectly good code editor one double-click away.

The failure mode this prevents is seductive rather than obviously wrong. Add an HTTP node and you need auth config on it, then retries, then pagination, then response mapping, then a transform node to reshape the result. Each step is individually reasonable and the end state is a visual programming language that is worse at programming than the language underneath it, on a canvas where most nodes are plumbing rather than architecture.

**Code nodes are the pressure valve.** Anything that would tempt you into a utility node is a function in a code node instead — five boxes collapse into one, and the canvas stays legible.

**The node type list is a closed set, edited by hand.** There is no plugin API, no node SDK, no custom node manifest format. Adding a node type is a commit to Civil, not a feature of Civil.

This is not laziness. Any extensibility mechanism creates pressure to use it: you end up designing for a hypothetical author, versioning a public interface, and defending combinations you never intended — for an audience of one who could just edit the source. It also protects the experiment. Civil's premise is that graph altitude is the right altitude. A closed vocabulary is what makes that testable: if the set stays small and applications still build cleanly, the thesis holds. Wanting fifteen node types is a real signal, and an extension mechanism would hide it by letting the sprawl happen unnoticed.

**External dependencies are not nodes.** A third-party API, model provider, or MCP server you consume is a library call inside a function. Rendering them as nodes turns the composition canvas into a dependency graph, which is a different and worse diagram. A badge on the service node is the most they get.

## 4. Composition layer

The top-level canvas. Three node types.

### client
Something that consumes your backend.

- `frontend` — an app you build. Descends into Monaco. See §9.4.
- `api` — a generated HTTP boundary. Wired to the services it exposes.
- `mcp` — a generated MCP boundary. Wired to the services it exposes.

`api` and `mcp` are not authored; they are generated from the io nodes of the services they expose (§9). Wiring them explicitly means the canvas shows what is reachable from outside — a service with no client attached is not exposed, and the picture says so.

### service
A unit of server behavior with a typed contract.

Descending shows the best available view of its interior:
- If the service is implemented as a graph → the dataflow canvas (§5).
- If it is implemented as a function → Monaco.

**These are not two categories. They are one thing at two resolutions.** A service is legible to Civil or it isn't; either way the contract and the invocation are identical. That means a plain function can become a graph later with nothing upstream changing.

Most of a real application is ordinary services. The graph is where the interesting ones live.

### process
Work that initiates rather than being called. Cron, queue consumers, event handlers. Has a trigger, not a caller.

Processes are their own type because they are the thing you most easily forget exists — unattended work should be visible on the map, not discovered in a config file.

### Edges
`depends-on` / `routes-to`. Never dataflow. Nothing executes at this altitude; Run has no meaning here.

## 5. Dataflow layer

Inside a service implemented as a graph. Four node types, two leaves and two that descend.

| Type | Descends into | Edited via |
|---|---|---|
| `agent` | — (leaf) | Inspector |
| `io` | — (leaf) | Inspector |
| `subgraph` | A canvas | Descent |
| `code` | Monaco | Descent |

**No blended contexts.** A node is a canvas or it is code. Never both.

### agent
A leaf. Objective/system prompt, model, and — via capability edges — the tools it may call. No descent; everything is inspector-editable, with the prompt in a monospace editor.

### io
A leaf at the graph boundary. Directional: `in` or `out`, never both. Has a name and a JSON Schema.

IO nodes are the service's contract. Client nodes generate their surfaces from them: inputs become request schema and MCP tool parameters, outputs become response schema and stream event types.

Directionality is deliberate. A bidirectional node is a source and a sink at once — a cycle the topological runner would have to special-case and every layout algorithm would have to be told to ignore. Inputs left, outputs right, flow left to right.

A subgraph's boundary ports *are* its io nodes seen from inside. Editable from inside; the parent's node face updates to match.

**Progress is an io convention.** An output node may be marked `kind: progress`. Anything emitted to it becomes SSE events on an api client and `notifications/progress` on an mcp client. Whether an agent exposes intermediate thinking is an app-level decision expressed in the graph, not a runtime setting, and both surfaces inherit it without separate configuration.

### subgraph
A reference to another graph file. Double-click descends as a continuous transform, not a page load. Node face shows its io nodes as ports.

### code
A named set of files, playing either of two roles:

- **Capability target** — an agent calls a function in it. Dashed edge, no ordering.
- **Flow participant** — it *is* a step. Solid edge, ordered.

So `io → code → agent → code → io` is a legal graph. Deterministic parts of an application stay deterministic instead of being laundered through a model — parsing, validation, retrieval, and formatting shouldn't cost a model call.

Tools are not their own node type in v1. An agent references a function inside a code node.

### Edges
- `flow` — solid, arrowed, ordered. Participates in topological execution.
- `capability` — dashed, unarrowed. An agent may call this function. No ordering; ignored by the runner's sort.

## 6. Repo format

### 6.1 Layout

```
my-project/
├── civil.yaml            # project config
├── app.yaml              # composition canvas
├── graphs/
│   ├── classify.graph.yaml
│   └── enrich.graph.yaml
├── agents/
│   └── classifier/
│       ├── agent.yaml
│       └── prompt.md
├── schemas/
├── fixtures/
├── src/                  # services, steps, tools, platform code
├── web/                  # frontend
└── .civil/               # gitignored
```

### 6.2 `app.yaml` — composition

```yaml
apiVersion: civil/v1
kind: Composition
metadata:
  id: doc-pipeline
  name: Document Pipeline
spec:
  nodes:
    - id: web
      type: client
      client: frontend
      path: web
      dev: "npm run dev"

    - id: public-api
      type: client
      client: api
      exposes: [classify, save-record]

    - id: agent-tools
      type: client
      client: mcp
      exposes: [classify]

    - id: classify
      type: service
      impl: { graph: graphs/classify.graph.yaml }

    - id: save-record
      type: service
      impl: { entrypoint: src/services/save_record.py }

    - id: nightly-reindex
      type: process
      trigger: { kind: schedule, cron: "0 3 * * *" }
      calls: [classify]

  edges:
    - { id: c1, from: { node: web },        to: { node: public-api } }
    - { id: c2, from: { node: public-api }, to: { node: classify } }
    - { id: c3, from: { node: public-api }, to: { node: save-record } }

layout:
  nodes:
    web: { x: 40, y: 120 }
    public-api: { x: 260, y: 120 }
    classify: { x: 500, y: 60 }
    save-record: { x: 500, y: 220 }
    agent-tools: { x: 260, y: 300 }
    nightly-reindex: { x: 500, y: 380 }
```

Note `classify` and `save-record` are both services and are referenced identically. One is a graph, one is a function. Nothing upstream cares.

### 6.3 `*.graph.yaml` — dataflow

```yaml
apiVersion: civil/v1
kind: Graph
metadata:
  id: classify
  name: Classify
spec:
  nodes:
    - { id: document, type: io, direction: in, schema: schemas/document.schema.json }
    - { id: normalize, type: code, name: Normalize, include: ["src/steps/normalize/**/*.py"], entrypoint: src/steps/normalize/main.py }
    - { id: classifier, type: agent, ref: agents/classifier/agent.yaml }
    - { id: enrich, type: subgraph, ref: graphs/enrich.graph.yaml }
    - { id: search_tools, type: code, name: Search tools, include: ["src/tools/search/**/*.py"] }
    - { id: thinking, type: io, direction: out, kind: progress }
    - { id: record, type: io, direction: out, schema: schemas/record.schema.json }

  edges:
    - { id: e1, kind: flow, from: { node: document },   to: { node: normalize } }
    - { id: e2, kind: flow, from: { node: normalize },  to: { node: classifier } }
    - { id: e3, kind: flow, from: { node: classifier }, to: { node: enrich } }
    - { id: e4, kind: flow, from: { node: enrich },     to: { node: record } }
    - { id: e5, kind: capability, from: { node: classifier }, to: { node: search_tools, function: search_docs } }

layout:
  nodes:
    document: { x: 40, y: 120 }
    normalize: { x: 220, y: 120 }
    classifier: { x: 420, y: 120 }
    enrich: { x: 640, y: 120 }
    record: { x: 860, y: 120 }
    thinking: { x: 640, y: 300 }
    search_tools: { x: 420, y: 300 }
```

**`layout` is a sibling of `spec`, not inside it,** on both canvases. Dragging a node must not produce a diff that looks like a semantic change. Reviewers ignore the whole block.

`agent.yaml`

```yaml
apiVersion: civil/v1
kind: Agent
metadata: { id: classifier, name: Classifier }
spec:
  model: <optional; falls back to project default>
  promptFile: prompt.md
  maxTurns: 8
```

Tool access is declared by capability edges in the graph, not duplicated here. One source of truth.

### 6.4 Validation

Shared package, imported by server and client. Errors are structured — `{ file, jsonPointer, code, message }` — and render on the offending node.

- Ids match `^[a-z][a-z0-9-]{0,63}$`, unique within their canvas.
- Every `ref`, `schema`, `entrypoint`, and `exposes` target resolves.
- Schemas parse as JSON Schema 2020-12.
- Composition: `exposes` and `calls` must name services. Client nodes may not be edge targets of services.
- Graph: `capability` edges originate at an `agent` and terminate at a `code` node. A `code` node on a flow edge must declare an `entrypoint`.
- Subgraph containment cycles rejected with the full cycle path.
- Flow cycles forbidden in v1. Let the user draw one, mark it red, block Run — don't fail the save.

### 6.5 Write discipline

- Parse and serialize YAML with a comment- and order-preserving library. **A no-op round-trip must be byte-identical.** Test this on day one; it will save weeks.
- One user action = one commit. `civil: add service 'classify' to app`.

## 7. The editor

**Shell.** Left: project tree and git status. Center: canvas or Monaco. Right: inspector. Top: breadcrumb (`app / classify / enrich`), branch, Run, commit indicator.

**Canvas.** React Flow or equivalent. Pan, zoom, box select, `Delete`, `Cmd+Z`. Drag to connect; edge kind inferred from endpoint types. Auto-layout (ELK, left-to-right) as an explicit command, never automatic.

**Semantic zoom.** Far: name and type glyph. Mid: ports and edge labels. Close: agents show the first lines of their objective, code nodes show file count and languages, subgraphs and graph-backed services show a dimmed miniature of their interior. This is the highest-leverage delight feature in the product. Don't cut it.

**Descent.** Double-click a graph-backed service or subgraph → continuous zoom transform, ~250ms. Prefetch child manifests when the parent renders so descent is instant. Escape or breadcrumb ascends to the parent's exact prior viewport. Double-click a code node or function-backed service → viewport takeover with Monaco.

**Monaco.** VS Code's editor, MIT. File list on the left, tabs, save writes to the working tree as a pending change.

**Commits are explicit.** Edits accumulate as pending changes; the indicator shows a count and a diff preview. Nothing auto-commits.

### 7.1 Mutations are structured ops

The client never constructs YAML. It posts ops; the server applies them to the parsed document, re-serializes preserving comments, validates, returns diff + validation. Same op vocabulary for both canvases.

```json
{ "ops": [
  { "op": "addNode", "node": { "id": "classify", "type": "service", "impl": { "graph": "graphs/classify.graph.yaml" } } },
  { "op": "setLayout", "id": "classify", "x": 500, "y": 60 },
  { "op": "addEdge", "edge": { "id": "c2", "from": {"node":"public-api"}, "to": {"node":"classify"} } },
  { "op": "removeNode", "id": "legacy", "cascadeEdges": true }
] }
```

**This op layer is the seam for the roadmap agent (§14).** Every mutation the UI can perform must be expressible as ops, with no UI-only shortcuts. Get this right and the agent copilot is a client of an existing API rather than a rewrite.

### 7.2 Contracts are discovered, not declared

For function-backed services, code steps, and tools, the contract — name, description, input and output shape — is **read from the source**, not duplicated in a manifest.

- Entrypoint by convention (declared `entrypoint`, exported handler within it).
- Signature and type hints parsed; projected onto the node face as ports.
- Editing the function *is* editing the ports. No second place to disagree.

This keeps code runnable and comprehensible outside Civil, and means the canvas cannot lie about an interface. Cost: a parser per supported language. Python only in v1.

Where types are weak (`dict[str, Any]`), infer a JSON Schema from fixtures (§10) and offer it as a proposal. Never adopt it silently.

## 8. Invocation: what is a run

Not everything is a run. Three tiers, and conflating them was an early mistake worth not repeating:

**Ordinary endpoints.** A validation, a lookup, a save. Function-backed services with bounded latency. Plain synchronous handlers — no run id, no event log, no trace. Most of a real application.

**Deterministic graph runs.** A graph with no agent anywhere on its flow path, transitively through subgraphs. Sync by default; latency is bounded and knowable.

**Agent graph runs.** Job-shaped, because latency is not knowable. The same graph is fast when a classifier hits cache and slow when it decides to research — node latency is a property of the input, not of the graph. A caller cannot know in advance which it got.

### 8.1 One run model, two access patterns

Do not build two run models. Every graph run starts a job and returns a run id. The API offers a `wait` parameter with a timeout: under it, the caller gets the result inline and never learns a job existed; over it, the caller gets the run id and subscribes. One implementation, one event log, one code path — and a 40ms deterministic graph still feels like a normal request.

Sync-vs-async is a **surface default, not a second implementation**, configured on the client node where it's visible. Civil infers the default from whether an agent appears on the flow path, transitively; overridable in both directions, since a code step hitting a slow external API is deterministic but not fast.

The concrete payoff: a deterministic service advertises as an ordinary synchronous MCP tool, which every client handles best, while an agent service advertises as a task. Neither is hand-written.

### 8.2 Runs outlive requests

A deep research node is minutes to tens of minutes, and that is a typical node, not an edge case. Every HTTP timeout in the stack is shorter.

- Starting a run returns a run id immediately. The stream is a subscription to the run, not the response to it.
- Disconnect and reconnect is normal, not an error. The event log must be readable **from an offset**, not only tailed.
- Execution is owned by something independent of the connection.

## 9. Surfaces

### 9.1 The event log is the spine

The runtime emits an ordered, append-only event log, keyed by run id and readable from an offset:

```
run.started · node.queued · node.started · node.progress · node.token
node.tool_call · node.tool_result · node.output · node.failed
node.finished · run.finished
```

Everything consumes this. **Civil's own canvas animates runs from the same log** — the Run button and a deployed frontend consume identical events through identical code. Build the trace viewer against the persisted log, not the live socket, so replay and live use one path.

Node results are content-addressable and cached per run. This serves the single-node re-run loop (§10) and means a downstream failure never costs you a twelve-minute research node again.

### 9.2 api client

Generated from the exposed services' io nodes.

| | API |
|---|---|
| Start | `202` + run id, or inline result under `wait` |
| Check | `GET /runs/:id` |
| Progress | SSE, resumable from offset |
| Cancel | `POST /runs/:id/cancel` |

Support polling, but make resumable SSE the primary path — reconnect-and-catch-up is the same mechanism and gives the frontend live updates for free.

### 9.3 mcp client

Per the 2025-11-25 MCP spec, which introduced Tasks as a call-now-fetch-later primitive: a task-augmented request returns a durable handle immediately while work continues in the background.

- Advertise async support with `annotations: { async: true }`.
- **The run id is the task id.**
- Reuse the caller's `progressToken` for the task's lifetime; emit `notifications/progress` against it until terminal status.
- Support `tasks/get`, `tasks/list`, and `notifications/cancelled`.

Tasks remain experimental and client support is uneven, so **a synchronous fallback path is required, not optional politeness** — most callers will use it for a while. Deterministic services advertise sync only.

### 9.4 frontend client

Optional. An animated web app in `web/`, edited in Monaco. Civil adds three things:

1. **Generated typed client** — regenerated whenever io nodes change. A subscription per exposed service, typed to the schemas, with reconnect-from-offset built in. This is what keeps the frontend from drifting.
2. **Live preview** — dev server running, rendered beside the editor.
3. **Event hooks** — first-class access to the run log, so the UI can animate what's actually happening.

Civil does not provide a component palette or drag-and-drop layout. "Animated" means real CSS and real motion libraries. The leverage is the binding, not the drawing.

## 10. Fixtures and tests

Fixtures are example payloads committed alongside the project. They **exemplify** contracts; they never define them. If tests were authoritative, deleting one would change your API.

**Edge contract tests.** Every flow edge is a testable claim: the producer's example output must satisfy the consumer's input schema. Civil generates one per edge from things that already exist. Failures render as a **red wire on the canvas** — type errors as broken connections, which is what a graph editor can show and a file tree cannot.

**Single-node runs.** With fixtures you don't need upstream to execute. Click any node, run it against its example input, see output. This is the debug loop the editor is otherwise missing, and it works mid-graph without paying for every agent above it.

**Schema inference proposals.** See §7.2.

Asymmetry worth designing around: code gets real assertions, agents can't. The most you get for an agent is schema conformance plus recorded traces as golden fixtures. Generated fixtures are useful; generated assertions about agent correctness are circular.

## 11. Runtime

### 11.1 Build it, don't adopt it

Civil's runtime executes manifests directly. It is a dependency of every project, not a code generator — there is no compile step whose output could drift from the picture.

Not LangGraph, for two reasons. Its state model is a shared mutable object with reducers where edges are control flow; Civil's is typed ports where data flows along edges — adopting it means the canvas shows edges that correspond to nothing the engine enforces. And LangGraph graphs are built imperatively in Python, so using it would mean generating code from manifests, which is the drift problem again.

The graph part — ids, edges, topological sort, bounded concurrency — is a few hundred lines. What LangGraph actually sells is durability; see §11.4.

### 11.2 Run model

Flow edges form a DAG, executed topologically. Agents run an agent loop with their objective, their capability-linked tools, and inputs bound from upstream. Code nodes on flow edges execute their entrypoint. Subgraphs execute as nested runs; the canvas can descend into a running subgraph and watch live. Independent branches run concurrently (default limit 4). A failed node halts its branch; the run ends `partial`; offer **Retry node** reusing cached upstream outputs.

A `session_id` threads through every run and is exposed to agents. Civil does not implement conversation memory — that's an app decision (§14).

### 11.3 Tool call validation

**The runtime owns schema validation at the tool boundary, not each tool.** Otherwise every tool reimplements it inconsistently, and the quality of the error message — which determines whether a retry succeeds — varies by whoever wrote that file.

Behaviour differs by environment, and this is **a property of the environment, not a per-run toggle you have to remember**:

- **Dev (runs from Civil's canvas): strict. Throw and exit.** A malformed argument halts the run. Silent recovery makes bad prompts invisible; a graph limping along on a 40% first-try tool-call rate looks identical to one that works. This is an opportunity to refine the prompt, not to preserve flow through unpredictability.
- **Prod: lenient.** Validate at the boundary, return the violation to the agent *as a tool result* rather than raising, make the message repairable (which field, what was expected, what arrived), bound the loop with a retry cap. Recovered violations are counted per agent per tool so they stay visible as a signal.

Explicit override exists; the default follows the environment.

### 11.4 Durability — the two cheap things only

Do **not** build checkpointers, resume-from-crash, time travel, or interrupts. Long-running is not the same as pausable: a research node runs unattended for twenty minutes; it does not stop and ask a question. Even LangGraph's version is partial — resume re-runs the interrupted node including its LLM calls, so idempotency remains the caller's problem, and there is no built-in fallback routing or dead-letter queue.

Do build the two things that are nearly free now, brutal to retrofit, and already required for other reasons:

1. **The append-only, offset-readable event log** (§9.1).
2. **Content-addressable node result caching** (§9.1).

Together these are the substrate a checkpointer would need. Durability later becomes "reconstruct state from the log" rather than "add a persistence layer."

Revisit when a graph needs to pause for human approval — and note that an approval is modellable as two runs (one ending at an output, one starting from stored state) before it needs to be one paused run.

### 11.5 Traces

A trace captures **the raw arguments the agent produced, pre-validation**. If only the parsed result is logged, a strict failure tells you it broke without showing what the agent actually said, and that string is the entire diagnostic.

A trace pins the **prompt's commit sha**, not a live reference. Otherwise reopening yesterday's failure shows today's prompt.

A dev failure surfaces the malformed payload and the prompt that produced it **side by side, editable in place**, with re-run of that node alone against its fixture. See the error, fix the prompt, re-run without paying for upstream.

## 12. Platform

```
Browser (React SPA)
   │ HTTPS / SSE
Cloud Load Balancer ── Identity-Aware Proxy   ← auth lives here
   │
   └─ Civil API (Cloud Run) ── Cloud SQL Postgres
            └─ Secret Manager
```

**Auth: write zero auth code.** IAP in front of Cloud Run, your email allowlisted, app reads the identity header. No user table, no passwords, no sessions to get wrong. Adding a person is an allowlist edit. Cost: welded to GCP, already chosen.

**Data.** Postgres holds projects, working-tree metadata, runs, run events. GCS holds large event payloads and cached node results. **Never store repo contents as truth** — any cache must be reconstructible by re-cloning.

**Long runs on Cloud Run** need execution decoupled from the request. Use a minimum instance with in-process job ownership in v1; move to a worker if it strains.

**Git.** GitHub App, not PATs. Short-lived tokens minted server-side, never sent to the browser.

**Model IDs.** Do not hardcode from memory. Resolve current identifiers and the tool-use API shape at build time from https://docs.claude.com/en/docs_site_map.md. Model ID lives in config, exposed in the agent inspector as a dropdown from a server-side list.

## 13. Open questions

1. **Stores.** Deliberately paused. The reasoning so far: data belongs in the dataflow layer, not composition, because an edge to a store only means something where reads and writes happen — inside a service. A store would be declared once at project level and referenced from inside graphs, the way subgraphs are. Unresolved whether stores exist in v1 at all, and how far Civil's opinions about persistence go (schema? migrations? generated access code?). That decision is the line between Civil as an IDE and Civil as an app platform.
2. **Client vs surface.** A frontend is a client you build and descend into. An api or mcp node is a generated boundary exposed *to* clients you don't control. Currently one type with three flavors. Possibly two types.

## 14. Build order

**M0 — Skeleton.** TS monorepo (`web`, `api`, `schema`, `runtime`), Cloud Run + Cloud SQL, Terraform, IAP, migrations, empty authenticated shell.

**M1 — Read-only canvases.** GitHub App, clone, parser + validator for both manifest kinds, canvas rendering, composition→graph descent, ascent, inspector, breadcrumbs. *Exit: a hand-written example app renders at both altitudes and navigates correctly.*

**M2 — Code contexts.** Monaco takeover, file list, editing, pending changes, entrypoint parsing and port projection. *Exit: a file can be edited and committed without leaving Civil, and a function-backed service shows discovered ports.*

**M3 — Visual editing.** Structured ops for both canvases, comment-preserving writer, byte-identical round-trip test, diff preview, commit + push, pull with conflict handling, undo. *Exit: a full app is authorable from empty, and the YAML looks hand-written.*

**M4 — Runtime.** Agent loop, code steps, tool calls with boundary validation, topological runner, job-shaped runs, offset-readable event log, node result cache, live canvas overlays, trace viewer with prompt sha, replay, cancel. *Exit: an `io → code → agent → io` service runs end to end and animates; a failed tool call surfaces payload + prompt side by side.*

**M5 — Fixtures and clients.** Fixture storage, edge contract tests with red-wire rendering, single-node runs, generated api client with `wait` and resumable SSE, generated mcp client with Tasks + sync fallback, generated typed frontend client, frontend live preview, processes with schedule triggers.

**M6 — Polish.** Semantic zoom tiers, auto-layout, `Cmd+K` palette, error surfaces.

Use M1–M3 for real before starting M4. The editor must be good on its own.

## 15. Assumptions — correct these if wrong

- Python only for entrypoint parsing in v1.
- Frontend is optional; an app with only api/mcp clients is valid.
- Process triggers in v1 are schedules only; queues and events later.
- GitHub only. Anthropic only. Desktop only, ≥1280px.

## 16. Roadmap — explicitly not v1

- **Agent copilot.** Chat that inspects architecture, proposes edits, and pilots the editor through the op API in §7.1 — including diffs rendered on the canvas as ghost nodes and animated rewires. Deferred because it's the piece most likely to be built wrong before the editor has been used. Claude Code covers the gap meanwhile.
- **Deploy from Civil.** Trigger a deploy from the git state Civil already manages.
- **Stores.** See §13.
- **Tool as a first-class node type.** Contract promoted to the node face with a live-editable header, implementation files in a sidebar. The discovery mechanism in §7.2 is built now so promotion is a UI change, not a migration.
- **Session/memory defaults.** Generated into the repo behind a swappable interface once there's evidence about what's wanted.
- **Durable pause / human-in-the-loop.** See §11.4 for the trigger.
- **VS Code Remote Tunnel** into the project container, for when Monaco isn't enough.
- **Flow cycles**, loops, and supervisor patterns.
