"""The graph-Run debugger's agent step, exercised without a network or a model.

run_agent instantiates its own anthropic client inside the call, so a fake
`anthropic` module stands in sys.modules where the SDK will stand: what is
tested is everything deterministic around the model — the prompt-from-file
convention and its default, the DEFAULT_MODEL / turn-budget defaults (agent.yaml
has dissolved, so there is no per-agent config source on this path), tool
discovery from source, boundary validation (strict refuses, lenient runs), the
tool round-trip and its events, and the error paths (no client, no key, budget).
"""

from __future__ import annotations

import os
import sys
import tempfile
import types
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime" / "src"))

from civil_runtime.runner import GraphError, ToolRef  # noqa: E402

from agent import (  # noqa: E402
    DEFAULT_MODEL,
    MAX_TOKENS,
    Tool,
    _conclude,
    _load_tools,
    _resolve_entrypoint,
    _validate,
    call_tool,
    run_agent,
)

CHECKS = 0

DUMMY_KEY = "sk-test-not-a-real-key"


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


def scratch_with(files: dict[str, str]) -> Path:
    root = Path(tempfile.mkdtemp(prefix="civil-agent-test-"))
    for path, content in files.items():
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return root


@dataclass
class FakeNode:
    id: str


# --- the fake model client ---------------------------------------------------


class TextBlock:
    type = "text"

    def __init__(self, text: str) -> None:
        self.text = text


class ToolUseBlock:
    type = "tool_use"

    def __init__(self, name: str, input: dict, id: str = "call_1") -> None:
        self.name = name
        self.input = input
        self.id = id


class Response:
    def __init__(self, content: list, stop_reason: str) -> None:
        self.content = content
        self.stop_reason = stop_reason


class FakeMessages:
    def __init__(self, responses: list[Response]) -> None:
        self.responses = list(responses)
        self.calls: list[dict] = []

    def create(self, **kwargs) -> Response:
        self.calls.append(kwargs)
        assert self.responses, "run_agent asked for more model turns than were queued"
        return self.responses.pop(0)


class FakeClient:
    def __init__(self, responses: list[Response]) -> None:
        self.messages = FakeMessages(responses)


def install_anthropic(*responses: Response) -> FakeClient:
    """Put a fake `anthropic` where run_agent's lazy import will find it, and
    make ANTHROPIC_API_KEY present so the guard passes. Returns the one client
    Anthropic() will hand back, so its recorded .messages.calls can be read."""
    client = FakeClient(list(responses))
    module = types.ModuleType("anthropic")
    module.NOT_GIVEN = object()
    module.Anthropic = lambda *a, **k: client
    sys.modules["anthropic"] = module
    os.environ["ANTHROPIC_API_KEY"] = DUMMY_KEY
    return client


def collector() -> tuple[list[dict], "object"]:
    events: list[dict] = []

    def report(event: dict) -> bool:
        events.append(event)
        return False

    return events, report


SEARCH = 'def search(query: str) -> list:\n    """Search things."""\n    return ["hit:" + query]\n'


# --- pure helpers ------------------------------------------------------------


def test_resolve_entrypoint_passthrough_and_glob() -> None:
    print("test_resolve_entrypoint_passthrough_and_glob")
    scratch = scratch_with({"tools/search.py": SEARCH, "tools/notes.txt": "x\n"})
    ok(_resolve_entrypoint(scratch, "tools/search.py") == "tools/search.py", "a plain ref passes through")
    ok(_resolve_entrypoint(scratch, "tools/*.py") == "tools/search.py", "a glob resolves to the .py file")
    try:
        _resolve_entrypoint(scratch, "nope/*.py")
        ok(False, "an unmatched glob raises")
    except GraphError as error:
        ok("no Python file matches" in str(error), "an unmatched glob is a GraphError")


