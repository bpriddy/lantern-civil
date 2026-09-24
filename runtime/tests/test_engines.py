"""The Engine facade, exercised without a network or a vendor SDK.

Each adapter runs against a scripted client, so the tool loop — request,
tool call, result, conclusion — is covered with a fake standing where the
vendor SDK will stand: the Anthropic SDK for the Claude adapter, the OpenAI
SDK for the OpenAI-compatible adapter that serves openai/ollama/vllm.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from civil_runtime.engines import (  # noqa: E402
    Engine,
    Reply,
    _ClaudeAdapter,
    _OpenAIAdapter,
)

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


class OAIMessage:
    def __init__(self, content=None, tool_calls=None) -> None:
        self.content = content
        self.tool_calls = tool_calls


class OAIResponse:
    """The choices[0].message shape the OpenAI SDK returns."""

    def __init__(self, message: OAIMessage, finish_reason: str) -> None:
        self.choices = [Block("choice", message=message, finish_reason=finish_reason)]


def tool_call(id: str, name: str, arguments: str) -> Block:
    """One OpenAI tool_call: id, and a function carrying a JSON-string args."""
    return Block("tool_call", id=id, function=Block("function", name=name, arguments=arguments))


class ScriptedOpenAIClient:
    """Stands where openai.OpenAI stands: answers chat.completions.create
    from a script, remembers every request."""

    def __init__(self, responses: list) -> None:
        self.responses = list(responses)
        self.requests: list[dict] = []
        self.chat = self  # client.chat.completions.create resolves here
        self.completions = self

    def create(self, **kwargs) -> OAIResponse:
        self.requests.append(kwargs)
        return self.responses.pop(0)


class FakeOpenAIModule:
    """Stands where the openai module stands, to capture OpenAI(**kwargs)."""

    def __init__(self) -> None:
        self.captured: dict | None = None

    def OpenAI(self, **kwargs):
        self.captured = kwargs
        return object()


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


def test_openai_kind_selects_the_openai_adapter() -> None:
    print("test_openai_kind_selects_the_openai_adapter")
    ok(isinstance(Engine()._adapter, _ClaudeAdapter), "absent key stays Claude")
    for kind in ("openai", "ollama", "vllm"):
        adapter = Engine(kind, model="m")._adapter
        ok(
            isinstance(adapter, _OpenAIAdapter) and adapter._kind == kind,
            f"{kind!r} maps to the OpenAI adapter carrying its kind",
        )


def test_a_non_claude_kind_requires_an_explicit_model() -> None:
    print("test_a_non_claude_kind_requires_an_explicit_model")
    had = os.environ.pop("CIVIL_DEFAULT_MODEL", None)
    try:
        # The Claude fallback id is meaningless to another vendor, so a non-claude
        # kind with no model is refused rather than sent that id blindly.
        for kind in ("openai", "ollama", "vllm"):
            try:
                Engine(kind)
                ok(False, f"{kind!r} without a model raises")
            except ValueError as error:
                ok(kind in str(error), f"{kind!r} says it needs a model")
        ok(Engine("claude")._model == "claude-sonnet-5", "claude keeps its build-time fallback")
        os.environ["CIVIL_DEFAULT_MODEL"] = "llama3"
        ok(Engine("ollama")._model == "llama3", "a set CIVIL_DEFAULT_MODEL serves a non-claude kind")
    finally:
        if had is None:
            os.environ.pop("CIVIL_DEFAULT_MODEL", None)
        else:
            os.environ["CIVIL_DEFAULT_MODEL"] = had


def test_each_kind_reads_its_own_api_key() -> None:
    print("test_each_kind_reads_its_own_api_key")
    saved = {k: os.environ.pop(k, None) for k in
             ("OPENAI_API_KEY", "OLLAMA_API_KEY", "VLLM_API_KEY", "OLLAMA_BASE_URL")}
    try:
        # A real hosted key in the environment must NOT be sent to a local server.
        os.environ["OPENAI_API_KEY"] = "sk-real"
        fake = FakeOpenAIModule()
        _OpenAIAdapter(kind="ollama")._make_client(fake)
        ok(fake.captured["api_key"] == "civil-local-unused", "ollama does not borrow OPENAI_API_KEY")
        os.environ["OLLAMA_API_KEY"] = "ollama-key"
        fake = FakeOpenAIModule()
        _OpenAIAdapter(kind="ollama")._make_client(fake)
        ok(fake.captured["api_key"] == "ollama-key", "ollama reads its own OLLAMA_API_KEY")
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_openai_uses_completion_tokens_oss_uses_max_tokens() -> None:
    print("test_openai_uses_completion_tokens_oss_uses_max_tokens")
    client = ScriptedOpenAIClient([OAIResponse(OAIMessage(content="ok"), "stop")])
    Engine("openai", model="gpt-x", _adapter=_OpenAIAdapter("openai", client=client)).run(
        system="s", user="u",
    )
    ok("max_completion_tokens" in client.requests[0] and "max_tokens" not in client.requests[0],
       "openai sends max_completion_tokens")
    client = ScriptedOpenAIClient([OAIResponse(OAIMessage(content="ok"), "stop")])
    Engine("ollama", model="llama3", _adapter=_OpenAIAdapter("ollama", client=client)).run(
        system="s", user="u",
    )
    ok("max_tokens" in client.requests[0] and "max_completion_tokens" not in client.requests[0],
       "the OSS servers send max_tokens")


def test_openai_tool_only_turn_echoes_empty_content() -> None:
    print("test_openai_tool_only_turn_echoes_empty_content")
    client = ScriptedOpenAIClient([
        OAIResponse(OAIMessage(tool_calls=[tool_call("t1", "search", '{"query": "x"}')]), "tool_calls"),
        OAIResponse(OAIMessage(content="done"), "stop"),
    ])
    Engine(_adapter=_OpenAIAdapter(client=client)).run(system="s", user="u", tools=[search])
    assistant = client.requests[1]["messages"][2]
    ok(assistant["content"] == "", "a tool-only assistant turn echoes '' not None")


def test_openai_tool_schemas_come_from_signatures() -> None:
    print("test_openai_tool_schemas_come_from_signatures")
    client = ScriptedOpenAIClient([OAIResponse(OAIMessage(content="ok"), "stop")])
    Engine(_adapter=_OpenAIAdapter(client=client)).run(system="s", user="u", tools=[search])

    tools = client.requests[0]["tools"]
    ok(len(tools) == 1 and tools[0]["type"] == "function", "the tool is a function envelope")
    fn = tools[0]["function"]
    ok(fn["name"] == "search", "the tool is declared by name")
    ok(fn["description"] == "Find documents matching a query.", "docstring is the description")
    schema = fn["parameters"]
    ok(schema["properties"]["query"] == {"type": "string"}, "annotations map to JSON Schema")
    ok(schema["required"] == ["query"], "required is exactly the params without defaults")


def test_openai_no_tools_sends_system_as_first_message() -> None:
    print("test_openai_no_tools_sends_system_as_first_message")
    client = ScriptedOpenAIClient([OAIResponse(OAIMessage(content="ok"), "stop")])
    Engine(_adapter=_OpenAIAdapter(client=client)).run(system="the system", user="u")
    request = client.requests[0]
    ok("tools" not in request, "a tool-less run sends no tools parameter")
    first = request["messages"][0]
    ok(first["role"] == "system" and first["content"] == "the system", "system is the first message")
    ok(request["messages"][1]["role"] == "user", "user content follows the system message")


def test_openai_tool_loop_calls_and_concludes() -> None:
    print("test_openai_tool_loop_calls_and_concludes")
    client = ScriptedOpenAIClient([
        OAIResponse(
            OAIMessage(
                content="Let me look.",
                tool_calls=[tool_call("t1", "search", '{"query": "invoices"}')],
            ),
            "tool_calls",
        ),
        OAIResponse(OAIMessage(content='{"category": "invoice"}'), "stop"),
    ])
    reply = Engine(_adapter=_OpenAIAdapter(client=client)).run(
        system="classify", user="the document", tools=[search],
    )

    ok(reply.text == '{"category": "invoice"}', "final content is the conclusion")
    ok(reply.json() == {"category": "invoice"}, "the conclusion parses")
    second = client.requests[1]["messages"]
    ok(second[2]["role"] == "assistant", "the tool-call turn went back")
    ok(second[2]["tool_calls"][0]["function"]["name"] == "search", "the assistant turn names the call")
    result = second[3]
    ok(result["role"] == "tool" and result["tool_call_id"] == "t1", "the result answers the call")
    ok("doc for invoices" in result["content"], "the tool actually ran with the model's args")


def test_openai_a_failing_tool_reports_the_error() -> None:
    print("test_openai_a_failing_tool_reports_the_error")

    def explode(query: str) -> str:
        raise ValueError("index offline")

    client = ScriptedOpenAIClient([
        OAIResponse(
            OAIMessage(tool_calls=[tool_call("t1", "explode", '{"query": "x"}')]),
            "tool_calls",
        ),
        OAIResponse(OAIMessage(content="could not search"), "stop"),
    ])
    reply = Engine(_adapter=_OpenAIAdapter(client=client)).run(system="s", user="u", tools=[explode])
    result = client.requests[1]["messages"][3]
    ok(result["role"] == "tool" and "index offline" in result["content"], "the model sees the failure")
    ok(reply.text == "could not search", "the run still concludes")


def test_openai_the_turn_budget_caps_the_loop() -> None:
    print("test_openai_the_turn_budget_caps_the_loop")
    spin = OAIResponse(
        OAIMessage(tool_calls=[tool_call("t1", "search", '{"query": "x"}')]),
        "tool_calls",
    )
    client = ScriptedOpenAIClient([spin, spin, spin])
    try:
        Engine(_adapter=_OpenAIAdapter(client=client)).run(
            system="s", user="u", tools=[search], max_turns=3,
        )
        ok(False, "an unconcluded run raises")
    except RuntimeError as error:
        ok("3" in str(error), "the budget is named in the failure")
    ok(len(client.requests) == 3, "exactly max_turns requests were made")


def test_openai_client_reads_endpoint_and_key_from_env() -> None:
    print("test_openai_client_reads_endpoint_and_key_from_env")
    saved = {k: os.environ.pop(k, None) for k in
             ("OPENAI_API_KEY", "OPENAI_BASE_URL", "OLLAMA_BASE_URL", "VLLM_BASE_URL")}
    try:
        # A local kind with no env: conventional localhost default + throwaway key.
        fake = FakeOpenAIModule()
        _OpenAIAdapter(kind="ollama")._make_client(fake)
        ok(fake.captured["base_url"] == "http://localhost:11434/v1", "ollama defaults to its localhost endpoint")
        ok(fake.captured["api_key"] == "civil-local-unused", "a local server gets a throwaway key")

        # The kind-named variable overrides the default.
        os.environ["OLLAMA_BASE_URL"] = "http://box:1234/v1"
        fake = FakeOpenAIModule()
        _OpenAIAdapter(kind="ollama")._make_client(fake)
        ok(fake.captured["base_url"] == "http://box:1234/v1", "OLLAMA_BASE_URL overrides the default")

        # A hosted kind with no env: nothing hardcoded, both left to the SDK.
        fake = FakeOpenAIModule()
        _OpenAIAdapter(kind="openai")._make_client(fake)
        ok("base_url" not in fake.captured, "openai passes no base_url, letting the SDK read the env")
        ok("api_key" not in fake.captured, "openai passes no key, letting the SDK read the env")

        # OPENAI_* honored for a hosted kind.
        os.environ["OPENAI_API_KEY"] = "sk-test"
        os.environ["OPENAI_BASE_URL"] = "https://proxy/v1"
        fake = FakeOpenAIModule()
        _OpenAIAdapter(kind="openai")._make_client(fake)
        ok(fake.captured["api_key"] == "sk-test", "OPENAI_API_KEY is passed through")
        ok(fake.captured["base_url"] == "https://proxy/v1", "OPENAI_BASE_URL is passed through")
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
