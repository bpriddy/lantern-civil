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

… and two read paths hang off the same state:
GET /diff                     every pending file beside what HEAD says — the preview
previous + hadPending         returned by every op application — what undo restores
```

### Undo is previous-content, not inverse ops

Every op application returns the file's prior text and whether that text was itself
a pending edit. The client stacks those (`UndoEntry` in `App.tsx` — capped, per
project, cleared on commit and on sync). Undo restores the previous content as a
pending change — or, when the op was the first thing to touch the file, discards the
pending row so the file falls back to HEAD, which is why undoing everything you did
returns the header to "no pending changes" rather than to a no-op diff.

Inverse ops were considered and rejected: every op would need a hand-written inverse
proven correct against the splice machinery, and manifests are small enough that
keeping the whole prior text is free. Monaco keeps its own undo inside files; the
command is scoped to the canvas so the two never fight.

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

## The op vocabulary

Defined in `packages/schema/src/ops.ts`, applied in `apps/api/src/manifest/apply.ts`.
The vocabulary is complete against PRD §7.1.

| Op | What it does | Where the gesture comes from |
|---|---|---|
| `addNode` | Appends a node to `spec.nodes` | `node.add` command, `N` |
| `setLayout` | Writes `layout[id]` — sibling of `spec`, never inside it | Node drag, on drop |
| `addEdge` | Appends to `spec.edges` with an explicit `kind` | Dragging between ports |
| `removeEdge` | Removes an edge by id | `canvas.delete` on a selected edge; the inspector's Disconnect |
| `removeNode` | Removes a node, its edges (`cascadeEdges`, default true), and its layout entry | `canvas.delete` on a selected node; the inspector's Remove |
| `updateNode` | Sets fields from a patch; `null` removes a field; `id`/`type` refused | Every editable inspector field |
| `updateEdge` | Same mechanism on an edge | The edge inspector: kind where it is a genuine choice (agent → code), and a capability edge's `function` |
| `renameNode` | Rewrites the id and, with `updateReferences` (default true), every edge endpoint, `exposes`/`calls` entry, `invocation` key, and the layout key, in one splice set | The inspector's id field |

Worth knowing about the two removal semantics: **`removeNode` cascades edges only.**
A client that still `exposes` the removed node keeps saying so, and the validator
flags it on the next bundle — deliberately. An edge to a missing node is structural
garbage nothing can want; an `exposes` entry is a statement about the client's
surface, and silently rewriting it would hide a consequence the author should see.
Rename rewrites those same references precisely because a rename changes nothing
semantically — nothing there deserves the author's attention.

Two mechanical notes that keep the YAML hand-written-looking: removing the last item
of a block collection writes the key back as `[]` / `{}` (so the next add appends
rather than being refused with "not a sequence"), and items inside inline flow
brackets take a comma with them on the way out.

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
