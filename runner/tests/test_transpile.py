"""The transpiler and the pattern analyzer, exercised without a network.

A fake client stands where Claude will stand, so what is tested is everything
deterministic around the model: the forced emit_files parsing, each validator,
the retry loop's feedback, the analyzer's prompt caps, and the /transpile/meta
seam's wire shape (a real socket, no model).
"""

from __future__ import annotations

import json
import sys
import threading
import types
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime" / "src"))

# server's import chain reaches PyYAML (agent, execute), but nothing exercised
# here parses YAML — a stub keeps this suite runnable under plain python3.
sys.modules.setdefault("yaml", types.ModuleType("yaml"))

from agent import DEFAULT_MODEL  # noqa: E402
from patterns import analyze  # noqa: E402
from server import Handler  # noqa: E402
from transpile import (  # noqa: E402
    PROMPT_VERSION,
    TranspileValidationError,
    transpile,
    validate,
)

CHECKS = 0


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


class Text:
    type = "text"

    def __init__(self, text: str) -> None:
        self.text = text


class ToolUse:
    type = "tool_use"
    name = "emit_files"

    def __init__(self, files: list[dict], id: str = "call_1") -> None:
        self.input = {"files": files}
        self.id = id


class Response:
    def __init__(self, content: list, stop_reason: str = "tool_use") -> None:
        self.content = content
        self.stop_reason = stop_reason


