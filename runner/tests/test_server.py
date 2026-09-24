"""The runner's HTTP dispatch, exercised over a real socket with no model.

The server is started on port 0 and driven with real requests, exactly as
session/tests/test_session.py drives its service. The failure-domain
collaborators — the analyzer, the transpiler, the lifter, and bundle execution —
are replaced with stubs, so what is tested is the routing itself: each verb and
path reaching the right handler, the wire shape it answers, the 400s for bad
input, the 404 for an unknown route, and the 502 when model access is absent. No
real model is called, no code is executed, nothing is spawned.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import types
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime" / "src"))

# server's import chain reaches PyYAML (execute); nothing here parses YAML, so a
# stub keeps the suite runnable under plain python3, as the sibling suites do.
sys.modules.setdefault("yaml", types.ModuleType("yaml"))

import server  # noqa: E402

server.Handler.log_message = lambda *args: None  # keep the check output readable

CHECKS = 0

# Every collaborator that would reach a model, run code, or spawn is stubbed and
# records what the handler forwarded, so a route can be checked by its effects.
RECORD: dict = {}
SENTINEL_CLIENT = object()


def fake_execute_bundle(bundle: object) -> None:
    RECORD["execute"] = bundle


def fake_analyze(files: dict, client: object, model: str) -> str:
    RECORD["analyze"] = {"files": files, "client": client, "model": model}
    return "## canned patterns"


def fake_transpile(documents: dict, patterns, context: dict, client: object, model: str) -> dict:
    RECORD["transpile"] = {
        "documents": documents,
        "patterns": patterns,
        "context": context,
        "client": client,
        "model": model,
    }
    return {"files": {"src/x.py": "y\n"}, "roles": {"src/x.py": "other"}, "attempts": 1}


def fake_lift_graph(graph_path: str, graph_doc: str, orchestration: str) -> dict:
    RECORD["lift"] = {"graphPath": graph_path, "graphDoc": graph_doc, "orchestration": orchestration}
    return {"unliftable": False, "edges": []}


server.execute_bundle = fake_execute_bundle
server.analyze = fake_analyze
server.transpile = fake_transpile
server.lift_graph = fake_lift_graph

# The real _model_client is the one seam that would need a key; hand the handlers
# a sentinel instead, and keep the real one to exercise its 502 guard directly.
ORIGINAL_MODEL_CLIENT = server.Handler._model_client
server.Handler._model_client = lambda self: SENTINEL_CLIENT

HTTPD = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
PORT = HTTPD.server_address[1]
threading.Thread(target=HTTPD.serve_forever, daemon=True).start()


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


def request(method: str, path: str, body: object = None, raw: bytes | None = None):
    conn = HTTPConnection("127.0.0.1", PORT, timeout=10)
    payload = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    conn.request(method, path, payload)
    response = conn.getresponse()
    data = response.read()
    conn.close()
    return response.status, (json.loads(data) if data else {})


EXECUTE_BUNDLE = {"sessionId": "s1", "files": {"a.py": "x = 1\n"}, "processes": []}
ANALYZE_BODY = {"files": {"a.py": "x = 1\n"}}
TRANSPILE_BODY = {
    "documents": {"civil/graphs/x.yaml": "spec: {}\n"},
    "patterns": "## repo patterns",
    "context": {"src/t.py": "t\n"},
}
LIFT_BODY = {
    "graphPath": "civil/graphs/x.yaml",
    "graphDoc": "spec: {}\n",
    "orchestration": "def run(v):\n    return v\n",
}


def test_healthz_answers_ok() -> None:
    print("test_healthz_answers_ok")
    status, body = request("GET", "/healthz")
    ok(status == 200 and body == {"ok": True}, "GET /healthz answers 200 ok")


def test_transpile_meta_reaches_its_handler() -> None:
    print("test_transpile_meta_reaches_its_handler")
    status, body = request("GET", "/transpile/meta")
    ok(status == 200, "GET /transpile/meta answers 200")
    ok(
        body == {"model": server.DEFAULT_MODEL, "promptVersion": server.PROMPT_VERSION},
        "meta carries the model and prompt version the memo hash folds in",
    )


def test_execute_routes_to_execute_bundle() -> None:
    print("test_execute_routes_to_execute_bundle")
    RECORD.pop("execute", None)
    status, body = request("POST", "/execute", EXECUTE_BUNDLE)
    ok(status == 200 and body == {"done": True}, "POST /execute answers done")
    ok(RECORD.get("execute") == EXECUTE_BUNDLE, "the parsed bundle reaches execute_bundle")


def test_execute_bad_json_400() -> None:
    print("test_execute_bad_json_400")
    RECORD.pop("execute", None)
    status, _ = request("POST", "/execute", raw=b"{not json")
    ok(status == 400, "a malformed /execute body answers 400")
    ok("execute" not in RECORD, "no execution runs on a body that never parsed")


def test_analyze_routes_and_shapes_the_response() -> None:
    print("test_analyze_routes_and_shapes_the_response")
    RECORD.pop("analyze", None)
    status, body = request("POST", "/analyze", ANALYZE_BODY)
    ok(status == 200 and body == {"patterns": "## canned patterns"}, "POST /analyze wraps the analyzer text")
    ok(RECORD["analyze"]["files"] == ANALYZE_BODY["files"], "the files reach analyze")
    ok(RECORD["analyze"]["model"] == server.DEFAULT_MODEL, "analyze runs on the resolved model")
    ok(RECORD["analyze"]["client"] is SENTINEL_CLIENT, "the model client is forwarded to analyze")


def test_analyze_rejects_bad_files() -> None:
    print("test_analyze_rejects_bad_files")
    status, body = request("POST", "/analyze", {"files": {}})
    ok(status == 400 and "files" in body["error"], "an empty files map answers 400")
    status, _ = request("POST", "/analyze", {"files": {"a.py": 3}})
    ok(status == 400, "a non-string file body answers 400")
    status, _ = request("POST", "/analyze", {})
    ok(status == 400, "a missing files key answers 400")


def test_transpile_routes_and_shapes_the_response() -> None:
    print("test_transpile_routes_and_shapes_the_response")
    RECORD.pop("transpile", None)
    status, body = request("POST", "/transpile", TRANSPILE_BODY)
    ok(
        status == 200 and body == {"files": {"src/x.py": "y\n"}, "roles": {"src/x.py": "other"}, "attempts": 1},
        "POST /transpile returns the emission verbatim",
    )
    ok(RECORD["transpile"]["documents"] == TRANSPILE_BODY["documents"], "documents reach transpile")
    ok(RECORD["transpile"]["patterns"] == "## repo patterns", "patterns reach transpile")
    ok(RECORD["transpile"]["context"] == TRANSPILE_BODY["context"], "context reaches transpile")
    ok(RECORD["transpile"]["model"] == server.DEFAULT_MODEL, "transpile runs on the resolved model")


def test_transpile_defaults_optional_fields() -> None:
    print("test_transpile_defaults_optional_fields")
    RECORD.pop("transpile", None)
    status, _ = request("POST", "/transpile", {"documents": {"civil/g.yaml": "spec: {}\n"}})
    ok(status == 200, "documents alone suffice")
    ok(RECORD["transpile"]["context"] == {}, "an absent context defaults to empty")
    ok(RECORD["transpile"]["patterns"] is None, "absent patterns pass through as null")


def test_transpile_rejects_bad_body() -> None:
    print("test_transpile_rejects_bad_body")
    status, _ = request("POST", "/transpile", {"documents": {}})
    ok(status == 400, "empty documents answers 400")
    status, _ = request("POST", "/transpile", {"documents": {"a": "b"}, "patterns": 5})
    ok(status == 400, "non-string patterns answers 400")
    status, _ = request("POST", "/transpile", {"documents": {"a": "b"}, "context": {"x": 1}})
    ok(status == 400, "a non-string-map context answers 400")


def test_transpile_validation_error_answers_422() -> None:
    print("test_transpile_validation_error_answers_422")

    def raiser(*args, **kwargs):
        raise server.TranspileValidationError(["issue one", "issue two"], 3)

    saved = server.transpile
    server.transpile = raiser
    try:
        status, body = request("POST", "/transpile", TRANSPILE_BODY)
        ok(status == 422, "an exhausted validation loop answers 422")
        ok(
            body == {"error": "validation failed", "issues": ["issue one", "issue two"], "attempts": 3},
            "the issues and attempt count ride back to the caller",
        )
    finally:
        server.transpile = saved


def test_transpile_model_error_answers_502() -> None:
    print("test_transpile_model_error_answers_502")

    def raiser(*args, **kwargs):
        raise RuntimeError("model exploded")

    saved = server.transpile
    server.transpile = raiser
    try:
        status, body = request("POST", "/transpile", TRANSPILE_BODY)
        ok(status == 502 and body["error"] == "model exploded", "an unexpected model failure answers 502")
    finally:
        server.transpile = saved


def test_lift_routes_and_shapes_the_response() -> None:
    print("test_lift_routes_and_shapes_the_response")
    RECORD.pop("lift", None)
    status, body = request("POST", "/lift", LIFT_BODY)
    ok(status == 200 and body == {"unliftable": False, "edges": []}, "POST /lift returns the lift result")
    ok(RECORD["lift"]["graphPath"] == LIFT_BODY["graphPath"], "graphPath reaches lift_graph")
    ok(RECORD["lift"]["orchestration"] == LIFT_BODY["orchestration"], "the orchestration source reaches lift_graph")


def test_lift_error_answers_400() -> None:
    print("test_lift_error_answers_400")

    def raiser(*args, **kwargs):
        raise server.LiftError("graphPath is not a repo path")

    saved = server.lift_graph
    server.lift_graph = raiser
    try:
        status, body = request("POST", "/lift", LIFT_BODY)
        ok(status == 400 and body["error"] == "graphPath is not a repo path", "a LiftError is a lawful 400")
    finally:
        server.lift_graph = saved


def test_lift_rejects_bad_body() -> None:
    print("test_lift_rejects_bad_body")
    status, _ = request("POST", "/lift", {"graphDoc": "d", "orchestration": "o"})
    ok(status == 400, "a missing graphPath answers 400")
    status, _ = request("POST", "/lift", {"graphPath": "", "graphDoc": "d", "orchestration": "o"})
    ok(status == 400, "an empty graphPath answers 400")
    status, _ = request("POST", "/lift", {"graphPath": "g", "graphDoc": 1, "orchestration": "o"})
    ok(status == 400, "a non-string graphDoc answers 400")


def test_unknown_routes_404() -> None:
    print("test_unknown_routes_404")
    status, _ = request("GET", "/nope")
    ok(status == 404, "an unknown GET route answers 404")
    status, _ = request("POST", "/nope", {})
    ok(status == 404, "an unknown POST route answers 404")


def test_malformed_body_400() -> None:
    print("test_malformed_body_400")
    status, body = request("POST", "/analyze", raw=b"not json at all")
    ok(status == 400 and body["error"] == "the request body is not JSON", "a non-JSON body answers 400 with a reason")
    status, body = request("POST", "/analyze", raw=b"[1, 2, 3]")
    ok(
        status == 400 and body["error"] == "the request body must be a JSON object",
        "a JSON body that is not an object answers 400",
    )


def test_large_body_is_read_in_full() -> None:
    print("test_large_body_is_read_in_full")
    big_files = {f"pkg/mod_{i}.py": "def f():\n    return 1\n" * 200 for i in range(300)}
    RECORD.pop("analyze", None)
    status, body = request("POST", "/analyze", {"files": big_files})
    ok(status == 200 and body == {"patterns": "## canned patterns"}, "a large body is routed, not truncated or dropped")
    ok(RECORD["analyze"]["files"] == big_files, "every entry of the large body reaches the handler intact")


def test_model_client_unavailable_answers_502() -> None:
    print("test_model_client_unavailable_answers_502")
    # Drive the real guard: anthropic present but no configured key -> 502, never
    # a crash and never a real client. The key is popped, so nothing is printed.
    fake_anthropic = types.ModuleType("anthropic")
    fake_anthropic.Anthropic = lambda: object()
    saved_module = sys.modules.get("anthropic")
    sys.modules["anthropic"] = fake_anthropic
    saved_key = os.environ.pop("ANTHROPIC_API_KEY", None)
    server.Handler._model_client = ORIGINAL_MODEL_CLIENT
    try:
        status, body = request("POST", "/analyze", ANALYZE_BODY)
        ok(status == 502, "an unconfigured model client answers 502")
        ok("ANTHROPIC_API_KEY" in body["error"], "the 502 names the missing configuration")
    finally:
        server.Handler._model_client = lambda self: SENTINEL_CLIENT
        if saved_key is not None:
            os.environ["ANTHROPIC_API_KEY"] = saved_key
        if saved_module is not None:
            sys.modules["anthropic"] = saved_module
        else:
            sys.modules.pop("anthropic", None)


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    HTTPD.shutdown()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
