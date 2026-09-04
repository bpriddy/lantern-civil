# Lift: reading code back into the documents

Design note, 2026-08-22. The inverse of transpile, and the second half of the
round-trip the whole architecture rests on (docs/transpilation.md: "if a
codebase actually runs and has sensible repo structure, it should transpile
back and forth"). Also the coherent **theirs** that mine-or-theirs
(docs/mine-or-theirs.md) left undefined for orchestration.

## What already updates from the repo without lift

- **Documents are files.** civil.yaml, app.yaml, graphs/*.yaml, agents/*.yaml —
  a hand edit to any of these in the repo is picked up by sync (it moves headSha;
  the next bundle read re-parses them). No lift needed.
- **Contracts discover live.** Ports read from a handler's signature, docs from
  its docstring (PRD 7.2) — edit the handler in the repo and the canvas shows the
  new contract on the next read. Contract discovery was lift's seed and proof.

So "update from the repo" is mostly already true. The gap lift fills is the one
thing the canvas stores that the code can also express: **graph flow structure**.

## The tractable core: flow edges from a straight-line run()

The transpiler emits each graph's orchestration as a straight-line `run()` —
assignments, calls, a return, in topological order — and the validators enforce
that shape precisely so it is re-liftable (emitted-code.md principle 6). That
makes the inverse a parse, not an inference:

```python
def run(document):
    normalized = normalize(document)      # edge: document -> normalize
    classified = classifier(normalized)   # edge: normalize -> classifier
    record = enrich(classified)           # edge: classifier -> enrich
    return record                         # edge: enrich -> <io-out>
```

- Each `var = fn(args)` is a node (`fn`) fed by the nodes that produced `args`.
- The parameter is the io-in node; the returned var's producer feeds the io-out.
- `fn`'s node identity comes from its import: `from src.steps.normalize.main
  import handler as normalize` -> the node whose entrypoint is that module. v1
  matches the imported module against the graph doc's node paths (entrypoint,
  ref, emitted path); v2 persists the node<->emitted-symbol map at transpile time
  so the match is ground truth, not heuristic (the binding emitted-code.md
  already said the documents should record).

Lift compares the parsed edge set to the document's `flow` edges. A difference is
a hand edit to the orchestration: a reordered pipeline, an inserted or dropped
step. Lift rewrites the document's flow edges (as ops, so it rides the same
splice discipline and diff panel as any canvas gesture). Capability edges,
io nodes' schemas, and node creation are out of v1 scope — flow only.

## Where it runs

Runner-side, symmetric with transpile: `POST /lift {orchestration, documents}`
-> `{graphPath, edges}`. The runner already parses Python (the transpiler's
validators use ast); lift is more ast in the same place. Deterministic, no model
call — a parse, not a generation — so no memo, no fingerprint.

## Detection and reconciliation (lift-on-open)

- **Detect** on bundle load: a maintained orchestration file whose current
  content is not any content Civil ever emitted (emittedHistory, by content hash)
  was edited outside Civil. Surface as `drifted: string[]` in the bundle.
- **Prompt** on open when drifted is non-empty: per file,
  - **Update the graph to match (theirs/lift)** — parse run(), rewrite the flow
    edges so the canvas reflects the code. The hand edit stays; the graph catches
    up. This is the round-trip closing.
  - **Regenerate from the graph (mine)** — transpile, discard the hand edit
    (the existing transpile path).
- No merging; whole-file, per the standing stance.

## Boundaries and open items

- v1 lifts flow edges of a graph from its run(). NOT: capability edges, new
  nodes/io, composition-from-scratch (adopting a repo with no civil/), or
  agent-config lift (already a document/sync). Those are later, larger.
- The node<->symbol map: v1 heuristic (module path vs node paths); v2 persists it
  at transpile time for repos whose layout the heuristic cannot resolve.
- A run() edited beyond the straight-line convention (a human added a conditional)
  cannot be lifted to a control-flow-free canvas — lift reports it as unliftable
  and offers only regenerate, or leaving it as human-owned. The canvas's refusal
  to represent control flow is exactly what bounds lift's job.
- Adopt-an-existing-repo (full structural inference -> a whole civil/ architecture)
  is the founding-intent horizon item; this note is the first, designed-for step
  toward it, not that.
