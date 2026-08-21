"""Executing a dataflow graph (PRD 11.2).

Pure logic, standard library only — the same constraint as the rest of
civil-runtime, because this package is a dependency of the user's project. The
runner *service* wraps this with HTTP, YAML, and a model client; everything
here takes parsed dicts and injected callables, which is also what makes it
testable without a network.

The execution model, from PRD 5 and 11.2: flow edges are ordered and walked
topologically; capability edges grant tools and are ignored by the sort. A
node's input is its single upstream output, or a dict keyed by upstream node id
when several flow edges converge. io nodes bind the graph to the outside:
inputs take the run's input, outputs collect the run's result.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


class GraphError(Exception):
    """The graph cannot run as written — a manifest problem, not a code problem."""


class CancelledRun(Exception):
    """Raised inside the loop when the platform asked the run to stop."""


@dataclass
class Node:
    id: str
    type: str
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass
class Edge:
    id: str
    kind: str
    source: str
    target: str
    function: str | None = None


def parse_graph(spec: dict[str, Any]) -> tuple[list[Node], list[Edge]]:
    nodes = [
        Node(id=n["id"], type=n["type"], raw=n)
        for n in spec.get("nodes", [])
    ]
    edges = [
        Edge(
            id=e["id"],
            kind=e["kind"],
            source=e["from"]["node"],
            target=e["to"]["node"],
            function=e.get("to", {}).get("function"),
        )
        for e in spec.get("edges", [])
    ]
    return nodes, edges


def toposort(nodes: list[Node], edges: list[Edge]) -> list[Node]:
    """Flow order. Capability edges do not order anything (PRD 5)."""
    flow = [e for e in edges if e.kind == "flow"]
    ids = {n.id for n in nodes}
    for e in flow:
        if e.source not in ids or e.target not in ids:
            raise GraphError(f'edge "{e.id}" references a node that is not in the graph')

    incoming: dict[str, int] = {n.id: 0 for n in nodes}
    for e in flow:
        incoming[e.target] += 1

    ready = [n for n in nodes if incoming[n.id] == 0]
    # Deterministic order beats arbitrary dict order for reproducible traces.
    ready.sort(key=lambda n: n.id)
    out: list[Node] = []
    by_id = {n.id: n for n in nodes}

    while ready:
        node = ready.pop(0)
        out.append(node)
        for e in flow:
            if e.source != node.id:
                continue
            incoming[e.target] -= 1
            if incoming[e.target] == 0:
                ready.append(by_id[e.target])
        ready.sort(key=lambda n: n.id)

    if len(out) != len(nodes):
        stuck = sorted(set(incoming) - {n.id for n in out})
        raise GraphError(f"flow cycle involving: {', '.join(stuck)}")
    return out


def load_function(scratch: Path, entrypoint: str, name: str | None = None) -> Callable[..., Any]:
    """Imports a project file from the materialised scratch and returns its handler.

    The handler is found the way discovery finds it (PRD 7.2: the code is the
    contract): the named function when a name is given, otherwise the single
    public function of the module.
    """
    file = scratch / entrypoint
    if not file.is_file():
        raise GraphError(f"entrypoint {entrypoint} is not in the bundle")

    module_name = "civil_run_" + entrypoint.replace("/", "_").removesuffix(".py")
    spec = importlib.util.spec_from_file_location(module_name, file)
    if spec is None or spec.loader is None:
        raise GraphError(f"{entrypoint} could not be loaded")
    module = importlib.util.module_from_spec(spec)
    # The project's own imports resolve against the scratch root, nothing else new.
    added = str(scratch) not in sys.path
    if added:
        sys.path.insert(0, str(scratch))
    try:
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
    finally:
        if added:
            sys.path.remove(str(scratch))

    if name is not None:
        fn = getattr(module, name, None)
        if not callable(fn):
            raise GraphError(f"{entrypoint} has no function {name}")
        return fn

    # Discovery's convention exactly (PRD 7.2 — one convention, no second place to
    # disagree): a function named `handler` wins; else the single public function.
    handler = getattr(module, "handler", None)
    if callable(handler):
        return handler

    public = [
        v
        for k, v in vars(module).items()
        if callable(v) and not k.startswith("_") and getattr(v, "__module__", None) == module_name
    ]
    if len(public) == 1:
        return public[0]
    if not public:
        raise GraphError(f"{entrypoint} has no public function to run")
    names = ", ".join(getattr(f, "__name__", "?") for f in public)
    raise GraphError(
        f"{entrypoint} has several public functions ({names}); name one `handler` so Civil knows which is the step"
    )


def call(fn: Callable[..., Any], value: Any) -> Any:
    """Sync or async, one argument — the shape discovery projects as ports."""
    result = fn(value)
    if asyncio.iscoroutine(result):
        return asyncio.run(result)
    return result


# Injected by the service. `report` returns True when the run should stop;
# `agent` runs one agent node and returns its output.
Report = Callable[[dict[str, Any]], bool]
Agent = Callable[[Node, Any, list["ToolRef"]], Any]


@dataclass
class ToolRef:
    """A capability edge resolved to something callable (PRD 5, 11.3)."""

    node_id: str
    entrypoint: str
    function: str | None


def run_graph(
    *,
    scratch: Path,
    graph_path: str,
    spec: dict[str, Any],
    run_input: Any,
    report: Report,
    agent: Agent,
    load_subgraph: Callable[[str], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Walks one graph to completion and returns {io-out id: value}.

    Every lifecycle moment goes through `report`, whose boolean answer is the
    cancellation poll — reporting and listening are one channel, here as
    everywhere.
    """
    nodes, edges = parse_graph(spec)
    order = toposort(nodes, edges)
    flow = [e for e in edges if e.kind == "flow"]
    capabilities = [e for e in edges if e.kind == "capability"]
    by_id = {n.id: n for n in nodes}

    def stop_if_cancelled(cancelled: bool) -> None:
        if cancelled:
            raise CancelledRun()

    outputs: dict[str, Any] = {}
    results: dict[str, Any] = {}

    in_nodes = [n for n in order if n.type == "io" and n.raw.get("direction") == "in"]

    for node in order:
        upstream = [e for e in flow if e.target == node.id]
        if node.type == "io" and node.raw.get("direction") == "in":
            # The run's input: keyed by node id when there are several doors in,
            # the whole input when there is one.
            if len(in_nodes) == 1:
                value = run_input
            elif isinstance(run_input, dict):
                value = run_input.get(node.id)
            else:
                value = None
            results[node.id] = value
            continue

        if upstream:
            if len(upstream) == 1:
                value = results.get(upstream[0].source)
            else:
                value = {e.source: results.get(e.source) for e in upstream}
        else:
            # A node no flow reaches: a pure capability target, or dangling. Skip —
            # capability targets are invoked by agents, not by the walk.
            if node.type == "code":
                continue
            value = None

        if node.type == "io":  # direction out — a binding, not work
            outputs[node.id] = value
            results[node.id] = value
            stop_if_cancelled(
                report({"type": "node.output", "nodeId": node.id, "payload": {"value": value}})
            )
            continue

        stop_if_cancelled(report({"type": "node.started", "nodeId": node.id}))

        try:
            if node.type == "code":
                fn = load_function(scratch, node.raw["entrypoint"])
                result = call(fn, value)
            elif node.type == "agent":
                tools = [
                    ToolRef(
                        node_id=e.target,
                        entrypoint=_tool_entrypoint(by_id.get(e.target)),
                        function=e.function,
                    )
                    for e in capabilities
                    if e.source == node.id and e.target in by_id
                ]
                result = agent(node, value, tools)
            elif node.type == "subgraph":
                if load_subgraph is None:
                    raise GraphError("subgraphs are not available in this runner")
                sub = load_subgraph(node.raw["ref"])
                result = run_graph(
                    scratch=scratch,
                    graph_path=node.raw["ref"],
                    spec=sub,
                    run_input=value,
                    report=lambda e: report({**e, "graphPath": node.raw["ref"]}),
                    agent=agent,
                    load_subgraph=load_subgraph,
                )
                # A subgraph with one output flows that value; several stay a dict.
                if isinstance(result, dict) and len(result) == 1:
                    result = next(iter(result.values()))
            else:
                raise GraphError(f'node "{node.id}" has unrunnable type {node.type}')
        except CancelledRun:
            raise
        except Exception as error:  # noqa: BLE001 — the log is where failures go
            report({"type": "node.failed", "nodeId": node.id, "payload": {"error": str(error)}})
            raise

        results[node.id] = result
        stop_if_cancelled(
            report({"type": "node.finished", "nodeId": node.id, "payload": {"output": result}})
        )

    return outputs


def _tool_entrypoint(node: Node | None) -> str:
    if node is None:
        return ""
    entry = node.raw.get("entrypoint")
    if entry:
        return str(entry)
    include = node.raw.get("include") or []
    # A capability target without an entrypoint: the function is named on the edge
    # and lives in the include set; the service resolves the file by glob. Here we
    # pass the first include through for it to resolve.
    return str(include[0]) if include else ""
