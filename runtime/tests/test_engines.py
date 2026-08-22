"""The Engine facade, exercised without a network or a vendor SDK.

The Claude adapter runs against a scripted client, so the tool loop — request,
tool_use, result, conclusion — is covered with a fake standing where the
Anthropic SDK will stand.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from civil_runtime.engines import Engine, Reply, _ClaudeAdapter  # noqa: E402

CHECKS = 0


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


class Block:
    def __init__(self, type: str, **fields) -> None:
        self.type = type
        self.__dict__.update(fields)


class Response:
    def __init__(self, stop_reason: str, content: list) -> None:
        self.stop_reason = stop_reason
        self.content = content


class ScriptedClient:
    """Stands where anthropic.Anthropic stands: answers from a script,
    remembers every request."""

    def __init__(self, responses: list) -> None:
        self.responses = list(responses)
        self.requests: list[dict] = []
        self.messages = self  # client.messages.create resolves here

    def create(self, **kwargs) -> Response:
        self.requests.append(kwargs)
        return self.responses.pop(0)


class RecordingAdapter:
    """Stands where a vendor adapter stands: remembers what Engine passed."""

    def __init__(self, text: str = "done") -> None:
        self.calls: list[dict] = []
        self.text = text

    def run(self, **kwargs) -> str:
        self.calls.append(kwargs)
        return self.text


def search(query: str, limit: int = 5) -> list:
    """Find documents matching a query."""
    return [f"doc for {query}"][:limit]


def test_reply_json_parses_clean_and_wrapped() -> None:
    print("test_reply_json_parses_clean_and_wrapped")
    ok(Reply('{"category": "invoice"}').json() == {"category": "invoice"}, "clean JSON parses")
    wrapped = Reply('Here is my answer:\n{"category": "invoice"}\nHope that helps.')
    ok(wrapped.json() == {"category": "invoice"}, "prose-wrapped JSON parses")
    try:
        Reply("no data here, just words").json()
        ok(False, "prose without JSON raises")
    except ValueError as error:
        ok("JSON" in str(error), "prose without JSON raises and says so")


def test_tool_schemas_come_from_signatures() -> None:
    print("test_tool_schemas_come_from_signatures")
    client = ScriptedClient([Response("end_turn", [Block("text", text="ok")])])
    engine = Engine(_adapter=_ClaudeAdapter(client=client))
    engine.run(system="s", user="u", tools=[search])

    tools = client.requests[0]["tools"]
    ok(len(tools) == 1 and tools[0]["name"] == "search", "the tool is declared by name")
    ok(tools[0]["description"] == "Find documents matching a query.", "docstring is the description")
    schema = tools[0]["input_schema"]
    ok(schema["type"] == "object", "params become a top-level object schema")
    ok(schema["properties"]["query"] == {"type": "string"}, "annotations map to JSON Schema")
    ok(schema["properties"]["limit"] == {"type": "integer"}, "defaulted params keep their type")
    ok(schema["required"] == ["query"], "required is exactly the params without defaults")


def test_no_tools_means_no_tools_parameter() -> None:
    print("test_no_tools_means_no_tools_parameter")
    client = ScriptedClient([Response("end_turn", [Block("text", text="ok")])])
    Engine(_adapter=_ClaudeAdapter(client=client)).run(system="s", user="u")
    ok("tools" not in client.requests[0], "a tool-less run sends no tools parameter")


def test_the_tool_loop_calls_and_concludes() -> None:
    print("test_the_tool_loop_calls_and_concludes")
    client = ScriptedClient([
        Response("tool_use", [
            Block("text", text="Let me look."),
            Block("tool_use", id="t1", name="search", input={"query": "invoices"}),
        ]),
        Response("end_turn", [
            Block("text", text='{"category": '),
            Block("text", text='"invoice"}'),
        ]),
    ])
    reply = Engine(_adapter=_ClaudeAdapter(client=client)).run(
        system="classify", user="the document", tools=[search],
    )

    ok(reply.text == '{"category": "invoice"}', "final text blocks concatenate")
    ok(reply.json() == {"category": "invoice"}, "the conclusion parses")
    second = client.requests[1]["messages"]
    ok(second[1]["role"] == "assistant", "the tool_use turn went back verbatim")
    result = second[2]["content"][0]
    ok(result["type"] == "tool_result" and result["tool_use_id"] == "t1", "the result answers the call")
    ok("doc for invoices" in result["content"], "the tool actually ran with the model's args")


def test_a_failing_tool_reports_as_an_error_result() -> None:
    print("test_a_failing_tool_reports_as_an_error_result")

    def explode(query: str) -> str:
        raise ValueError("index offline")

    client = ScriptedClient([
        Response("tool_use", [Block("tool_use", id="t1", name="explode", input={"query": "x"})]),
        Response("end_turn", [Block("text", text="could not search")]),
    ])
    reply = Engine(_adapter=_ClaudeAdapter(client=client)).run(system="s", user="u", tools=[explode])
    result = client.requests[1]["messages"][2]["content"][0]
    ok(result["is_error"] and "index offline" in result["content"], "the model sees the failure")
    ok(reply.text == "could not search", "the run still concludes")


def test_the_turn_budget_caps_the_loop() -> None:
    print("test_the_turn_budget_caps_the_loop")
    spin = Response("tool_use", [Block("tool_use", id="t1", name="search", input={"query": "x"})])
    client = ScriptedClient([spin, spin, spin])
    try:
        Engine(_adapter=_ClaudeAdapter(client=client)).run(
            system="s", user="u", tools=[search], max_turns=3,
        )
        ok(False, "an unconcluded run raises")
    except RuntimeError as error:
        ok("3" in str(error), "the budget is named in the failure")
    ok(len(client.requests) == 3, "exactly max_turns requests were made")


def test_unknown_kind_names_the_known_kinds() -> None:
    print("test_unknown_kind_names_the_known_kinds")
    try:
        Engine("gpt")
        ok(False, "unknown kind raises")
    except ValueError as error:
        ok("gpt" in str(error) and "claude" in str(error), "the error names the kind and the known kinds")


def test_model_resolution_order() -> None:
    print("test_model_resolution_order")
    had = os.environ.pop("CIVIL_DEFAULT_MODEL", None)
    try:
        adapter = RecordingAdapter()
        Engine(_adapter=adapter).run(system="s", user="u")
        ok(adapter.calls[0]["model"] == "claude-sonnet-5", "no model, no env: the build-time fallback")

        os.environ["CIVIL_DEFAULT_MODEL"] = "claude-haiku-4"
        adapter = RecordingAdapter()
        Engine(_adapter=adapter).run(system="s", user="u")
        ok(adapter.calls[0]["model"] == "claude-haiku-4", "the environment beats the fallback")

        adapter = RecordingAdapter()
        Engine(model="claude-opus-5", _adapter=adapter).run(system="s", user="u")
        ok(adapter.calls[0]["model"] == "claude-opus-5", "an explicit model beats the environment")
    finally:
        if had is None:
            os.environ.pop("CIVIL_DEFAULT_MODEL", None)
        else:
            os.environ["CIVIL_DEFAULT_MODEL"] = had


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
