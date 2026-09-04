"""Lift, exercised without a network — pure ast plus a graph-document scan.

The load-bearing test is the golden round-trip: the transpiler's own emission of
the classify graph must read back to exactly that graph's flow edges. The rest
pin the refusals — control flow, unknown symbols, an absent run() — that the
straight-line convention makes into honest "unliftable" answers rather than guesses.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lift import LiftError, lift_graph  # noqa: E402

REPO = Path(__file__).resolve().parents[2]

CHECKS = 0


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


DOC = """\
apiVersion: civil/v1
kind: Graph
metadata: { id: classify }
spec:
  nodes:
    - { id: document, type: io, direction: in, schema: schemas/document.schema.json }
    - { id: normalize, type: code, entrypoint: src/steps/normalize/main.py }
    - { id: classifier, type: agent, ref: agents/classifier/agent.yaml }
    - { id: enrich, type: subgraph, ref: graphs/enrich.graph.yaml }
    - { id: search_tools, type: code }
    - { id: record, type: io, direction: out, schema: schemas/record.schema.json }
  edges:
    - { id: e1, kind: flow, from: { node: document }, to: { node: normalize } }
"""

ORCH = """\
from agents.classifier.agent import run as classifier
from graphs.enrich import run as enrich
from src.steps.normalize.main import handler as normalize


def run(document):
    normalized = normalize(document)
    classified = classifier(normalized)
    record = enrich(classified)
    return record
"""


def test_golden_round_trip_from_real_files() -> None:
    print("test_golden_round_trip_from_real_files")
    orch = (REPO / "runner/tests/golden/doc-pipeline/graphs/classify.py").read_text()
    doc = (REPO / "examples/doc-pipeline/graphs/classify.graph.yaml").read_text()
    result = lift_graph("graphs/classify.graph.yaml", doc, orch)
    ok(result["unliftable"] is False, "the golden emission is liftable")
    ok(
        result["edges"] == [
            {"from": "document", "to": "normalize"},
            {"from": "normalize", "to": "classifier"},
            {"from": "classifier", "to": "enrich"},
            {"from": "enrich", "to": "record"},
        ],
        "run() lifts to exactly the graph's four flow edges, in order",
    )


def test_inline_fixture_lifts() -> None:
    print("test_inline_fixture_lifts")
    result = lift_graph("graphs/classify.graph.yaml", DOC, ORCH)
    ok(not result["unliftable"] and len(result["edges"]) == 4, "the inline fixture lifts to four edges")


def test_idempotent_edge_set() -> None:
    print("test_idempotent_edge_set")
    a = lift_graph("g.yaml", DOC, ORCH)["edges"]
    b = lift_graph("g.yaml", DOC, ORCH)["edges"]
    ok(a == b, "lifting is deterministic")


def test_control_flow_is_unliftable() -> None:
    print("test_control_flow_is_unliftable")
    orch = ORCH.replace(
        "    classified = classifier(normalized)",
        "    if normalized:\n        classified = classifier(normalized)\n    else:\n        classified = normalized",
    )
    result = lift_graph("g.yaml", DOC, orch)
    ok(result["unliftable"] and "control flow" in result["reason"], "a conditional in run() is unliftable")


def test_unknown_symbol_is_unliftable() -> None:
    print("test_unknown_symbol_is_unliftable")
    orch = ORCH.replace("record = enrich(classified)", "record = mystery(classified)")
    result = lift_graph("g.yaml", DOC, orch)
    ok(result["unliftable"] and "mystery" in result["reason"], "a call to no node is unliftable")


def test_absent_run_is_unliftable() -> None:
    print("test_absent_run_is_unliftable")
    result = lift_graph("g.yaml", DOC, "x = 1\n")
    ok(result["unliftable"] and "run()" in result["reason"], "no run() is unliftable")


def test_bad_python_raises() -> None:
    print("test_bad_python_raises")
    try:
        lift_graph("g.yaml", DOC, "def run(:\n")
        raise AssertionError("unparseable code must raise LiftError")
    except LiftError as error:
        ok("does not parse" in str(error), "unparseable orchestration is a 400, not an answer")


def test_no_nodes_is_unliftable() -> None:
    print("test_no_nodes_is_unliftable")
    result = lift_graph("g.yaml", "spec:\n  nodes: []\n", ORCH)
    ok(result["unliftable"], "a document with no nodes cannot bind any call")


def main() -> int:
    for fn in [
        test_golden_round_trip_from_real_files,
        test_inline_fixture_lifts,
        test_idempotent_edge_set,
        test_control_flow_is_unliftable,
        test_unknown_symbol_is_unliftable,
        test_absent_run_is_unliftable,
        test_bad_python_raises,
        test_no_nodes_is_unliftable,
    ]:
        fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
