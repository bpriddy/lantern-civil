# The emitted code contract

What the transpiler is allowed to write. Settled in discussion on 2026-08-21,
companion to `docs/transpilation.md` and `docs/app-session.md`. This is the
product surface: the code Civil emits is the strongest claim Civil makes about
itself, and every rule here exists to keep that claim honest.

## Principles

1. **`civil/` is never read at runtime.** The documents matter at design time;
   the deployed application is ordinary code and ordinary data. Delete the
   folder and a transpiled app still runs — Civil is a supplement, and
   supplements are not load-bearing.
2. **Civil never stands between the app and its vendors.** Emitted code uses
   the idioms a strong engineer would choose — official SDKs, plain functions,
   files for prompts. Civil is a devex pattern, not a runtime pattern.
3. **Proportional emission.** The code requires exactly as much runtime as the
   graph's semantics demand, and no more. The test for every import:
   *would a strong engineer, hand-writing this exact application, accept it?*
4. **Complexity tracks the application.** A toy reads like a toy; a twelve-node
   harness reads like serious software. Nobody pays for machinery their graph
   does not use.
5. **Deterministic and diff-stable.** Sorted imports, stable ordering from the
   toposort, no timestamps. The same documents produce the same bytes,
   enforced by golden-file tests — the YAML splice discipline, inherited.
6. **Re-liftable.** Emitted orchestration stays within conventions analysis can
   recover: straight-line `run()` bodies (assignments, calls, literals, a
   return), agent configuration as literal kwargs. Hand edits inside the
   conventions lift; beyond them, mine-or-theirs.

## The emission tiers

| Graph semantics | What is emitted | Runtime dependency |
|---|---|---|
| Linear flow | Plain functions, plain calls | None |
| Any agent | A plain function calling the `Engine` interface, `ClaudeEngine` by default | `civil_runtime.engines` (thin — the library's floor) |
| Parallel branches, simple joins | `asyncio` in the emitted code | Standard library |
| Retries, partial-failure semantics, node result caching, durable runs, supervision | Orchestration through `civil-runtime` | The earned import |

The line between tiers is decided per feature during transpiler work, always by
the strong-engineer test. When in doubt, emit the lower tier.

## Agents

An agent is emitted as a **plain function written against the `Engine`
interface** — never a direct vendor SDK call (owner's ruling, 2026-08-21,
revising an earlier direct-call draft). `civil-runtime` defines a small
`Engine` protocol — system, user content, tools, and a turn budget in; a
`Reply` out — and ships **`ClaudeEngine` as the default implementation**. The
vendor idiom (the Anthropic SDK and its `tool_runner` loop, model ids resolved
at build time per PRD §12) lives inside the adapter, once, in the library —
not repeated in every application file. `Reply` absorbs conclusion-extraction
boilerplate. This is the strong-engineer idiom, not an exception to it: teams
wrap LLM vendors behind thin adapters by reflex; vendor lock at every call
site is what they regret.

The emitted function's body constructs its engine at module level with literal
kwargs — `engine = ClaudeEngine(model=...)` — so the node's optional `engine`
facet maps to one statically-liftable line, and swapping engines changes one
line (or none: an `engine_from_env(default=...)` construction makes it a
deploy-time choice). Local/OSS engines (Ollama, vLLM and other
OpenAI-compatible endpoints) are thin adapters configured by environment
variables, which is where all engine credentials and base URLs live. This
revises PRD §15's "Anthropic only": **Claude by default, behind an
interface.** Consequence, accepted knowingly: any app with an agent imports
`civil_runtime.engines` — the library's guaranteed floor, and the module most
strictly held to the standalone bar below.

**`agent.yaml` dissolves.** Model, turn budget, and engine become literal
kwargs in the emitted function — statically liftable, so the inspector edits
them by editing the code, which is the established rule for every context.
Prompts become ordinary application assets (`prompts/*.md` by directory
reference), loaded by the app the way apps load templates. The agent node in
the graph document keeps only identity, wiring, and layout.

## The runtime library's bar

`civil-runtime`'s runtime half is justified only as **a library a hand-writing
engineer would choose with Civil nowhere in sight** — standalone-documented,
boring, usable in applications that never saw a canvas. Not "Civil's engine
that emitted code happens to call": a good graph-orchestration library that
Civil also emits against. A feature that cannot clear that bar is emitted as
standard library code instead.

Dev-side machinery — the IDE runner's instrumentation, discovery, lifting — is
Civil's tooling and ships in no application ever.

## Observability

Instrumentation lives in the observer, not the code. During IDE runs, the
runner wraps the mapped functions (the documents know node ↔ symbol) and the
model client, emitting the event log — zero trace in the emitted files. In the
library tier, orchestration exposes hooks; the IDE subscribes to them in dev,
and production can plug them into whatever it already uses (OpenTelemetry as
the likely dialect). Boundary validation in strict mode is a dev-time concern,
injected by the runner, absent from production by default (PRD §11.3 already
wanted lenient there).

## Open items, recorded not resolved

- The exact earn-the-import line, feature by feature, decided as the
  transpiler meets each one.
- Multi-vendor template families (an `engine` facet naming a non-Claude vendor
  changes the emitted body) and how far codegen chases each SDK's idiom drift.
- Migration: the doc-pipeline example and civil-project-test move to the
  emitted-code world when the transpiler lands — agent.yaml files retire then.
