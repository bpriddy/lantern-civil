"""Tests for analyze.py — the repo lift's analysts and verifiers.

The model is faked: each test scripts the tool calls an analyst or verifier makes, so
what is checked is the harness around the model — the read-only tools, the bounded
loop ending in one forced submit, the shape validation that keeps a malformed or
evidence-free claim out, and the mapping of verdicts onto the claims they judge.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import analyze as A  # noqa: E402

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


class Text:
    type = "text"
    text = "thinking"


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
    "apps/server/src/main.ts": "import { NestFactory } from '@nestjs/core';\nNestFactory.create(AppModule);\n",
    "apps/server/src/orders/orders.agent.ts": "export const pricingAgent = composeAgent({\n  prompt: PRICING,\n});\n",
    "apps/server/src/orders/orders.module.ts": "@Module({ providers: [OrdersService] })\nexport class OrdersModule {}\n",
    "apps/server/src/testing/model-fake.ts": "// A fake model client for tests.\nexport const fake = {};\n",
}
INDEX = sorted(FILES) + ["apps/server/src/big-unsent.ts"]


def test_workspace_tools_are_read_only_and_bounded() -> None:
    print("test_workspace_tools_are_read_only_and_bounded")
    ws = A.Workspace(FILES, INDEX)
    ok("apps/server/src/orders/orders.agent.ts" in ws.list_paths("apps/server/src/orders"), "list under a prefix")
    read = ws.read_file("apps/server/src/orders/orders.agent.ts")
    ok(read.startswith("1: export const pricingAgent") and "2:   prompt" in read, "reads are line-numbered for exact evidence")
    ok("listed but not sent" in ws.read_file("apps/server/src/big-unsent.ts"), "an unsent file says so")
    ok("no such file" in ws.read_file("nope.ts"), "a missing file says so")
    ok(ws.search(r"composeAgent", "apps/") == "apps/server/src/orders/orders.agent.ts:1: export const pricingAgent = composeAgent({",
       "search returns path:line: text")
    ok("bad pattern" in ws.search("(", ""), "a bad regex is an answer, not a crash")
    ws.reads = A.MAX_READS
    ok("budget spent" in ws.run("read_file", {"path": "apps/server/src/main.ts"}), "reads stop at the budget")


def test_validation_keeps_shape_and_drops_the_unsupported() -> None:
    print("test_validation_keeps_shape_and_drops_the_unsupported")
    raw = [
        {"kind": "agent", "subject": "pricing", "stance": "assert",
         "evidence": [{"file": "apps/server/src/orders/orders.agent.ts", "line": 1, "quote": "composeAgent({"}],
         "attrs": {"files": ["apps/server/src/orders/orders.agent.ts"], "secret": "x", "description": "Prices orders."}},
        {"kind": "service", "subject": "Orders!", "stance": "assert", "evidence": [{"file": "apps/server/src/main.ts", "line": 1, "quote": "x"}]},
        {"kind": "uses-agent", "subject": "orders", "stance": "assert", "evidence": [{"file": "apps/server/src/main.ts", "line": 1, "quote": "x"}]},
        {"kind": "service", "subject": "ghost", "stance": "assert", "evidence": [{"file": "invented.ts", "line": 1, "quote": "x"}]},
        {"kind": "function", "subject": "f", "stance": "assert", "evidence": []},
    ]
    claims, issues = A.validate_claims(raw, set(INDEX), "analyst:orders")
    ok([c["subject"] for c in claims] == ["pricing"], "only the well-formed, evidenced claim survives")
    ok(claims[0]["attrs"] == {"files": ["apps/server/src/orders/orders.agent.ts"], "description": "Prices orders."},
       "unknown attribute keys are dropped")
    ok(claims[0]["by"] == "analyst:orders", "the voice is recorded")
    ok(len(issues) == 4, "each drop is reported")
    claims, _ = A.validate_claims('[{"kind":"process","subject":"nightly","stance":"assert","evidence":[{"file":"apps/server/src/main.ts","line":2,"quote":"NestFactory"}]}]', set(INDEX), "a")
    ok(len(claims) == 1, "a double-encoded array is decoded")


def test_an_analyst_reads_then_submits_and_the_loop_is_bounded() -> None:
    print("test_an_analyst_reads_then_submits_and_the_loop_is_bounded")
    claim = {"kind": "agent", "subject": "pricing", "stance": "assert",
             "evidence": [{"file": "apps/server/src/orders/orders.agent.ts", "line": 1, "quote": "composeAgent"}]}
    client = FakeClient(
        Response(Text(), ToolUse("read_file", {"path": "apps/server/src/orders/orders.agent.ts"})),
        Response(ToolUse("submit_claims", {"claims": [claim]})),
    )
    area = {"id": "orders", "title": "Orders", "prefixes": ["apps/server/src/orders/"]}
    result = A.analyze_area(client, "m", area, [], FILES, INDEX)
    ok(result["claims"][0]["subject"] == "pricing" and result["reads"] == 1 and result["turns"] == 2, "read, then submitted")
    tool_result = client.calls[1]["messages"][-1]["content"][0]["content"]
    ok(tool_result.startswith("1: export const pricingAgent"), "the read went back as a tool result")
    ok("apps/server/src/orders/orders.agent.ts" in client.calls[0]["messages"][0]["content"], "the area's files are listed in the prompt")

    # A model that never submits is forced to on the last turn.
    reads = [Response(ToolUse("list_paths", {"prefix": ""})) for _ in range(A.MAX_TURNS - 1)]
    client = FakeClient(*reads, Response(ToolUse("submit_claims", {"claims": []})))
    result = A.analyze_area(client, "m", area, [], FILES, INDEX)
    ok(client.calls[-1]["tool_choice"] == {"type": "tool", "name": "submit_claims"}, "the last turn forces submit")
    ok(len(client.calls) == A.MAX_TURNS and result["claims"] == [], "and the loop stops there")


def test_verdicts_become_claims_on_the_claims_they_judge() -> None:
    print("test_verdicts_become_claims_on_the_claims_they_judge")
    proposed = [
        {"kind": "agent", "subject": "pricing", "stance": "assert", "by": "analyst:orders",
         "evidence": [{"file": "apps/server/src/orders/orders.agent.ts", "line": 1}]},
        {"kind": "agent", "subject": "fake", "stance": "assert", "by": "analyst:orders",
         "evidence": [{"file": "apps/server/src/testing/model-fake.ts", "line": 2}]},
    ]
    client = FakeClient(Response(ToolUse("submit_verdicts", {"verdicts": [
        {"key": "agent:pricing", "verdict": "support", "evidence": [{"file": "apps/server/src/orders/orders.agent.ts", "line": 1, "quote": "composeAgent"}]},
        {"key": "agent:fake", "verdict": "refute", "evidence": [{"file": "apps/server/src/testing/model-fake.ts", "line": 1, "quote": "A fake model client"}], "note": "A test double."},
        {"key": "agent:invented", "verdict": "support", "evidence": [{"file": "apps/server/src/main.ts", "line": 1}]},
    ]})))
    result = A.verify(client, "m", "orders", proposed, FILES, INDEX)
    stances = {c["subject"]: (c["stance"], c["by"]) for c in result["claims"]}
    ok(stances == {"pricing": ("assert", "verifier:orders"), "fake": ("refute", "verifier:orders")}, "support asserts, refute refutes")
    ok(any("unknown claim" in i for i in result["issues"]), "a verdict on a claim nobody made is ignored")
    ok("evidence" not in client.calls[0]["messages"][0]["content"].split("Claims to check:")[1].split('"key"')[0],
       "the verifier is not shown the analyst's evidence before the first claim key")


def test_analyze_runs_analysts_then_verifiers() -> None:
    print("test_analyze_runs_analysts_then_verifiers")
    A.CONCURRENCY = 1
    claim = {"kind": "service", "subject": "orders", "stance": "assert",
             "evidence": [{"file": "apps/server/src/orders/orders.module.ts", "line": 1, "quote": "@Module"}]}
    client = FakeClient(
        Response(ToolUse("submit_claims", {"claims": [claim]})),
        Response(ToolUse("submit_verdicts", {"verdicts": [
            {"key": "service:orders", "verdict": "support", "evidence": [{"file": "apps/server/src/orders/orders.module.ts", "line": 2, "quote": "OrdersModule"}]}]})),
    )
    out = A.analyze({"files": FILES, "index": INDEX, "claims": [], "areas": [{"id": "orders", "prefixes": ["apps/server/src/orders/"]}]}, client, "m")
    ok([c["by"] for c in out["claims"]] == ["analyst:orders", "verifier:orders"], "one analyst voice, one verifier voice")
    ok(out["areas"][0]["area"] == "orders" and out["promptVersion"] == A.PROMPT_VERSION, "the run is reported")


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
