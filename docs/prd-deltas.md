# PRD deltas

Places where the PRD was silent, self-contradictory, or where implementation forced a
choice. Each entry says what was decided and how to reverse it. Nothing here is a
complaint — a v1 PRD that specified all of this would have been guessing.

Anything marked **needs a call** is a decision the owner should make; the current
behaviour is a placeholder that works.

---

## 1. Node ids forbid underscores, but the example uses one — **resolved**

§6.4 is normative: `^[a-z][a-z0-9-]{0,63}$`. §6.3's example graph declares
`search_tools`, which that pattern rejects.

**Owner's call: widen the pattern.** `ID_PATTERN` is now
`^[a-z][a-z0-9_-]{0,63}$`, so a code node's id can match the Python module it points
at. The example keeps the PRD's own `search_tools` spelling.

**Consequence to watch:** two spellings of the same concept can now coexist across a
project and nothing forbids it. If that becomes noise, a lint rule is a better
remedy than narrowing the pattern, which would be a manifest migration.
**§6.4 of the PRD should be updated to match.**

## 2. Composition edges carry no `kind` — **resolved**

§4 says composition edges mean "depends-on / routes-to", two distinct relations. The
§6.2 example has no `kind` field, unlike graph edges which do.

**Owner's call: add it now,** before M3 writes real manifests and the change becomes
a migration. Composition edges now require `kind: routes-to | depends-on`.

Carrying the relation explicitly is what makes it checkable, so validation gained
rules the inferred version could not express:

| kind | source | target |
|---|---|---|
| `routes-to` | client | client or service, never a process |
| `depends-on` | service or process | service |

A process is never a `routes-to` target because it has a trigger, not a caller (§4).
Service→client stays a distinct diagnostic (`client-is-edge-target`) rather than
folding into these, because dragging an edge backwards is the likeliest way to
produce it and deserves its own message.

**§6.2 and §4 of the PRD should be updated to match.**

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

## 9. "Write zero auth code" — kept, with one exception

§12 puts auth in IAP: no user table, no passwords, no sessions. That is followed
exactly — `owner_id` is the subject IAP asserts and there is no users table.

**The exception:** the `x-goog-authenticated-user-*` headers are trustworthy only if
nothing can reach the service except through IAP. That is an ingress setting, and an
ingress setting is one console click from turning the app into an open door that
still looks authenticated. So the signed assertion (`x-goog-iap-jwt-assertion`) is
verified against Google's JWKS in production. ~40 lines, in
`apps/api/src/http/identity.ts`.

Config refuses to boot on the combinations that fail open: a dev identity in
production, or verification enabled without an audience. Production without
verification is legal but warns loudly at boot.

**To reverse:** set `CIVIL_VERIFY_IAP_JWT=false`, which drops back to trusting the
headers. Only correct if Terraform has ingress locked to the load balancer.
