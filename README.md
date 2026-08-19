# Civil

A web IDE for building applications at graph altitude. See [`civil-prd.md`](civil-prd.md).

The repo is the truth. Everything the canvas shows is a projection of files in git.

## Layout

```
packages/schema/   the one typed contract — manifests, ops, validation.
                   Imported by both the API and the browser. No YAML, no IO.
apps/api/          Fastify server. Owns git, YAML, jobs, and the event log.
apps/web/          React SPA. The canvas and Monaco.
runtime/           civil-runtime, a Python package. Executes graphs.
                   A dependency of every Civil project, not a code generator.
infra/terraform/   Cloud Run, Cloud SQL, IAP, Secret Manager.
examples/          doc-pipeline — the hand-written app M1 must render.
docs/              prd-deltas.md records every place implementation diverged.
```

## Rules

`CLAUDE.md` holds the invariants that are expensive to undo. The one that shapes the
architecture most: **nothing on the container filesystem may be the only copy of
anything.** Civil does not clone repositories or keep a working tree. Committed
content is read from GitHub, pending edits live in Postgres, and large blobs go to
GCS. See `docs/prd-deltas.md` §11 for why, including what was tried and rejected.

The language split follows PRD §11.1: the runtime is a dependency of the *user's*
project, so it lives where their code lives. Civil's own server is TypeScript.

Validation splits the same way. Structural validation is TypeScript in
`packages/schema` because §6.4 requires the browser to run it. Contract discovery
(§7.2) parses Python ASTs and is necessarily server-side.

## Run it

```
./scripts/dev.sh
```

Starts Postgres, applies migrations, and brings up the API and the SPA together.
Open http://127.0.0.1:5173. There is no login locally: a dev shim supplies the same
identity shape IAP asserts in production, so there is one code path rather than two.

```
./scripts/deploy.sh
```

Builds with Cloud Build, migrates via a Cloud Run job from the same image, then
updates the service. See `docs/deploy.md` — including the one step that cannot be
scripted.

Prerequisites: Node ≥22, PostgreSQL 17, and for deploys, gcloud + Terraform.

## Tests

```
npm test
```

PRD §2 names two tests that matter, both guarding silent corruption. The manifest
validator is one of them (the YAML round-trip lands in M3). The identity tests are
here on the same argument: every case in them fails *open* if the code is wrong,
which is exactly the class of bug you do not notice by clicking.

## Status

**M0, M1 and M2 complete. M3 in progress.**

Deployed at `https://civil-35752011174.us-central1.run.app`, signed in with Google,
reading and writing real repositories through a GitHub App.

What works end to end:

- Home lists your projects, the repositories your installation can reach, and the
  bundled examples.
- A repository with no `civil.yaml` offers **Add Civil to this project**, which
  scaffolds `civil.yaml`, `app.yaml` and `CIVIL.md` as pending changes.
- Both canvases render, with descent between them and into code.
- Contracts are read from Python source and shown as ports (PRD §7.2).
- Monaco edits files; saves become pending changes in Postgres, so uncommitted work
  survives a restart and follows you to another device.
- Commit writes to GitHub with no clone, including into an empty repository.
- `n` adds a node through the op layer. `?` lists every shortcut.

### What is left in M3

The op vocabulary is started, not finished. `addNode` and `setLayout` exist; the rest
of PRD §7.1 does not:

- `removeNode`, `updateNode`, `renameNode`
- `addEdge`, `removeEdge`, `updateEdge`
- Dragging a node on the canvas to emit `setLayout` (nodes are still fixed in place)
- A diff preview before committing — PRD §7 promises the indicator shows one
- Undo

Also open, and deliberately not rushed: **what a command targets.** New nodes land at a
fixed position because there is no answer yet, and the answer has to work for a
keystroke and for an agent instruction alike. See `docs/roadmap.md`.

### Tests

```
npm test
```

13 schema, 39 API, 24 Python. PRD §2 names two tests that matter and both exist: the
manifest validator, and the byte-identical YAML round-trip. Everything else earns its
place by guarding something that fails silently.

Open decisions and every divergence from the PRD are in `docs/prd-deltas.md`. Two
sections of the PRD need updating to match decisions taken here — §4/§6.2 on edge
kinds, and §6.4 on the id pattern.
