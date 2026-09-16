# Boundary type-sync

Built 2026-09-16. The next item in the transpilation chapter after lift, and the
first place the round-trip shows up as an editor-level win. Companion to
`docs/emitted-code.md` (the contract it obeys) and `docs/transpilation.md`.

## What it is, and what it is not

The value is narrow and honest: **keep the frontend's understanding of the boundary
from silently drifting from the backend's.** The boundary schema is the source of
truth; when it changes, the web client's types for that boundary change, so the drift
surfaces as a type error in the editor and at build. That is all Civil owns here —
propagating a fact.

It is **not** a prescribed client. Civil does not mandate a `client.analyze()` house
shape (the owner caught that framing on 2026-09-16; the roadmap records the
correction). How call sites are *written* follows first-class rule 1 — the repo's own
convention. Where no calling pattern exists yet — the per-surface seed case
(`docs/emitted-code.md`) — Civil emits the most vanilla thing, a thin typed fetch
wrapper per endpoint, as a disposable default the first hand-written call supersedes.
doc-pipeline's client is a placeholder today, so v1 seeds; reading an existing
convention out of `civil/patterns.md` and emitting into it is the next increment.

## Why deterministic, not generative

Drift-prevention is only as good as the types being faithful. An LLM that paraphrases
a schema makes the guarantee unreliable, so the types are generated
**deterministically** from the JSON Schema — never through the model. This is not a
departure from the generative transpiler; it is the hardened-template end of the same
contract (`docs/emitted-code.md`: "determinism earned"). A faithful type is a
mechanical transform, so it earns the template now.

The generator lives API-side (`apps/api/src/project/boundary-client.ts`), not in the
runner: it needs no model (so PRD §12's runner-only model rule does not apply), it is
TypeScript emitting TypeScript, and it reuses the composition/graph/schema resolution
the API already does. Precedent: lift's edge-diff and retirement are already API-side
deterministic transpile logic.

## How it resolves the boundary

1. The composition's `client: web` node names where the client lands; its `api`
   boundary nodes name the exposed services (`exposes`, in order; `mcp` is an agent
   surface and emits nothing here).
2. Each exposed service resolves to its I/O: a graph-backed service carries its types
   in the graph's `io` nodes — a single typed `in` is the request, a single non-
   `progress` `out` is the response. A `progress` out is an SSE channel, not the body,
   and is excluded. Zero or several is a composite v1 does not invent — it stays
   `unknown`, honestly, rather than guessing.
3. A function-backed service (`impl.entrypoint`) declares no schema here, so its types
   read `unknown` until contract discovery (`contracts.ts`) can recover them — a later
   increment.
4. Type names are per-endpoint (`ClassifyInput`/`ClassifyOutput`), derived from the
   node id — collision-free by construction, and it sidesteps schema titles that
   collide with TS globals (a schema titled `Record` is the obvious trap).

## Where it sits in the lifecycle

The generated file merges into the transpile output **before the memo is stored**, so
it is a first-class member of the emission with no special-casing downstream: it lands
as a pending change (reviewed in the diff panel), is provenance-tracked and retired by
the same union-over-memo logic, and materializes into the session — where it is source
the web dev server already serves, deriving no process of its own (the
`boundary-client` role is invisible to `deriveProcesses`).

Memo honesty: a **client signature** — the output path, each endpoint's names, and its
resolved schemas, plus a `CLIENT_VERSION` — folds into the transpile input hash, but
only when a plan exists. So a schema edit under an api boundary regenerates the client,
a `CLIENT_VERSION` bump regenerates every client, and a project with no web client
hashes exactly as it did before this feature — no gratuitous re-emission.

The file lands in a `civil/` subfolder of the client's source dir
(`web/src/civil/client.ts`), marking it Civil-owned and keeping it out of the human's
hand-written space, so regeneration never silently clobbers an edit.

## Boundaries (what v1 does not do)

- **Call-site adoption.** v1 always seeds; it does not yet read a frontend calling
  convention from `civil/patterns.md` and emit into it. The seam is the pattern prompt,
  already produced by the analyzer.
- **Function-backed types.** `impl.entrypoint` services are `unknown` until contract
  discovery feeds their Python signatures in.
- **Composite I/O.** Multiple typed `in`/`out` nodes stay `unknown` rather than being
  merged into a synthesized object.
- **The progress channel.** `kind: progress` outputs are SSE, not the response body;
  typing that stream is its own increment.
- **Non-web clients.** `client: mobile` emits nothing here.
