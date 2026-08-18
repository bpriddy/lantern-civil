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

**M0 complete.** Deployed to `lantern-civil`, IAP-protected, one command each way.

Next is M1: clone a repo, parse both manifest kinds, render the composition canvas,
and descend into a graph. `examples/doc-pipeline` is the app that has to render, and
it already validates clean.

Open decisions and every divergence from the PRD are in `docs/prd-deltas.md`. Two
sections of the PRD need updating to match decisions taken here — §4/§6.2 on edge
kinds, and §6.4 on the id pattern.
