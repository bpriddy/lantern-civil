"""The execution walk, exercised without a network or a model.

The agent is injected, so an io → code → agent → io graph — the PRD's M4 exit
shape — runs here with a stub standing where Claude will stand.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from civil_runtime.runner import (  # noqa: E402
    CancelledRun,
    GraphError,
    Node,
    parse_graph,
    run_graph,
    toposort,
)

CHECKS = 0


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


def scratch_with(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp(prefix="civil-test-"))
    for path, content in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return root


GRAPH = {
    "nodes": [
        {"id": "document", "type": "io", "direction": "in"},
        {"id": "normalize", "type": "code", "entrypoint": "steps/normalize.py"},
        {"id": "classifier", "type": "agent", "ref": "agents/c/agent.yaml"},
        {"id": "tools", "type": "code", "include": ["tools/**/*.py"], "entrypoint": "tools/search.py"},
        {"id": "record", "type": "io", "direction": "out"},
    ],
    "edges": [
        {"id": "e1", "kind": "flow", "from": {"node": "document"}, "to": {"node": "normalize"}},
        {"id": "e2", "kind": "flow", "from": {"node": "normalize"}, "to": {"node": "classifier"}},
        {"id": "e3", "kind": "flow", "from": {"node": "classifier"}, "to": {"node": "record"}},
        {"id": "e4", "kind": "capability", "from": {"node": "classifier"}, "to": {"node": "tools", "function": "search"}},
    ],
}

NORMALIZE = """
def handler(value):
    return {"text": value["raw"].strip().lower()}
"""


def test_toposort_orders_flow_and_ignores_capability() -> None:
    print("test_toposort_orders_flow_and_ignores_capability")
    nodes, edges = parse_graph(GRAPH)
    order = [n.id for n in toposort(nodes, edges)]
    ok(order.index("document") < order.index("normalize"), "input before step")
    ok(order.index("normalize") < order.index("classifier"), "step before agent")
    ok(order.index("classifier") < order.index("record"), "agent before output")
    ok("tools" in order, "capability targets are present, just unordered")


def test_cycle_is_a_graph_error() -> None:
    print("test_cycle_is_a_graph_error")
    cyclic = {
        "nodes": [
            {"id": "a", "type": "code", "entrypoint": "a.py"},
            {"id": "b", "type": "code", "entrypoint": "b.py"},
        ],
        "edges": [
            {"id": "e1", "kind": "flow", "from": {"node": "a"}, "to": {"node": "b"}},
            {"id": "e2", "kind": "flow", "from": {"node": "b"}, "to": {"node": "a"}},
        ],
    }
    nodes, edges = parse_graph(cyclic)
    try:
        toposort(nodes, edges)
        ok(False, "cycle detected")
    except GraphError as error:
        ok("cycle" in str(error), "cycle detected and named")


def test_end_to_end_with_a_stub_agent() -> None:
    print("test_end_to_end_with_a_stub_agent")
    root = scratch_with({"steps/normalize.py": NORMALIZE, "tools/search.py": "def search(q):\n    return []\n"})
    events: list[dict] = []
    seen_tools: list[list] = []

    def report(event: dict) -> bool:
        events.append(event)
        return False

    def agent(node: Node, value, tools) -> dict:
        seen_tools.append(tools)
        return {"category": "invoice", "saw": value["text"]}

    outputs = run_graph(
        scratch=root,
        graph_path="graphs/classify.graph.yaml",
        spec=GRAPH,
        run_input={"raw": "  Hello World  "},
        report=report,
        agent=agent,
    )

    ok(outputs == {"record": {"category": "invoice", "saw": "hello world"}}, "output flows out")
    ok(seen_tools[0][0].node_id == "tools", "the agent received its capability")
    ok(seen_tools[0][0].function == "search", "with the function the edge names")
    types = [e["type"] for e in events]
    ok(types.count("node.started") == 2, "code and agent both started")
    ok("node.output" in types, "the io out reported")
    failed = [e for e in events if e["type"] == "node.failed"]
    ok(failed == [], "nothing failed")


def test_a_failing_step_reports_and_raises() -> None:
    print("test_a_failing_step_reports_and_raises")
    root = scratch_with({"steps/normalize.py": "def handler(value):\n    raise ValueError('bad doc')\n"})
    events: list[dict] = []
    spec = {
        "nodes": [
            {"id": "in", "type": "io", "direction": "in"},
            {"id": "step", "type": "code", "entrypoint": "steps/normalize.py"},
        ],
        "edges": [{"id": "e1", "kind": "flow", "from": {"node": "in"}, "to": {"node": "step"}}],
    }
    try:
        run_graph(
            scratch=root, graph_path="g", spec=spec, run_input={},
            report=lambda e: events.append(e) or False,
            agent=lambda *a: None,
        )
        ok(False, "step failure raises")
    except ValueError:
        failures = [e for e in events if e["type"] == "node.failed"]
        ok(len(failures) == 1 and "bad doc" in failures[0]["payload"]["error"], "failure reported with its message")


def test_cancellation_stops_the_walk() -> None:
    print("test_cancellation_stops_the_walk")
    root = scratch_with({"steps/normalize.py": NORMALIZE})
    spec = {
        "nodes": [
            {"id": "in", "type": "io", "direction": "in"},
            {"id": "step", "type": "code", "entrypoint": "steps/normalize.py"},
            {"id": "out", "type": "io", "direction": "out"},
        ],
        "edges": [
            {"id": "e1", "kind": "flow", "from": {"node": "in"}, "to": {"node": "step"}},
            {"id": "e2", "kind": "flow", "from": {"node": "step"}, "to": {"node": "out"}},
        ],
    }
    calls = {"n": 0}

    def cancel_after_first(event: dict) -> bool:
        calls["n"] += 1
        return calls["n"] >= 2  # let node.started through, cancel on node.finished

    try:
        run_graph(
            scratch=root, graph_path="g", spec=spec, run_input={"raw": "x"},
            report=cancel_after_first, agent=lambda *a: None,
        )
        ok(False, "cancellation raises")
    except CancelledRun:
        ok(True, "cancellation stops the walk")


def test_async_handlers_run() -> None:
    print("test_async_handlers_run")
    root = scratch_with({
        "steps/wait.py": "import asyncio\n\nasync def handler(value):\n    await asyncio.sleep(0)\n    return value + 1\n",
    })
    spec = {
        "nodes": [
            {"id": "in", "type": "io", "direction": "in"},
            {"id": "step", "type": "code", "entrypoint": "steps/wait.py"},
            {"id": "out", "type": "io", "direction": "out"},
        ],
        "edges": [
            {"id": "e1", "kind": "flow", "from": {"node": "in"}, "to": {"node": "step"}},
            {"id": "e2", "kind": "flow", "from": {"node": "step"}, "to": {"node": "out"}},
        ],
    }
    outputs = run_graph(
        scratch=root, graph_path="g", spec=spec, run_input=41,
        report=lambda e: False, agent=lambda *a: None,
    )
    ok(outputs == {"out": 42}, "async handler awaited")


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