class FakeMessages:
    def __init__(self, responses: list[Response]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def create(self, **kwargs) -> Response:
        self.calls.append(kwargs)
        return self.responses.pop(0)


class FakeClient:
    def __init__(self, *responses: Response) -> None:
        self.messages = FakeMessages(list(responses))


def emission(*entries: tuple[str, str], id: str = "call_1") -> Response:
    return Response([ToolUse([{"path": p, "content": c} for p, c in entries], id=id)])


DOCUMENTS = {
    "civil/civil.yaml": "version: 1\n",
    "civil/graphs/classify.yaml": "spec:\n  nodes: []\n",
    "civil/prompts/classifier.md": "Classify the document.\n",
}

CONTEXT = {"src/tools/search.py": "def search(q):\n    return []\n"}

GOOD = """\
from pathlib import Path

from civil_runtime.engines import Engine

from src.tools.search import search

engine = Engine(model="claude-sonnet-5")


def classify(text):
    system = Path("civil/prompts/classifier.md").read_text()
    return engine.run(system=system, user=text, tools=[search], max_turns=4).text


def run(value):
    category = classify(value)
    return category
"""


def test_transpile_parses_the_forced_tool_call() -> None:
    print("test_transpile_parses_the_forced_tool_call")
    client = FakeClient(emission(("src/classify.py", GOOD)))
    result = transpile(DOCUMENTS, "## repo patterns", CONTEXT, client, "model-x")

    ok(result == {"files": {"src/classify.py": GOOD}, "attempts": 1}, "files and attempts come back")
    call = client.messages.calls[0]
    ok(call["model"] == "model-x", "the caller's model is used")
    ok(call["tool_choice"] == {"type": "tool", "name": "emit_files"}, "emit_files is forced")
    ok([t["name"] for t in call["tools"]] == ["emit_files"], "emit_files is the only tool")
    prompt = call["messages"][0]["content"]
    ok("## repo patterns" in prompt, "the patterns markdown rides verbatim")
    ok("The repo's own conventions — follow them" in prompt, "and is marked as the repo's own")
    ok(CONTEXT["src/tools/search.py"] in prompt, "context files are shown")
    ok(DOCUMENTS["civil/graphs/classify.yaml"] in prompt, "documents are shown")


def test_transpile_without_patterns_says_so() -> None:
    print("test_transpile_without_patterns_says_so")
    client = FakeClient(emission(("src/classify.py", GOOD)))
    transpile(DOCUMENTS, None, CONTEXT, client, "m")
    prompt = client.messages.calls[0]["messages"][0]["content"]
    ok("No pattern analysis exists" in prompt, "absent patterns fall back to defaults")


def test_validators_pass_a_lawful_emission() -> None:
    print("test_validators_pass_a_lawful_emission")
    ok(validate({"src/classify.py": GOOD}, DOCUMENTS, CONTEXT) == [], "a lawful emission has no issues")


def test_validator_catches_a_syntax_error() -> None:
    print("test_validator_catches_a_syntax_error")
    issues = validate({"src/broken.py": "def run(:\n", "src/ok.py": "def run(v):\n    return v\n"}, DOCUMENTS, CONTEXT)
    ok(any("does not parse" in i and "src/broken.py" in i for i in issues), "the syntax error is named")


def test_validator_catches_vendor_imports() -> None:
    print("test_validator_catches_vendor_imports")
    direct = "import anthropic\n\n\ndef run(v):\n    return v\n"
    from_form = "from openai import OpenAI\n\n\ndef run(v):\n    return v\n"
    ok(any("anthropic" in i for i in validate({"a.py": direct}, DOCUMENTS, CONTEXT)), "import anthropic is caught")
    ok(any("openai" in i for i in validate({"a.py": from_form}, DOCUMENTS, CONTEXT)), "from openai import is caught")


def test_validator_demands_a_module_level_engine() -> None:
    print("test_validator_demands_a_module_level_engine")
    hidden = """\
from civil_runtime.engines import Engine


def run(value):
    engine = Engine(model="claude-sonnet-5")
    return engine.run(system="s", user=value).text
"""
    issues = validate({"src/agent.py": hidden}, DOCUMENTS, CONTEXT)
    ok(any("module level" in i for i in issues), "an Engine hidden in a function is caught")


def test_validator_rejects_vendor_class_names() -> None:
    print("test_validator_rejects_vendor_class_names")
    leaked = """\
from civil_runtime.engines import Engine, ClaudeEngine

engine = Engine(model="claude-sonnet-5")


def run(value):
    return engine.run(system="s", user=value).text
"""
    issues = validate({"src/agent.py": leaked}, DOCUMENTS, CONTEXT)
    ok(any("ClaudeEngine" in i for i in issues), "a vendor class name is caught")


def test_validator_protects_human_owned_paths() -> None:
    print("test_validator_protects_human_owned_paths")
    issues = validate(
        {"src/tools/search.py": "def run(v):\n    return v\n"}, DOCUMENTS, CONTEXT
    )
    ok(any("human-owned" in i for i in issues), "a collision with context is caught")


def test_validator_wants_run_per_graph_document() -> None:
    print("test_validator_wants_run_per_graph_document")
    issues = validate({"src/helpers.py": "def helper(v):\n    return v\n"}, DOCUMENTS, CONTEXT)
    ok(any("define run()" in i for i in issues), "a graph without its run() module is caught")
    dotted = {"civil/pipeline.graph.yaml": "spec: {}\n"}
    issues = validate({"src/helpers.py": "def helper(v):\n    return v\n"}, dotted, CONTEXT)
    ok(any("define run()" in i for i in issues), "the .graph.yaml naming counts as a graph too")


def test_retry_feeds_issues_back() -> None:
    print("test_retry_feeds_issues_back")
    client = FakeClient(
        emission(("src/classify.py", "def run(:\n"), id="call_1"),
        emission(("src/classify.py", GOOD), id="call_2"),
    )
    result = transpile(DOCUMENTS, None, CONTEXT, client, "m")

    ok(result["attempts"] == 2, "the fix on the second attempt counts as two")
    ok(result["files"]["src/classify.py"] == GOOD, "the corrected emission wins")
    retry = client.messages.calls[1]["messages"]
    ok(len(retry) == 3, "the retry carries prompt, emission, and complaint")
    feedback = retry[2]["content"][0]
    ok(feedback["type"] == "tool_result" and feedback["tool_use_id"] == "call_1", "the complaint answers the tool call")
    ok(feedback["is_error"] and "does not parse" in feedback["content"], "the issues ride in the complaint")


def test_retries_exhaust_into_the_error() -> None:
    print("test_retries_exhaust_into_the_error")
    bad = emission(("src/classify.py", "import anthropic\n\n\ndef run(v):\n    return v\n"))
    client = FakeClient(bad, bad, bad)
    try:
        transpile(DOCUMENTS, None, CONTEXT, client, "m")
        ok(False, "exhaustion raises")
    except TranspileValidationError as error:
        ok(error.attempts == 3, "three attempts were spent")
        ok(any("anthropic" in i for i in error.issues), "the last issues survive in the error")
        ok(len(client.messages.calls) == 3, "no fourth call was made")


def test_malformed_emission_is_an_issue_not_a_crash() -> None:
    print("test_malformed_emission_is_an_issue_not_a_crash")
    malformed = Response([ToolUse([{"path": "a.py"}], id="call_1")])
    client = FakeClient(malformed, emission(("src/classify.py", GOOD), id="call_2"))
    result = transpile(DOCUMENTS, None, CONTEXT, client, "m")
    ok(result["attempts"] == 2, "a malformed entry is fed back like any issue")


def test_analyze_assembles_and_caps_the_prompt() -> None:
    print("test_analyze_assembles_and_caps_the_prompt")
    files = {
        "a.py": "x = 1\n",
        "big.bin": "A" * 150_000,
        "b.py": "B" * 90_000,
        "c.py": "C" * 90_000,
        "d.py": "D" * 90_000,
        "e.py": "E" * 90_000,
    }
    client = FakeClient(Response([Text("## the patterns\n")], stop_reason="end_turn"))
    result = analyze(files, client, "model-y")

    ok(result == "## the patterns", "the markdown comes back stripped")
    call = client.messages.calls[0]
    ok(call["model"] == "model-y", "the caller's model is used")
    prompt = call["messages"][0]["content"]
    ok("--- a.py ---" in prompt and "x = 1" in prompt, "small files ride whole")
    ok("A" * 150_000 not in prompt, "an oversized file's content is skipped")
    ok("E" * 90_000 not in prompt, "the total cap holds")
    ok("Not shown" in prompt and "big.bin" in prompt and "e.py" in prompt, "skips are noted by name")


def test_analyze_without_skips_has_no_skip_note() -> None:
    print("test_analyze_without_skips_has_no_skip_note")
    client = FakeClient(Response([Text("patterns")], stop_reason="end_turn"))
    analyze({"a.py": "x = 1\n"}, client, "m")
    ok("Not shown" not in client.messages.calls[0]["messages"][0]["content"], "no skips, no note")


def test_golden_doc_pipeline_emission_stays_lawful() -> None:
    """The frozen live emission (2026-08-21, one attempt, executed end-to-end
    against real Claude) must clear every validator against the real example's
    documents and context — the contract's regression net, no network needed."""
    print("test_golden_doc_pipeline_emission_stays_lawful")
    repo = Path(__file__).resolve().parents[2]
    pipeline = repo / "examples" / "doc-pipeline"
    golden = Path(__file__).resolve().parent / "golden" / "doc-pipeline"

    documents = {
        str(p.relative_to(pipeline)): p.read_text()
        for pattern in ("*.yaml", "graphs/*.yaml", "agents/*/agent.yaml", "agents/*/prompt.md")
        for p in pipeline.glob(pattern)
    }
    context = {
        str(p.relative_to(pipeline)): p.read_text() for p in (pipeline / "src").rglob("*.py")
    }
    files = {
        str(p.relative_to(golden)): p.read_text()
        for p in golden.rglob("*.py")
    }

    ok(len(files) == 3, "the golden emission is three modules")
    issues = validate(files, documents, context)
    ok(issues == [], f"the golden emission clears every validator: {issues}")
    agent_file = files["agents/classifier/agent.py"]
    ok("from civil_runtime.engines import Engine" in agent_file, "the agent imports the facade")
    ok('Engine(model="claude-' in agent_file, "the engine literal carries a real model id")
    ok("anthropic" not in agent_file, "no vendor SDK in the golden agent")


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
