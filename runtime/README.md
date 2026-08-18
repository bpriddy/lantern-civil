# civil-runtime

Executes Civil graph manifests directly.

PRD §11.1: this is **a dependency of every project, not a code generator**. There is
no compile step whose output could drift from the picture on the canvas. That is also
why it lives here in Python rather than in the TypeScript monorepo — it runs where
the user's code runs, and a Civil project's code nodes and tools are Python files
(§15).

Not LangGraph, for the two reasons §11.1 gives: its state model is a shared mutable
object with reducers where edges are control flow, while Civil's is typed ports where
data flows along edges; and its graphs are built imperatively in Python, so using it
would mean generating code from manifests, which is the drift problem again.

## Split with the TypeScript side

| Concern | Lives in | Why |
|---|---|---|
| Manifest shapes, structural validation, ops | `packages/schema` (TS) | §6.4 requires the browser to run validation |
| Contract discovery from Python source (§7.2) | here | needs a Python AST |
| Graph execution, agent loop, tool boundary (§11) | here | runs where the user's code runs |
| Git, YAML writing, jobs, event log persistence | `apps/api` (TS) | Civil's own server concerns |

The two sides agree on the manifest format and the event vocabulary of §9.1, and
nothing else.

## Status

Skeleton. Built in M4 — see PRD §14.
