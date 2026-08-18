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

## Status

M0 in progress. See `docs/prd-deltas.md` for open decisions.

## Develop

```
npm install
npm test
```

Prerequisites: Node ≥22, PostgreSQL 17, and for deploys, gcloud + Terraform.
