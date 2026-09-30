# The registry: `civil/registry.yaml`

Decided with the owner 2026-09-30. Civil keeps a record of what each application
*is* — its units, the files each unit became, and what each depends on — in one
file inside `civil/`, beside the documents it is derived from.

## Why

Every transpile used to regenerate the whole app, because nothing recorded which
part of the sketch produced which file: the model chose the paths, and the memo
was one hash over everything. The registry is that record. It is the prerequisite
for regenerating only what an edit touches, for noticing a hand-edited file, and
for exercising the app end to end — and it lets a human or an agent read the
architecture from one file.

## What it is

- **Maintained by Civil, never authored.** Rebuilt deterministically on every
  transpile (memo hits included) from the documents and the emission; sorted, no
  timestamps, so it changes in a diff only when the app does. The editor refuses
  a hand edit (409), like any maintained file.
- **Committed with the code it describes.** A pending change like every emitted
  file, reviewed in the diff panel. The repo is the truth, and it stays
  self-describing after `civil/` is the only trace of Civil.
- **Not a document.** The canvas does not render it and the transpiler never
  reads it back as input; it describes, it does not decide.

## Units

The grain everything else works at. Ids are namespaced by altitude so they never
collide:

| Unit | Id | Depends on |
|---|---|---|
| composition node | `app/<node id>` | client: boundaries it routes to · boundary: services it exposes · service: its graph · process: services it calls |
| graph | `graph/<graph metadata.id>` | its agents, the graphs its subgraph nodes ref |
| agent | `graph/<graph id>/<node id>` | — |

`deriveUnits` (apps/api/src/project/registry.ts) computes them from the same
document map the transpiler sees, so the list the model labels against and the
list the registry is written from cannot disagree. Every emitted file carries a
`unit` label (emit_files, PROMPT_VERSION 6); the runner refuses an id outside the
list and retries. `shared` is the one label outside it, for plumbing that serves
several units. The generated web client belongs to the api boundary when there is
exactly one, and to `shared` otherwise.

Each file entry carries its role and `hash: sha256:<16 hex>` of the content as
emitted — enough to notice a change under Civil, not a security property.

## The steps

1. **Record the path map** — BUILT 2026-09-30. No behaviour change.
2. **Stable paths.** Tell the transpiler which paths existing units already live
   at, and keep them. Needed now: the first live emission after step 1 moved the
   boundary from `src/boundaries/` to `src/boundary/` with no document change
   behind it.
3. **Partial regeneration.** An edit regenerates its unit and its dependents; a
   memo per unit; unchanged files keep their bytes.
4. **End-to-end probes.** `routes` and `contract` from the documents, probes
   pre-filled from `fixtures/` and human-editable (preserved across rebuilds);
   Run executes them against the live app.
