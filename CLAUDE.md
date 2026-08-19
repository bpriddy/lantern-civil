# Civil — working rules

Load-bearing invariants. Each exists because violating it is expensive to undo, not
because it is tidy. `civil-prd.md` is the design; `docs/prd-deltas.md` records every
place implementation diverged from it and why.

## No local file storage

**Nothing on the container filesystem may be the only copy of anything.**

Everything on disk must be reconstructible from Postgres, GCS, or GitHub. If losing
the container would lose information, it is in the wrong place.

This generalises PRD §12's "any cache must be reconstructible by re-cloning" to cover
the case that rule missed: uncommitted edits, which are reconstructible from nothing
because they exist in exactly one place.

Concretely, the server does not:

- clone repositories, or keep a git working tree
- write files that must survive the request that created them
- mount a bucket as a filesystem (Cloud Storage FUSE is
  [documented as unsuitable for git](https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts):
  no file locking, no atomic rename, and every small file operation is a network call)

Instead:

| What | Where |
|---|---|
| Committed content | GitHub, read through the Git Data API |
| Pending edits | `pending_changes` in Postgres |
| Large blobs | GCS, referenced by a Postgres row |
| Commits | Git Data API — blobs, tree, commit, update-ref |

**What this does not forbid:** ephemeral scratch derived from durable state and thrown
away within a request or a run. M4's runner will materialise files to execute Python;
that is derived from a pinned commit and reconstructible by definition. The test is
not "did anything touch the disk" but "would losing this container lose anything".

**Known exception, development only:** `LocalSource` reads a directory on disk so M1
could proceed without the GitHub App. It is a development affordance and must never
become a deployment mechanism.

## One project, one repository

A Civil project is a repository, whole, with `civil.yaml` at its root. Civil does not
open a subdirectory of a repository as a project.

This keeps "what does `app.yaml` mean" answerable without a second notion of root, and
it keeps a project's identity and a repository's identity the same thing — which the
commit path, the branch model, and `pending_changes` all assume.

`examples/doc-pipeline` in this repository is a **test fixture**, not an openable
project. Opening it in Civil would mean giving it its own repository.

## The repo is the truth

PRD §6.1. Everything the canvas shows is a projection of files in git. Anything Civil
knows that git does not is a bug — with exactly one carve-out, pending edits, which
are not in git *yet* and are Civil's own state in the same sense as `runs`.

## Manifests

- `layout` is a **sibling** of `spec`, never inside it. Dragging a node must not
  produce a diff that looks like a semantic change.
- A no-op YAML round-trip must be **byte-identical**. Comments and key order survive.
- The node vocabulary is closed and edited by hand. Adding a type is a commit to
  Civil, not a feature of Civil. See PRD §3 before reaching for a new one.

## Data

- `owner_id` on every table, from the first migration.
- Real migrations, always forward. Never rewrite a migration that has run against
  Cloud SQL, even when the tables are empty.
- Every query filters by `owner_id` in the WHERE clause, not in a handler.

## Mutations

Every change the UI can make is expressible as a structured op (PRD §7.1). No
UI-only shortcuts — that op vocabulary is the seam the future agent copilot plugs
into, and a shortcut today is a rewrite later.

## Deploys

`./scripts/deploy.sh` only. It builds, migrates as a Cloud Run job from the same
image, deploys, then smoke tests that the shell loads signed out, `/api/*` refuses,
and the container answers `/readyz`. Never deploy from a dirty tree.
