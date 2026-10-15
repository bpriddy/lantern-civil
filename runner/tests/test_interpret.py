"""Tests for interpret.py — reading how an application thinks and what it is built on.

The model is faked: each test scripts the tool calls, so what is checked is the harness
around it — the diagram's shape kept to its closed kinds, what a verifier is shown, the
verdicts mapped onto the items they judge, and the prompts' word budgets.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import interpret as I  # noqa: E402

CHECKS = 0


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


class ToolUse:
    type = "tool_use"

    def __init__(self, name: str, input: dict, id: str = "t1") -> None:
        self.name, self.input, self.id = name, input, id


class Response:
    def __init__(self, *content) -> None:
        self.content = list(content)
        self.stop_reason = "tool_use"


class FakeClient:
    def __init__(self, *responses: Response) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []
        self.messages = self

    def create(self, **kwargs) -> Response:
        self.calls.append(kwargs)
        return self.responses.pop(0)


FILES = {
    "src/digest/job.ts": "export async function run() {\n  const items = await retrieve();\n  const digest = await writer(items);\n  await save(digest);\n}\n",
    "src/digest/writer.ts": "export const writer = composeAgent({ prompt: DIGEST });\n",
}
INDEX = sorted(FILES)
EV = [{"file": "src/digest/job.ts", "line": 3, "quote": "writer(items)"}]


def test_a_diagram_keeps_to_its_shape() -> None:
    print("test_a_diagram_keeps_to_its_shape")
    raw = {
        "nodes": [
            {"id": "user", "kind": "actor", "name": "Reader"},
            {"id": "writer", "kind": "agent", "name": "Digest writer", "summary": "One call; not validated; no check.", "evidence": EV, "realizedBy": ["digest"]},
            {"id": "db", "kind": "datastore", "name": "Postgres", "evidence": EV},
            {"id": "Bad Id", "kind": "step", "name": "x"},
            {"id": "writer", "kind": "agent", "name": "again"},
        ],
        "edges": [
            {"from": "user", "to": "writer", "kind": "next", "label": "a morning"},
            {"from": "writer", "to": "user", "kind": "next", "label": "a digest to read"},
            {"from": "writer", "to": "db", "kind": "calls"},
        ],
    }
    diagram, issues = I.validate_diagram(raw, "flow", "analyst", set(INDEX), set())
    ok([n["id"] for n in diagram["nodes"]] == ["user", "writer"], "a node of another shape, a bad id and a repeat are dropped")
    ok(len(diagram["edges"]) == 2, "a loop back is kept; an edge to a dropped node is not")
    ok(len(issues) == 4, "each drop is said")


def test_edges_may_ride_inside_their_nodes() -> None:
    print("test_edges_may_ride_inside_their_nodes")
    raw = {"nodes": [
        {"id": "job", "kind": "trigger", "name": "Job", "next": [{"to": "writer", "kind": "next", "label": "items"}]},
        {"id": "writer", "kind": "agent", "name": "Writer", "next": [{"to": "job", "kind": "next", "label": "a retry"}, {"to": "ghost", "kind": "next"}]},
    ]}
    diagram, issues = I.validate_diagram(raw, "flow", "analyst", set(INDEX), set())
    ok([(e["from"], e["to"]) for e in diagram["edges"]] == [("job", "writer"), ("writer", "job")], "each node's next becomes its edges, loops included")
    ok(len(issues) == 1, "an edge to no node is said")


def test_a_verifier_is_shown_items_without_evidence() -> None:
    print("test_a_verifier_is_shown_items_without_evidence")
    diagram = {
        "nodes": [{"id": "api", "kind": "service", "name": "API", "evidence": EV, "decisions": [{"statement": "NestJS modular monolith.", "evidence": EV}]}],
        "edges": [],
    }
    items = I.item_keys(diagram)
    ok([i["key"] for i in items] == ["node:api", "decision:api#0"], "a node and its decision are items")
    ok(all("evidence" not in i for i in items), "no evidence is shown")


def test_a_task_draws_a_diagram_and_has_it_checked() -> None:
    print("test_a_task_draws_a_diagram_and_has_it_checked")
    drawn = {
        "nodes": [
            {"id": "job", "kind": "trigger", "name": "Morning job", "evidence": EV},
            {"id": "writer", "kind": "agent", "name": "Digest writer", "evidence": EV},
        ],
        "edges": [{"from": "job", "to": "writer", "kind": "next", "label": "retrieved items", "evidence": EV}],
    }
    client = FakeClient(
        Response(ToolUse("read_file", {"path": "src/digest/job.ts"})),
        Response(ToolUse("submit_diagram", drawn)),
        Response(ToolUse("submit_verdicts", {"verdicts": [
            {"key": "node:job", "verdict": "support"},
            {"key": "node:writer", "verdict": "refute", "note": "a function"},
            {"key": "node:ghost", "verdict": "support"},
        ]})),
    )
    out = I.interpret({"task": {"id": "digest", "shape": "flow", "title": "Digest", "paths": ["src/digest/"]}, "files": FILES, "index": INDEX}, client, "m")
    ok([n["id"] for n in out["diagram"]["nodes"]] == ["job", "writer"], "the diagram comes back whole; the API weighs it")
    ok(out["verdicts"] == {"node:job": {"verdict": "support"}, "node:writer": {"verdict": "refute", "note": "a function"}}, "verdicts on unknown items are ignored")
    ok(client.calls[0]["system"] == I.FLOW_ANALYST_SYSTEM and "src/digest/job.ts" in client.calls[0]["messages"][0]["content"], "a flow analyst is shown its paths")
    ok(client.calls[2]["system"] == I.VERIFIER_SYSTEM, "then a verifier checks it")


def test_a_synthesizer_may_open_only_the_diagrams_it_was_given() -> None:
    print("test_a_synthesizer_may_open_only_the_diagrams_it_was_given")
    raw = {"nodes": [{"id": "dig", "kind": "flow", "name": "Digest", "ref": "digest"}, {"id": "x", "kind": "flow", "name": "X", "ref": "nowhere"}], "edges": []}
    diagram, _ = I.validate_diagram(raw, "flow", "synth", set(INDEX), {"digest"})
    ok(diagram["nodes"][0].get("ref") == "digest" and "ref" not in diagram["nodes"][1], "a door opens only a given diagram")


def test_prompts_keep_their_word_budgets_and_the_writing_rules() -> None:
    print("test_prompts_keep_their_word_budgets_and_the_writing_rules")
    budgets = {
        "FLOW_TERMS": 160, "ARCHITECTURE_TERMS": 150, "FLOW_ANALYST_SYSTEM": 440, "ARCHITECTURE_ANALYST_SYSTEM": 350,
        "FLOW_SYNTH_SYSTEM": 340, "ARCHITECTURE_SYNTH_SYSTEM": 340, "VERIFIER_SYSTEM": 170,
    }
    for name, most in budgets.items():
        words = len(getattr(I, name).split())
        ok(words <= most, f"{name} is {words} words, at most {most}")
        ok(not re.search(r"\b(MUST|NEVER|ALWAYS|IMPORTANT|CRITICAL)\b", getattr(I, name)), f"{name} uses no emphasis words")


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
