"""The lift's model pass, exercised without a network.

A fake client stands where Claude will stand, so what is tested is everything
deterministic around the model: the forced refine_skeleton call, the validators
that keep the model to renaming, classifying and describing, the retry loop's
feedback, the docs cap, and the /lift/refine route's wire shape (a real socket,
no model). The skeleton is synthetic — a small task tracker, nobody's code.
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

# server's import chain reaches PyYAML (execute), but nothing exercised here
# parses YAML — a stub keeps this suite runnable under plain python3.
sys.modules.setdefault("yaml", types.ModuleType("yaml"))

import refine as refine_module  # noqa: E402
from refine import (  # noqa: E402
    MAX_DOCS_CHARS,
    RefineValidationError,
    plain_text,
    refine,
    select_docs,
    validate,
)
from server import Handler  # noqa: E402

CHECKS = 0


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


class ToolUse:
    type = "tool_use"
    name = "refine_skeleton"

    def __init__(self, answer: object, id: str = "call_1") -> None:
        self.input = answer
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


def answer(**fields) -> Response:
    body = {"renames": {}, "infrastructure": [], "descriptions": {}, "summary": "A task tracker."}
    body.update(fields)
    return Response([ToolUse(body)])


SKELETON = {
    "clients": [{"id": "web", "path": "apps/web", "calls": ["server"]}],
    "servers": [{
        "id": "server",
        "path": "apps/server",
        "globalPrefix": "api",
        "routeCount": 3,
        "routes": ["GET /api/tasks", "POST /api/tasks", "GET /api/health"],
        "exposes": ["tsk", "health"],
    }],
    "services": [
        {"id": "tsk", "server": "server", "moduleClass": "TskModule", "dependsOn": ["db"], "agents": ["sum"]},
        {"id": "db", "server": "server", "moduleClass": "DbModule", "dependsOn": [], "agents": []},
        {"id": "health", "server": "server", "moduleClass": "HealthModule", "dependsOn": [], "agents": []},
    ],
    "agents": [{"id": "sum", "files": ["apps/server/src/tsk/sum.agent.ts"], "tools": []}],
    "processes": [{"id": "nightly", "schedule": "0 3 * * *", "calls": ["tsk"]}],
    "unresolved": 0,
    "frameworks": ["nestjs", "vite"],
}

DOCS = {"README.md": "# Tasks\n\nA small task tracker with a nightly summary.\n"}


def test_a_valid_answer_comes_back_normalized() -> None:
    print("test_a_valid_answer_comes_back_normalized")
    client = FakeClient(answer(
        renames={"tsk": "tasks", "sum": "summarizer", "web": "web"},
        infrastructure=["db", "health"],
        descriptions={"tasks": "Creates and lists tasks.", "summarizer": "Writes the nightly summary."},
        summary="A task tracker.\n\nThe server serves the web client.",
    ))
    result = refine(SKELETON, DOCS, client, "claude-test")
    call = client.messages.calls[0]
    ok(call["tool_choice"] == {"type": "tool", "name": "refine_skeleton"}, "the tool call is forced")
    ok(call["model"] == "claude-test", "the resolved model id is used")
    ok('"tsk"' in call["messages"][0]["content"], "the skeleton rides the prompt")
    ok("A small task tracker" in call["messages"][0]["content"], "the docs ride the prompt")
    ref = result["refinement"]
    ok(ref["renames"] == {"tsk": "tasks", "sum": "summarizer"}, "a no-op rename is dropped")
    ok(ref["infrastructure"] == ["db", "health"], "infrastructure names services")
    ok(ref["descriptions"]["tasks"] == "Creates and lists tasks.", "descriptions key by the new id")
    ok(result["attempts"] == 1 and result["docsCut"] == [], "one attempt, nothing cut")
    ok(result["promptVersion"] == refine_module.PROMPT_VERSION, "the prompt version rides back")


def test_double_encoded_fields_are_recovered() -> None:
    print("test_double_encoded_fields_are_recovered")
    client = FakeClient(Response([ToolUse({
        "renames": json.dumps({"tsk": "tasks"}) + "</invoke>",
        "infrastructure": json.dumps(["db"]),
        "descriptions": {},
        "summary": "A task tracker.",
    })]))
    result = refine(SKELETON, DOCS, client, "m")
    ok(result["refinement"]["renames"] == {"tsk": "tasks"}, "a JSON-string field decodes, scaffold dropped")
    ok(result["refinement"]["infrastructure"] == ["db"], "a JSON-string list decodes")
    ok(len(client.messages.calls) == 1, "no retry spent on a complete answer")


def test_a_json_encoded_summary_lands_as_prose() -> None:
    print("test_a_json_encoded_summary_lands_as_prose")
    encoded = json.dumps("A task tracker.\n\nThe server serves the web client.")
    client = FakeClient(answer(summary=encoded))
    result = refine(SKELETON, DOCS, client, "m")
    ok(result["refinement"]["summary"] == "A task tracker.\n\nThe server serves the web client.", "quotes and escapes decoded")
    ok(plain_text("One.\\n\\nTwo.") == "One.\n\nTwo.", "literal backslash-n becomes a line break")
    ok(plain_text('Says "hi".\nDone.') == 'Says "hi".\nDone.', "real prose is left as written")


def test_a_service_with_routes_or_agents_is_never_infrastructure() -> None:
    print("test_a_service_with_routes_or_agents_is_never_infrastructure")
    skeleton = json.loads(json.dumps(SKELETON))
    skeleton["services"][2]["routes"] = 1  # health serves a route now
    client = FakeClient(answer(infrastructure=["tsk", "db", "health"]))
    result = refine(skeleton, DOCS, client, "m")
    ok(result["refinement"]["infrastructure"] == ["db"], "tsk (agents) and health (routes) are dropped, db kept")
    ok(len(client.messages.calls) == 1, "dropped, not retried")


def test_an_invented_id_is_refused_and_retried() -> None:
    print("test_an_invented_id_is_refused_and_retried")
    client = FakeClient(
        answer(renames={"billing": "payments"}, descriptions={"queue": "Holds jobs."}),
        answer(renames={"tsk": "tasks"}),
    )
    result = refine(SKELETON, DOCS, client, "m")
    ok(result["attempts"] == 2, "the second answer is taken")
    feedback = client.messages.calls[1]["messages"][-1]["content"][0]
    ok(feedback["type"] == "tool_result" and feedback["is_error"], "issues go back as an error tool_result")
    ok("'billing' is not an entity" in feedback["content"], "an invented rename source is named")
    ok("'queue' is not an entity" in feedback["content"], "an invented description target is named")
    ok(result["refinement"]["renames"] == {"tsk": "tasks"}, "the corrected answer is the result")


def test_a_collision_is_refused() -> None:
    print("test_a_collision_is_refused")
    _, issues = validate(
        {"renames": {"tsk": "db"}, "infrastructure": [], "descriptions": {}, "summary": "s"}, SKELETON
    )
    ok(any("would both be called 'db'" in i for i in issues), "renaming onto a remaining id collides")
    _, issues = validate(
        {"renames": {"tsk": "core", "health": "core"}, "infrastructure": [], "descriptions": {}, "summary": "s"},
        SKELETON,
    )
    ok(any("would both be called 'core'" in i for i in issues), "two renames onto one id collide")
    _, issues = validate(
        {"renames": {"tsk": "db", "db": "storage"}, "infrastructure": [], "descriptions": {}, "summary": "s"},
        SKELETON,
    )
    ok(issues == [], "an id freed by another rename may be taken")


def test_ids_classes_and_sentences_are_checked() -> None:
    print("test_ids_classes_and_sentences_are_checked")
    _, issues = validate({
        "renames": {"tsk": "Tasks Module"},
        "infrastructure": ["web", "sum"],
        "descriptions": {
            "db": "One. Two. Three.",
            "health": "line one\nline two",
            "nightly": "",
        },
        "summary": "",
    }, SKELETON)
    text = "\n".join(issues)
    ok("'Tasks Module' is not a valid id" in text, "a new id must match Civil's id pattern")
    ok("'web' is not a service" in text and "'sum' is not a service" in text, "only services are infrastructure")
    ok("descriptions['db']: one or two sentences" in text, "three sentences are too many")
    ok("descriptions['health']: one or two sentences on one line" in text, "a paragraph is refused")
    ok("descriptions['nightly']: must be a non-empty sentence" in text, "an empty description is refused")
    ok("summary must be" in text, "an empty summary is refused")


def test_an_old_id_maps_to_its_rename() -> None:
    print("test_an_old_id_maps_to_its_rename")
    ref, issues = validate({
        "renames": {"db": "database"},
        "infrastructure": ["db"],
        "descriptions": {"db": "Holds the tasks."},
        "summary": "s",
    }, SKELETON)
    ok(issues == [], "an id the answer renamed away is unambiguous")
    ok(ref["infrastructure"] == ["database"] and "database" in ref["descriptions"], "and lands on the new id")


def test_retries_exhaust_into_the_error() -> None:
    print("test_retries_exhaust_into_the_error")
    bad = answer(renames={"ghost": "spirit"})
    client = FakeClient(bad, bad, bad)
    try:
        refine(SKELETON, DOCS, client, "m")
    except RefineValidationError as error:
        ok(error.attempts == 3 and any("ghost" in i for i in error.issues), "the issues reach the caller")
    else:
        raise AssertionError("expected RefineValidationError")


def test_a_missing_tool_call_is_a_model_failure() -> None:
    print("test_a_missing_tool_call_is_a_model_failure")

    class Text:
        type = "text"
        text = "I would rename things."

    try:
        refine(SKELETON, DOCS, FakeClient(Response([Text()])), "m")
    except ValueError as error:
        ok("no refine_skeleton call" in str(error), "said plainly, not retried")
    else:
        raise AssertionError("expected ValueError")


def test_docs_are_capped_and_the_cut_is_named() -> None:
    print("test_docs_are_capped_and_the_cut_is_named")
    docs = {
        "docs/a.md": "a" * (MAX_DOCS_CHARS - 100),
        "docs/b.md": "b" * 500,
        "README.md": "r" * 50,
    }
    included, cut = select_docs(docs)
    ok([p for p, _ in included] == ["README.md", "docs/a.md"], "README first, then path order")
    ok(cut == ["docs/b.md"], "a doc crossing the cap is cut whole")
    client = FakeClient(answer())
    result = refine(SKELETON, docs, client, "m")
    ok(result["docsCut"] == ["docs/b.md"], "the cut rides back for the API's note")
    ok("Not shown, for size: docs/b.md" in client.messages.calls[0]["messages"][0]["content"], "and the prompt says so")


def _post(port: int, path: str, payload: object) -> tuple[int, dict]:
    connection = HTTPConnection("127.0.0.1", port)
    connection.request("POST", path, body=json.dumps(payload), headers={"content-type": "application/json"})
    response = connection.getresponse()
    body = json.loads(response.read() or b"{}")
    connection.close()
    return response.status, body


def test_the_route_validates_its_body() -> None:
    """The wire shape over a real socket, no model: a malformed body is the
    caller's 400 before any model client is reached."""
    print("test_the_route_validates_its_body")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        port = server.server_address[1]
        status, body = _post(port, "/lift/refine", {"skeleton": "nope"})
        ok(status == 400 and "skeleton" in body["error"], "a non-object skeleton is a 400")
        status, body = _post(port, "/lift/refine", {"skeleton": {"services": {}}})
        ok(status == 400, "an entity field that is not a list is a 400")
        status, body = _post(port, "/lift/refine", {"skeleton": SKELETON, "docs": {"README.md": 3}})
        ok(status == 400 and "docs" in body["error"], "docs must be a string map")
    finally:
        server.shutdown()
        server.server_close()


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
