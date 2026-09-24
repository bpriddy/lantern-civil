"""The module debugger's bundle run, exercised without a network or a model.

execute_bundle materialises a bundle to scratch, walks the graph, ships every
lifecycle event home, and deletes the scratch. Two seams reach outside and are
stood in for here: the event POST (a fake urlopen records what is sent and
answers the cancellation poll) and the agent step (run_agent is replaced, so no
model is ever reached). The graph walk itself is the real civil_runtime.runner.

PyYAML is not in the plain-python3 toolchain the runner suite runs under (see
test_transpile.py's stub), and nothing here needs YAML's surface beyond parsing
a graph document — so `yaml.safe_load` is stood in with json.loads and the graph
documents are written as JSON (which is valid YAML), keeping the double honest.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime" / "src"))

# execute imports PyYAML at module load; stand it in before importing execute.
_yaml = types.ModuleType("yaml")
_yaml.safe_load = json.loads  # graph docs are written as JSON, a valid YAML subset
sys.modules["yaml"] = _yaml

import execute  # noqa: E402

CHECKS = 0


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


# --- the fake event POST -----------------------------------------------------


class FakeHTTPResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> "FakeHTTPResponse":
        return self

    def __exit__(self, *a) -> bool:
        return False


class FakeUrlopen:
    """Records every POSTed body and answers the cancellation poll."""

    def __init__(self, cancelled: bool = False) -> None:
        self.cancelled = cancelled
        self.requests: list[urllib.request.Request] = []
        self.bodies: list[dict] = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        self.bodies.append(json.loads(request.data.decode()))
        return FakeHTTPResponse(json.dumps({"cancelled": self.cancelled}).encode())


def run_bundle(bundle: dict, cancelled: bool = False) -> list[dict]:
    """Run execute_bundle with the POST seam faked; return the flattened events."""
    fake = FakeUrlopen(cancelled)
    old = urllib.request.urlopen
    urllib.request.urlopen = fake
    try:
        execute.execute_bundle(bundle)
    finally:
        urllib.request.urlopen = old
    return [event for body in fake.bodies for event in body["events"]]


def finished_payload(events: list[dict]) -> dict:
    matches = [e for e in events if e["type"] == "run.finished"]
    assert len(matches) == 1, f"expected exactly one run.finished, got {len(matches)}"
    return matches[0]["payload"]


# --- bundle fixtures ---------------------------------------------------------

NORMALIZE = 'def handler(value):\n    return {"doubled": value["n"] * 2}\n'
BOOM = "def handler(value):\n    raise ValueError('bad step')\n"


def graph_doc(nodes: list[dict], edges: list[dict]) -> str:
    return json.dumps({"apiVersion": "civil/v1", "kind": "Graph", "spec": {"nodes": nodes, "edges": edges}})


def code_bundle(handler: str) -> dict:
    return {
        "eventsUrl": "http://runner.test/events",
        "token": "tok-123",
        "graphPath": "graphs/pipeline.graph.yaml",
        "input": {"n": 5},
        "files": {
            "steps/normalize.py": handler,
            "graphs/pipeline.graph.yaml": graph_doc(
                [
                    {"id": "doc", "type": "io", "direction": "in"},
                    {"id": "step", "type": "code", "entrypoint": "steps/normalize.py"},
                    {"id": "out", "type": "io", "direction": "out"},
                ],
                [
                    {"id": "e1", "kind": "flow", "from": {"node": "doc"}, "to": {"node": "step"}},
                    {"id": "e2", "kind": "flow", "from": {"node": "step"}, "to": {"node": "out"}},
                ],
            ),
        },
    }


# --- EventReporter ------------------------------------------------------------


def test_event_reporter_posts_with_auth_and_reads_cancellation() -> None:
    print("test_event_reporter_posts_with_auth_and_reads_cancellation")
    fake = FakeUrlopen(cancelled=False)
    old = urllib.request.urlopen
    urllib.request.urlopen = fake
    try:
        reporter = execute.EventReporter("http://runner.test/events", "tok-abc")
        cancelled = reporter({"type": "run.started"})
        ok(cancelled is False, "a non-cancelling answer reads as False")
        request = fake.requests[0]
        ok(request.full_url == "http://runner.test/events", "events go to the events URL")
        ok(request.get_header("Authorization") == "Bearer tok-abc", "the bearer token rides the request")
        ok(request.get_header("Content-type") == "application/json", "the body is declared JSON")
        ok(fake.bodies[0] == {"events": [{"type": "run.started"}]}, "a single event is wrapped in an events list")

        fake.cancelled = True
        ok(reporter.send([{"type": "node.started"}]) is True, "a cancelling answer reads as True")
    finally:
        urllib.request.urlopen = old


def test_event_reporter_survives_a_failed_post() -> None:
    print("test_event_reporter_survives_a_failed_post")

    def boom(request, timeout=None):
        raise OSError("connection refused")

    old = urllib.request.urlopen
    urllib.request.urlopen = boom
    try:
        reporter = execute.EventReporter("http://runner.test/events", "tok")
        ok(reporter.send([{"type": "run.started"}]) is False, "a run does not die when one report fails to send")
    finally:
        urllib.request.urlopen = old


# --- execute_bundle: the happy walk ------------------------------------------


def test_execute_bundle_runs_a_graph_and_reports_finished() -> None:
    print("test_execute_bundle_runs_a_graph_and_reports_finished")
    events = run_bundle(code_bundle(NORMALIZE))
    types_seen = [e["type"] for e in events]
    ok(types_seen[0] == "run.started", "the run announces its start first")
    ok("node.started" in types_seen, "the code step is reported as started")
    ok("node.output" in types_seen, "the io-out binding is reported")
    payload = finished_payload(events)
    ok(payload["status"] == "finished", "the run finishes with status finished")
    ok(payload["output"] == {"out": {"doubled": 10}}, "the step's output flows to the io-out node")
    ok(not any(e["type"] == "node.failed" for e in events), "nothing failed")


# --- execute_bundle: agent dispatch (model stubbed out) ----------------------


def agent_bundle(tool_validation: str | None) -> dict:
    bundle = {
        "eventsUrl": "http://runner.test/events",
        "token": "tok",
        "graphPath": "graphs/classify.graph.yaml",
        "input": {"text": "hello"},
        "files": {
            "tools/search.py": "def search(query: str) -> list:\n    return []\n",
            "graphs/classify.graph.yaml": graph_doc(
                [
                    {"id": "doc", "type": "io", "direction": "in"},
                    {"id": "classifier", "type": "agent", "name": "Classifier"},
                    {"id": "tools", "type": "code", "entrypoint": "tools/search.py"},
                    {"id": "out", "type": "io", "direction": "out"},
                ],
                [
                    {"id": "e1", "kind": "flow", "from": {"node": "doc"}, "to": {"node": "classifier"}},
                    {"id": "e2", "kind": "flow", "from": {"node": "classifier"}, "to": {"node": "out"}},
                    {"id": "e3", "kind": "capability", "from": {"node": "classifier"}, "to": {"node": "tools", "function": "search"}},
                ],
            ),
        },
    }
    if tool_validation is not None:
        bundle["toolValidation"] = tool_validation
    return bundle


def test_execute_bundle_dispatches_agent_nodes() -> None:
    print("test_execute_bundle_dispatches_agent_nodes")
    captured: dict = {}

    def fake_run_agent(*, scratch, node, value, tools, tool_validation, report):
        captured["scratch"] = scratch
        captured["node_id"] = node.id
        captured["value"] = value
        captured["tools"] = tools
        captured["tool_validation"] = tool_validation
        captured["report_callable"] = callable(report)
        captured["scratch_exists"] = Path(scratch).is_dir()
        return {"category": "invoice"}

    old = execute.run_agent
    execute.run_agent = fake_run_agent
    try:
        events = run_bundle(agent_bundle("lenient"))
    finally:
        execute.run_agent = old

    ok(captured["node_id"] == "classifier", "the agent closure runs the agent node")
    ok(captured["value"] == {"text": "hello"}, "the run input flows into the agent as its value")
    ok(captured["tool_validation"] == "lenient", "the bundle's toolValidation is passed through")
    ok(captured["report_callable"], "the reporter is handed to the agent")
    ok(captured["scratch_exists"], "the agent is given a materialised scratch directory")
    ok(len(captured["tools"]) == 1 and captured["tools"][0].function == "search", "the capability edge arrives as a resolved tool ref")
    payload = finished_payload(events)
    ok(payload["output"] == {"out": {"category": "invoice"}}, "the agent's answer flows to the io-out node")


def test_execute_bundle_defaults_tool_validation_to_strict() -> None:
    print("test_execute_bundle_defaults_tool_validation_to_strict")
    seen: dict = {}

    def fake_run_agent(*, scratch, node, value, tools, tool_validation, report):
        seen["tool_validation"] = tool_validation
        return "ok"

    old = execute.run_agent
    execute.run_agent = fake_run_agent
    try:
        run_bundle(agent_bundle(None))  # no toolValidation in the bundle
    finally:
        execute.run_agent = old
    ok(seen["tool_validation"] == "strict", "an unstated toolValidation defaults to strict (PRD 11.3)")


# --- execute_bundle: error propagation ---------------------------------------


def test_execute_bundle_reports_a_failing_step() -> None:
    print("test_execute_bundle_reports_a_failing_step")
    events = run_bundle(code_bundle(BOOM))
    failures = [e for e in events if e["type"] == "node.failed"]
    ok(len(failures) == 1 and "bad step" in failures[0]["payload"]["error"], "the failing node is reported with its message")
    payload = finished_payload(events)
    ok(payload["status"] == "failed", "a step exception surfaces as a failed run")
    ok("bad step" in payload["error"], "the run.finished error carries the failure's message")


def test_execute_bundle_reports_a_missing_graph() -> None:
    print("test_execute_bundle_reports_a_missing_graph")
    bundle = code_bundle(NORMALIZE)
    bundle["graphPath"] = "graphs/absent.graph.yaml"  # not among the files
    events = run_bundle(bundle)
    payload = finished_payload(events)
    ok(payload["status"] == "failed", "a graph missing from the bundle fails the run")
    ok("is not in the bundle" in payload["error"], "the GraphError names the missing graph")


def test_execute_bundle_reports_a_graph_without_spec() -> None:
    print("test_execute_bundle_reports_a_graph_without_spec")
    bundle = code_bundle(NORMALIZE)
    bundle["files"]["graphs/pipeline.graph.yaml"] = json.dumps({"kind": "Graph"})  # no spec key
    events = run_bundle(bundle)
    payload = finished_payload(events)
    ok(payload["status"] == "failed", "a spec-less graph fails the run")
    ok("has no spec" in payload["error"], "the GraphError says the spec is missing")


def test_execute_bundle_reports_cancellation() -> None:
    print("test_execute_bundle_reports_cancellation")
    events = run_bundle(code_bundle(NORMALIZE), cancelled=True)
    payload = finished_payload(events)
    ok(payload["status"] == "cancelled", "a cancelling poll stops the walk and reports cancelled")
    ok("output" not in payload and "error" not in payload, "a cancelled run reports neither output nor error")


# --- execute_bundle: the scratch is cleaned up -------------------------------


def test_execute_bundle_cleans_up_its_scratch() -> None:
    print("test_execute_bundle_cleans_up_its_scratch")
    created: dict = {}
    real_mkdtemp = tempfile.mkdtemp

    def recording_mkdtemp(*a, **k):
        path = real_mkdtemp(*a, **k)
        created["path"] = path
        return path

    tempfile.mkdtemp = recording_mkdtemp
    try:
        run_bundle(code_bundle(NORMALIZE))
    finally:
        tempfile.mkdtemp = real_mkdtemp
    ok("path" in created, "execute_bundle allocated a scratch dir")
    ok(not os.path.exists(created["path"]), "the scratch is deleted after the run (losing the container loses nothing)")


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
