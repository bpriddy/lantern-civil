# PRD deltas

Places where the PRD was silent, self-contradictory, or where implementation forced a
choice. Each entry says what was decided and how to reverse it. Nothing here is a
complaint — a v1 PRD that specified all of this would have been guessing.

Anything marked **needs a call** is a decision the owner should make; the current
behaviour is a placeholder that works.

---

## 1. Node ids forbid underscores, but the example uses one — **needs a call**

§6.4 is normative: `^[a-z][a-z0-9-]{0,63}$`. §6.3's example graph declares
`search_tools`, which that pattern rejects.

**Decided:** the regex wins, since it is the stated rule and the example is
illustrative. The example app uses `search-tools`.

**To reverse:** widen `ID_PATTERN` in `packages/schema/src/manifest/common.ts` to
`^[a-z][a-z0-9_-]{0,63}$`. Worth weighing: node ids appear in generated client code,
where kebab must be transformed anyway, so allowing underscores does not remove a
transformation step. But Python function names are snake_case, and a code node whose
id matches its module reads better.

## 2. Composition edges carry no `kind` — **needs a call**

§4 says composition edges mean "depends-on / routes-to", two distinct relations. The
§6.2 example has no `kind` field, unlike graph edges which do.

**Decided:** implemented exactly as the example shows — no `kind`. The relation is
inferred from endpoint types (client→service is routes-to; process→service is
depends-on, and is already expressed by `calls`).

**Risk if left:** the canvas cannot render the two relations differently, and a
process that both calls a service and depends on another has one field and one edge
type doing two jobs. Adding `kind` later is a manifest migration, so this is worth
deciding before M3 writes real files.

## 3. Diagnostics needed a `severity` the PRD's shape does not have

§6.4 specifies `{ file, jsonPointer, code, message }`, but also requires that a flow
cycle "mark it red, block Run — don't fail the save" while a subgraph containment
cycle is "rejected". Those are two different outcomes and the writer has to tell them
apart.

**Decided:** added `severity: 'error' | 'run-blocking'`. Also added optional `nodeId`,
`edgeId`, and `cyclePath`, because §6.4 requires diagnostics to "render on the
offending node" and to report "the full cycle path", neither of which is derivable
from a JSON pointer alone.

## 4. `civil.yaml` contents were never specified

§6.1 lists the file; nothing defines it.

**Decided:** a minimal `kind: Project` holding only what has nowhere else to live —
composition path, default model, language. See
`packages/schema/src/manifest/project.ts`.

## 5. The sync/async client default had no syntax

§8.1 says it is "configured on the client node where it's visible" and that Civil
infers the default from whether an agent appears on the flow path.

**Decided:** optional `invocation: { <serviceId>: sync | async }` on `api` and `mcp`
client nodes. Absent means inferred. Validation rejects an override for a service the
client does not expose. The inference itself is M4 work.

## 6. Added an io-direction rule §6.4 does not list

§5 says io nodes are directional specifically so the runner never meets a node that is
both source and sink, and that flow runs left to right. §6.4's rule list does not
forbid wiring *into* an input or *out of* an output.

**Decided:** enforced (`io-direction-violation`). It is the rule that makes §5's
justification true; without it you can draw the exact shape §5 says cannot exist.

## 7. The example's progress node is never wired

In §6.3's `classify` graph, the `thinking` io node has `kind: progress` but no edge
touches it. This validates fine — nothing requires an io node be connected — but it
means the PRD's one worked example never demonstrates emitting progress.

**Decided:** reproduced faithfully, including the dangling node. Flagged because when
M4 implements progress, this example will not exercise it.

## 8. Union errors are unwrapped before becoming diagnostics

Not a PRD gap, but a consequence of one. All three client flavours share
`type: client`, so composition nodes cannot be a zod discriminated union. A plain
union reports every branch's complaints, which is unusable on a node face.
`flattenIssues` in `validate.ts` picks the branch with the fewest issues.
