# The mutation path

Every change Civil can make to a project travels one route. This document is that
route, end to end, because it is the thing least visible from any single file and the
thing most expensive to accidentally bypass.

PRD §7.1 calls the op vocabulary the mutation interface. `CLAUDE.md` calls it the
agent seam. They are the same claim from two directions: if there is exactly one way
to change a manifest, then an agent that learns that one way can do everything the UI
can, and a diff preview written once covers every mutation that will ever exist.

A shortcut around this is not a small cost. It is the difference between adding the
copilot and rewriting for it.

---

## The route

```
gesture or instruction
      ↓
command registry              apps/web/src/commands/registry.ts
      ↓                       named, described, enabled-or-not
proposal                      apps/web/src/canvas/edges.ts
      ↓                       what does this gesture mean? may refuse
ManifestOp[]                  packages/schema/src/ops.ts
      ↓                       POST /api/projects/:id/ops
OverlaySource                 apps/api/src/project/overlay.ts
      ↓                       HEAD + pending edits, read as one tree
applyOps                      apps/api/src/manifest/apply.ts
      ↓                       splices text; never re-serialises the file
pending_changes               apps/api/src/project/pending.ts
      ↓                       Postgres. This is the durable edit.
bundle rebuild                apps/api/src/project/bundle.ts
      ↓                       parses, validates, returns diagnostics
canvas + toast
```

Each hop is worth a paragraph, because each one is where a future change is most
likely to go wrong.

### The command registry is the front door

An action reachable only by clicking one particular button is invisible to an agent.
So actions are named in `registry.ts`, carry a plain-language description, and answer
`enabled(context)` before they are offered. The keyboard dispatches into the registry;
buttons call into it; an agent will match an instruction against those descriptions.

The description is not documentation. It is the matching surface.

### A proposal is where a gesture acquires meaning

Dragging between two ports is not yet an op — it is two node ids. What that connection
*means* depends on what it joins, and PRD §7 says the kind is inferred from endpoint
types.

`proposeCompositionEdge` and `proposeGraphEdge` do that inference, and either return a
kind or a refusal in words. Refusing here rather than downstream is deliberate: the
validator can tell you afterwards that a service must not point at a client, but the
gesture that produced it is the moment the user can still understand why.

**Inference is client-side; the result is sent explicitly.** The op carries
`kind: 'routes-to'`, not an instruction to work it out. An op that states what it did
is one an agent can read back and one a transcript can show. An op whose meaning the
server re-derives is neither.

### Ops apply on top of pending work, not on top of HEAD

The route opens an `OverlaySource` — HEAD from GitHub, with `pending_changes` layered
over it — and applies to that. Editing twice before committing must build on the first
edit rather than silently discard it.

The overlay is the pattern worth preserving: it implements `ProjectSource`, so pending
edits flow through the parser, the validator, and the bundle builder with no code path
of their own. Nothing downstream knows whether it is reading committed or uncommitted
text, which is why "start on your laptop, continue on your phone" needed no special
case anywhere.

### applyOps splices; it never regenerates

PRD §6.5 requires a no-op round-trip to be byte-identical — comments intact, key order
intact, formatting intact. Parse → mutate → serialise cannot do this. Any YAML
serialiser normalises, and normalising a file the user hand-wrote produces a diff full
of changes nobody made.

So `apply.ts` works on the source text: locate a range, splice new text into it, leave
every other byte alone. `document.ts` supplies the locating — `findSequence`,
`findSequenceItemById`, `trimEnd` — using the CST's ranges rather than its values.

This is the fiddliest code in the repo and the bugs it produced were all the same
shape: an inserted item that was valid on its own and broke the file around it. A list
rendered in block style inside a flow context. A removed item that took the following
newline with it and left a bare dash. A second node appended into whitespace belonging
to the next key.

**Therefore: every op test parses and validates its result.** Checking that the output
looks right and that untouched lines are untouched is not enough — that pair of
assertions passed while the file was invalid YAML. `apps/api/test/ops.test.ts` is the
model to copy.

### The pending row is the durable edit

Not the container filesystem — see `CLAUDE.md`. `savePending` writes the whole new
file content with the `base_blob_sha` it was derived from, which is what later detects
that the branch moved under an edit.

### Validation arrives one request later, on purpose

The ops route refuses an op only when it cannot be applied to the text at all. A
structurally legal edit that produces an invalid project is saved, and the diagnostics
appear when the bundle is next built.

That is PRD §6.4's rule, not an oversight: a flow cycle "marks it red, blocks Run —
doesn't fail the save". The client refreshes the bundle after every op, so the red
arrives in the same beat as the change — but it arrives from `bundle.ts`, not from the
op route, and anyone adding a rule should add it there.

### The outcome is a sentence

Every op returns a summary in words: *"Connected agent-tools → save-record."* The
toast shows it now; an agent transcript will show the same string later. This is
`CLAUDE.md`'s fourth agent-first constraint and it costs one line per op to keep.

---

## The op vocabulary today

Defined in `packages/schema/src/ops.ts`, applied in `apps/api/src/manifest/apply.ts`.

| Op | What it does | Where the gesture comes from |
|---|---|---|
| `addNode` | Appends a node to `spec.nodes` | `node.add` command, `N` |
| `setLayout` | Writes `layout[id]` — sibling of `spec`, never inside it | Node drag, on drop |
| `addEdge` | Appends to `spec.edges` with an explicit `kind` | Dragging between ports |
| `removeEdge` | Removes an edge by id | Selecting an edge, Delete |

### Still missing, and why each is not trivial

- **`removeNode`** needs `cascadeEdges`: removing a node leaves every edge touching it
  dangling, and a manifest referring to a node that is not there is worse than the
  node.
- **`updateNode`** is the inspector's op. Every field edit currently has nowhere to go,
  which is why the inspector reads but does not write.
- **`renameNode`** is the hard one. PRD §7.1 gives it `updateReferences`, so it must
  rewrite edge endpoints and the `layout` key atomically. Half of it applied is a
  broken project.

---

## Adding an op

1. Add the shape to `packages/schema/src/ops.ts`. Both sides import it; there is one
   definition.
2. Add the case to `applyOps`. Splice — do not re-serialise. Return a summary sentence.
3. Test it in `apps/api/test/ops.test.ts`, and **parse the result**. Assert the
   untouched lines are byte-identical.
4. If a gesture produces it, put the meaning in a pure proposal function and test the
   refusals. `apps/web/test/edges.test.ts` is the model.
5. If the user can trigger it, give it a command id and a description. Not a button
   with a handler.

The test for the whole thing, from `CLAUDE.md`: *could an agent invoke this, know what
it does, and show the user what changed — without new plumbing?*
