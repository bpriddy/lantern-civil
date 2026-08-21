# Civil is an editor of the repo

The design settled on 2026-08-21, in one sentence: **every surface Civil has —
canvas gesture, inspector field, prompt textarea, commit button — is a way of
editing actual files in an ordinary repository.** The canvas edits Civil's own
documents; commit materialises them into normal code; nothing Civil produces is
a format the world outside Civil cannot read, run, review, or leave with.

This supersedes the interpretation model (manifests walked by an engine at
runtime) that M0–M4 were built on. What was built survives — the op layer, the
discovery machinery, the runner, the event log — but the target of the system
shifts from *YAML interpreted by a runtime* to *YAML transpiled into the repo*.

## Why

The owner's founding intent: evolved devex — building so intuitive and
propulsive it stops being developer-oriented, with the node graph never becoming
the roadblock. The market's two camps each fail one half of that:

- **Visual + interpreting engine** (Langflow, n8n, Dify): the artifact is not
  software. Teams hit the ceiling and rewrite in code, losing the visual source
  forever — the rewrite cliff.
- **Code-first + visual viewer** (LangGraph): the artifact is software, but the
  canvas can never be the author surface; the architecture diagram is derived
  and secondary.

Civil takes the unoccupied position: **visual source, transpiled to standard
code** — with mechanics proven outside agent-land (protobuf, Prisma, sqlc: a
source representation, deterministic generation, a small runtime library, and
nobody calling it lock-in).

The decision that makes this tractable where it has always failed: **Civil's
canvas deliberately represents architecture, never control flow.** No if/else
nodes, no loop operators. Because the canvas claims only structure, boundaries,
wiring, and contracts, code edited outside Civil cannot break the
representation — the worst case is a drift diagnostic. Frameworks die on
bidirectionality when their diagrams claim code; Civil's doesn't.

## The shape

```
my-app/
  web/            the frontend — any framework. Civil never writes here; it only
                  READS the API calls out of it, by code analysis.
  src/            handlers, libs, utils — the owner's structure, recorded (not
                  dictated) by directory references in civil/civil.yaml
  tests/  docs/   normal repo life; no Civil opinion
  civil/          Civil's entire private footprint: the authored architecture
    civil.yaml    documents the canvas renders and edits. Project config +
    app.yaml      directory references. NOT deployment manifests — this is
    graphs/*.yaml Civil's document format, the way .proto is protobuf's.
```

Rules of the shape:

- **Civil is a supplement to a repo, not its structure.** Delete `civil/` and a
  transpiled project remains a normal, running application. Adopt Civil on an
  existing repo and the lift feature writes one folder.
- **`civil.yaml` carries directory references** — where services live, where the
  web client lives. Civil adapts to the repo; lifting *discovers* structure and
  writes the references down.
- **The canvas is a partial view, by design.** A code context may call a lib
  function that exists only in the file tree. Things outside the canvas are not
  "unrepresented objects" — they are simply the repo.
- **Transpiled output lands in the repo's ordinary files**, at the referenced
  locations — the boundary server, graph orchestration, scaffolded entrypoints
  go where a developer would have written them. There is no `generated/`
  ghetto. Generated and authored code cohabit normal paths; the civil docs are
  the record of which files Civil maintains.

## When things happen

**Editing (pre-commit):** canvas gestures update `civil/` documents as pending
changes, exactly as ops work today. Code and agent contexts edit their real
files directly (they already do). Nothing transpiles on keystroke — no churn in
the working tree, per the pattern every frontend framework converged on (Vite
transforms in memory; Next builds into a gitignored cache; nobody regenerates
into the working tree on edit).

**Running (pre-commit):** the Run button covers iteration. The runner transpiles
the *pending* state ephemerally — in memory, nothing written — and executes it.
This is the Vite dev-server pattern mapped onto Civil's timeline.

**Commit:** Civil's own commit path (not a git hook — hooks are slow, per-machine,
and bypassable) transpiles the civil documents into the referenced repo files
and includes those updates in the same commit, shown in the diff panel alongside
the intent changes that caused them. Intent and consequence, reviewed together.
After commit, the repo is a runnable, deployable, ordinary application — Civil
is owed no build step.

**Deploy:** the repo deploys like any app, into any environment — env vars, data
sources, scheduled jobs are the environment's concern. "Deploy from Civil"
remains deferred (PRD §16).

**Open / sync:** if files were hand-edited outside Civil, opening the project
prompts to **update from the repo** — the lift runs, and the civil documents are
updated to reflect what the code now says. Lifting is discovery at repo scale;
contract discovery (ports from signatures, docs from docstrings) was its seed
and proof.

## Conflicts: mine or theirs

No merging, deliberately — the same stance the commit re-parent model already
takes. When a Civil-maintained file was hand-edited AND the corresponding canvas
state changed, commit does not silently clobber and does not attempt a merge: it
surfaces both and the owner picks — mine (the canvas intent, regenerated) or
theirs (the hand edit, lifted). Handlers are exempt by construction: Civil
scaffolds them once and never regenerates them. Only orchestration-class files
(boundary server, graph orchestration) carry co-ownership at all.

## Ownership map

| File | Author | On commit |
|---|---|---|
| `civil/*.yaml` | the canvas (via ops) | committed as edited |
| handlers, libs, tools | the human (scaffolded once) | never regenerated |
| agent.yaml, prompt.md | the human, via Civil's inspectors | committed as edited |
| orchestration, boundary server | the transpiler | regenerated; mine-or-theirs on drift |
| `web/` | the human, any tooling | read-only to Civil (API-call analysis only) |

## What this revises

- **PRD §6 layout**: civil documents move from repo root into `civil/`;
  `layout` stays a sibling of `spec` inside the documents.
- **PRD §7.1 ops**: the op layer survives unchanged as the agent seam; its
  splice discipline becomes the transpiler's ethic (touch only what the gesture
  means). Over time ops gain transpile-aware semantics (rename = refactor).
- **civil-runtime**: shrinks toward a deliberately small library — agent loop,
  boundary validation, event emission — imported by transpiled code the way any
  app imports a framework. The graph-walking engine's logic becomes the
  transpiler's template.
- **The M4 runner** survives intact: it executes the ephemeral transpilation of
  pending state instead of walking YAML. Dispatch, tokens, events, overlays —
  unchanged.

## Open items, recorded not resolved

- **The generated typed SDK for the web client** ("generated to start"): its
  emit location should be a directory reference like everything else. Using it
  is what makes frontend→boundary edges trivially liftable from imports; not
  using it degrades gracefully to fetch-call analysis.
- **Orchestration file conventions**: the transpiler's output must be
  *re-liftable* — conventional enough that Civil can read it back after a human
  touches it within convention. Deterministic and diff-stable, or the diff
  panel drowns.
- **Lift fidelity limits**: what analysis can and cannot recover (env-var
  mediated calls need light conventions; the SDK is one such convention).
- **Mid-edit broken code**: what the canvas shows while a file is unparseable —
  last-good view plus a drift marker is the likely answer.
- **Migration**: existing projects (doc-pipeline, civil-project-test) move their
  documents into `civil/` when the transpiler lands, not before.