def test_load_tools_reads_the_contract_from_source() -> None:
    print("test_load_tools_reads_the_contract_from_source")
    scratch = scratch_with({"tools/search.py": SEARCH})
    tools = _load_tools(scratch, [ToolRef(node_id="tools", entrypoint="tools/search.py", function="search")])
    ok(len(tools) == 1, "one ref yields one tool")
    tool = tools[0]
    ok(tool.name == "search", "the name is discovered from the source")
    ok(tool.description == "Search things.", "the description is the docstring's first line")
    ok(
        tool.input_schema == {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        "parameters become the input_schema's properties (PRD 7.2, no second declaration)",
    )
    ok(tool.entrypoint == "tools/search.py" and tool.function == "search", "the entrypoint and function are carried")


def test_load_tools_defaults_description_when_undocumented() -> None:
    print("test_load_tools_defaults_description_when_undocumented")
    scratch = scratch_with({"tools/plain.py": "def act(x: int) -> int:\n    return x\n"})
    tools = _load_tools(scratch, [ToolRef(node_id="t", entrypoint="tools/plain.py", function="act")])
    ok(tools[0].description == "tools/plain.py:act", "an undocumented tool falls back to entrypoint:name")


def test_validate_matches_the_contract() -> None:
    print("test_validate_matches_the_contract")
    tool = Tool(
        name="search",
        description="d",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        entrypoint="tools/search.py",
        function="search",
    )
    ok(_validate(tool, {"query": "x"}, "strict") is None, "a lawful call has no complaint")
    ok("missing query" in (_validate(tool, {}, "strict") or ""), "a missing required arg is named")
    ok("unexpected extra" in (_validate(tool, {"query": "x", "extra": 1}, "strict") or ""), "an unknown arg is named")
    ok("must be an object" in (_validate(tool, "notadict", "strict") or ""), "a non-object call is caught")


def test_conclude_prefers_json_then_braces_then_text() -> None:
    print("test_conclude_prefers_json_then_braces_then_text")
    ok(_conclude('{"category": "invoice"}') == {"category": "invoice"}, "whole-text JSON parses to data")
    ok(_conclude('here it is: {"a": 1} thanks') == {"a": 1}, "the outermost braced span is salvaged")
    ok(_conclude("just words") == "just words", "un-JSON text comes back as text")


def test_call_tool_runs_sync_and_async() -> None:
    print("test_call_tool_runs_sync_and_async")
    ok(call_tool(lambda **k: k["a"] + k["b"], {"a": 1, "b": 2}) == 3, "a sync tool is called by keyword")

    async def doubler(x: int) -> int:
        return x * 2

    ok(call_tool(doubler, {"x": 21}) == 42, "an async tool is awaited")


# --- run_agent: prompt and defaults ------------------------------------------


def test_run_agent_loads_prompt_from_file() -> None:
    print("test_run_agent_loads_prompt_from_file")
    scratch = scratch_with({"prompts/classify.md": "You classify documents.\n"})
    client = install_anthropic(Response([TextBlock('{"category": "invoice"}')], "end_turn"))
    events, report = collector()
    result = run_agent(
        scratch=scratch,
        node=FakeNode("classify"),
        value={"text": "hello"},
        tools=[],
        tool_validation="strict",
        report=report,
    )
    call = client.messages.calls[0]
    ok(call["system"] == "You classify documents.\n", "the system prompt is loaded from prompts/<node-id>.md")
    ok(call["model"] == DEFAULT_MODEL, "the model defaults to DEFAULT_MODEL (no per-agent config here)")
    ok(call["max_tokens"] == MAX_TOKENS, "max_tokens is MAX_TOKENS")
    ok(call["messages"][0]["content"] == '{"text": "hello"}', "a non-string input is JSON-serialised into the first message")
    ok(result == {"category": "invoice"}, "a JSON conclusion is returned as data")


def test_run_agent_falls_back_to_default_prompt() -> None:
    print("test_run_agent_falls_back_to_default_prompt")
    scratch = scratch_with({})  # no prompts/ dir at all
    client = install_anthropic(Response([TextBlock("done")], "end_turn"))
    events, report = collector()
    run_agent(
        scratch=scratch,
        node=FakeNode("classify"),
        value="raw text",
        tools=[],
        tool_validation="strict",
        report=report,
    )
    call = client.messages.calls[0]
    ok(call["system"] == "You are a step in a dataflow graph.", "an absent prompt file falls back to the default string")
    ok(call["messages"][0]["content"] == "raw text", "a string input rides verbatim as the first message")


def test_run_agent_passes_discovered_tools_to_the_model() -> None:
    print("test_run_agent_passes_discovered_tools_to_the_model")
    scratch = scratch_with({"tools/search.py": SEARCH})
    client = install_anthropic(Response([TextBlock("done")], "end_turn"))
    events, report = collector()
    run_agent(
        scratch=scratch,
        node=FakeNode("classify"),
        value="q",
        tools=[ToolRef(node_id="tools", entrypoint="tools/search.py", function="search")],
        tool_validation="strict",
        report=report,
    )
    tools = client.messages.calls[0]["tools"]
    ok(
        tools == [{
            "name": "search",
            "description": "Search things.",
            "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        }],
        "the discovered tool is offered to the model with its schema",
    )


# --- run_agent: the tool round-trip ------------------------------------------


def test_run_agent_runs_a_tool_and_flows_its_result() -> None:
    print("test_run_agent_runs_a_tool_and_flows_its_result")
    scratch = scratch_with({"tools/search.py": SEARCH})
    client = install_anthropic(
        Response([ToolUseBlock("search", {"query": "foo"})], "tool_use"),
        Response([TextBlock("all done")], "end_turn"),
    )
    events, report = collector()
    result = run_agent(
        scratch=scratch,
        node=FakeNode("classify"),
        value="start",
        tools=[ToolRef(node_id="tools", entrypoint="tools/search.py", function="search")],
        tool_validation="strict",
        report=report,
    )
    ok(result == "all done", "the second turn's text is the conclusion")

    calls = [e for e in events if e["type"] == "node.tool_call"]
    ok(len(calls) == 1 and calls[0]["payload"] == {"tool": "search", "input": {"query": "foo"}}, "the tool call is reported")
    outputs = [e for e in events if e["type"] == "node.tool_result" and "output" in e["payload"]]
    ok(len(outputs) == 1 and outputs[0]["payload"]["output"] == ["hit:foo"], "the tool actually ran and its output is reported")

    # the second model turn must carry the tool_result back
    follow_up = client.messages.calls[1]["messages"][-1]
    ok(follow_up["role"] == "user", "the tool result is fed back as a user turn")
    tr = follow_up["content"][0]
    ok(tr["type"] == "tool_result" and tr["tool_use_id"] == "call_1", "the result answers the tool call by id")
    ok('["hit:foo"]' in tr["content"] and not tr.get("is_error"), "the tool's JSON output rides back, not an error")


def test_run_agent_strict_refuses_a_malformed_call() -> None:
    print("test_run_agent_strict_refuses_a_malformed_call")
    scratch = scratch_with({"tools/search.py": SEARCH})
    client = install_anthropic(
        Response([ToolUseBlock("search", {})], "tool_use"),  # missing required 'query'
        Response([TextBlock("done")], "end_turn"),
    )
    events, report = collector()
    run_agent(
        scratch=scratch,
        node=FakeNode("classify"),
        value="start",
        tools=[ToolRef(node_id="tools", entrypoint="tools/search.py", function="search")],
        tool_validation="strict",
        report=report,
    )
    results = [e for e in events if e["type"] == "node.tool_result"]
    ok(len(results) == 1 and "error" in results[0]["payload"], "strict reports the mismatch, not an output")
    ok("does not match its contract" in results[0]["payload"]["error"], "the complaint is the contract mismatch")
    ok(not any("output" in e.get("payload", {}) for e in results), "the tool code never ran under strict")
    tr = client.messages.calls[1]["messages"][-1]["content"][0]
    ok(tr["is_error"] and "missing query" in tr["content"], "the model is shown exactly what it got wrong")


def test_run_agent_lenient_runs_despite_the_complaint() -> None:
    print("test_run_agent_lenient_runs_despite_the_complaint")
    scratch = scratch_with({"tools/search.py": SEARCH})
    client = install_anthropic(
        Response([ToolUseBlock("search", {})], "tool_use"),  # still missing 'query'
        Response([TextBlock("done")], "end_turn"),
    )
    events, report = collector()
    run_agent(
        scratch=scratch,
        node=FakeNode("classify"),
        value="start",
        tools=[ToolRef(node_id="tools", entrypoint="tools/search.py", function="search")],
        tool_validation="lenient",
        report=report,
    )
    results = [e for e in events if e["type"] == "node.tool_result"]
    ok(len(results) == 1 and "error" in results[0]["payload"], "lenient still surfaces a failure")
    # lenient lets the code run, so the failure is the call-time TypeError, not the contract complaint
    ok(
        "positional argument" in results[0]["payload"]["error"],
        "lenient ran the tool (the error is the call-time TypeError, not the contract complaint)",
    )


def test_run_agent_reports_an_unknown_tool() -> None:
    print("test_run_agent_reports_an_unknown_tool")
    scratch = scratch_with({})
    client = install_anthropic(
        Response([ToolUseBlock("ghost", {"x": 1})], "tool_use"),
        Response([TextBlock("done")], "end_turn"),
    )
    events, report = collector()
    run_agent(
        scratch=scratch,
        node=FakeNode("classify"),
        value="start",
        tools=[],
        tool_validation="strict",
        report=report,
    )
    ok(any(e["type"] == "node.tool_call" for e in events), "the attempted call is still reported")
    tr = client.messages.calls[1]["messages"][-1]["content"][0]
    ok(tr["is_error"] and "unknown tool ghost" in tr["content"], "an unknown tool is an error result, not a crash")


def test_run_agent_reports_a_tool_that_raises() -> None:
    print("test_run_agent_reports_a_tool_that_raises")
    scratch = scratch_with({"tools/boom.py": "def boom(x: int) -> int:\n    raise ValueError('kaboom')\n"})
    client = install_anthropic(
        Response([ToolUseBlock("boom", {"x": 1})], "tool_use"),
        Response([TextBlock("done")], "end_turn"),
    )
    events, report = collector()
    run_agent(
        scratch=scratch,
        node=FakeNode("classify"),
        value="start",
        tools=[ToolRef(node_id="boom", entrypoint="tools/boom.py", function="boom")],
        tool_validation="strict",
        report=report,
    )
    errors = [e for e in events if e["type"] == "node.tool_result" and "error" in e["payload"]]
    ok(len(errors) == 1 and "kaboom" in errors[0]["payload"]["error"], "the tool's exception is reported, not raised")
    tr = client.messages.calls[1]["messages"][-1]["content"][0]
    ok(tr["is_error"] and "kaboom" in tr["content"], "the failure is fed back to the model")


# --- run_agent: error paths --------------------------------------------------


def test_run_agent_hits_the_turn_budget() -> None:
    print("test_run_agent_hits_the_turn_budget")
    scratch = scratch_with({})
    # eight tool_use turns that never conclude: the loop must stop at max_turns (8)
    client = install_anthropic(*[Response([ToolUseBlock("ghost", {})], "tool_use") for _ in range(8)])
    events, report = collector()
    try:
        run_agent(
            scratch=scratch,
            node=FakeNode("classify"),
            value="start",
            tools=[],
            tool_validation="strict",
            report=report,
        )
        ok(False, "an agent that never concludes raises")
    except GraphError as error:
        ok("turn budget" in str(error) and "(8)" in str(error), "the turn budget of 8 is enforced and named")
    ok(len(client.messages.calls) == 8, "exactly eight model turns were spent (max_turns defaults to 8)")


def test_run_agent_requires_the_api_key() -> None:
    print("test_run_agent_requires_the_api_key")
    scratch = scratch_with({})
    install_anthropic(Response([TextBlock("done")], "end_turn"))  # client importable
    os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        run_agent(
            scratch=scratch,
            node=FakeNode("classify"),
            value="start",
            tools=[],
            tool_validation="strict",
            report=lambda e: False,
        )
        ok(False, "a missing key raises")
    except GraphError as error:
        ok("ANTHROPIC_API_KEY" in str(error), "a missing key is a GraphError naming ANTHROPIC_API_KEY")


def test_run_agent_requires_a_model_client() -> None:
    print("test_run_agent_requires_a_model_client")
    scratch = scratch_with({})
    sys.modules["anthropic"] = None  # makes `import anthropic` raise ImportError
    os.environ["ANTHROPIC_API_KEY"] = DUMMY_KEY
    try:
        run_agent(
            scratch=scratch,
            node=FakeNode("classify"),
            value="start",
            tools=[],
            tool_validation="strict",
            report=lambda e: False,
        )
        ok(False, "an absent client raises")
    except GraphError as error:
        ok("model client" in str(error), "an absent anthropic install is a GraphError")
    finally:
        sys.modules.pop("anthropic", None)


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
