"""The session service, exercised over a real socket with real processes.

No npm, no pip, no network beyond localhost: the venv step is stubbed (its
marker logic is tested directly), processes are python3 one-liners, and
"$CIVIL_PYTHON" resolves to a fake venv python the suite plants. What is
tested is the substrate contract itself: materialise, supervise, stream,
write through, replace, destroy, reap.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import time
import types
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server  # noqa: E402

# The suite owns a scratch root, so a developer's real sessions are untouched.
SCRATCH = Path(tempfile.mkdtemp(prefix="civil-session-test-"))
server.SESSIONS_ROOT = SCRATCH / "civil-sessions"
server.Handler.log_message = lambda *args: None  # keep the check output readable

HTTPD = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
PORT = HTTPD.server_address[1]
threading.Thread(target=HTTPD.serve_forever, daemon=True).start()

CHECKS = 0


def ok(condition: bool, label: str) -> None:
    global CHECKS
    assert condition, label
    CHECKS += 1
    print(f"  ok   {label}")


def until(predicate, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


def request(method: str, path: str, body: object = None, raw: bytes | None = None):
    conn = HTTPConnection("127.0.0.1", PORT, timeout=10)
    payload = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    conn.request(method, path, payload)
    response = conn.getresponse()
    data = response.read()
    conn.close()
    return response.status, json.loads(data) if data else {}


PY = sys.executable

# The stand-in app: prove the env, print a few lines, then live until killed.
APP = """\
import os, time
print("port", os.environ.get("PORT"), flush=True)
print("pythonpath", os.environ.get("PYTHONPATH"), flush=True)
for n in range(3):
    print("line", n, flush=True)
time.sleep(60)
"""


def create(session_id: str, **overrides):
    body = {
        "sessionId": session_id,
        "files": {"app/main.py": APP, "app/data.txt": "hello\n"},
        "processes": [{
            "name": "app",
            "cwd": ".",
            "setup": [[PY, "-c", "print('setup says hi')"]],
            "cmd": [PY, "-u", "app/main.py"],
            "port": 43999,
        }],
    }
    body.update(overrides)
    return request("POST", "/sessions", body)


def logged(session_id: str) -> list:
    _, body = request("GET", f"/sessions/{session_id}/logs")
    return [(line["proc"], line["line"]) for line in body["lines"]]


def test_create_materialises_and_starts() -> None:
    status, body = create("proj-1")
    ok(status == 201 and body["sessionId"] == "proj-1", "creation answers 201 with the id")
    workspace = Path(body["workspace"])
    ok(workspace == server.SESSIONS_ROOT / "proj-1", "the workspace lives under the sessions root")
    ok((workspace / "app" / "data.txt").read_text() == "hello\n", "files land verbatim")

    status, body = request("GET", "/sessions/proj-1")
    proc = body["processes"][0]
    ok(status == 200 and body["workspace"] == str(workspace), "status names the workspace")
    ok(proc["name"] == "app" and proc["port"] == 43999, "status names the process and its port")
    ok(proc["running"] is True and proc["exitCode"] is None, "the process is running")

    ok(until(lambda: ("app", "line 2") in logged("proj-1")), "stdout streams into the log")
    lines = logged("proj-1")
    ok(("app:setup", "setup says hi") in lines, "setup output is tagged name:setup")
    ok(("app", "port 43999") in lines, "PORT reaches the process")
    pythonpath = next(line for proc, line in lines if proc == "app" and line.startswith("pythonpath"))
    ok(
        str(workspace) in pythonpath and str(server.RUNTIME_SRC) in pythonpath,
        "PYTHONPATH carries the workspace and civil-runtime",
    )


def test_logs_paginate_by_seq() -> None:
    _, body = request("GET", "/sessions/proj-1/logs?after=0")
    seqs = [line["seq"] for line in body["lines"]]
    ok(seqs == sorted(seqs) and len(set(seqs)) == len(seqs), "seqs are ordered and unique")
    ok(body["last"] == seqs[-1], "last names the newest seq")
    _, tail = request("GET", f"/sessions/proj-1/logs?after={body['last']}")
    ok(tail["lines"] == [] and tail["last"] == body["last"], "after the newest seq there is nothing")
    mid = seqs[len(seqs) // 2]
    _, rest = request("GET", f"/sessions/proj-1/logs?after={mid}")
    ok([line["seq"] for line in rest["lines"]] == [s for s in seqs if s > mid], "after=N returns strictly newer lines")


def test_patch_writes_through_to_disk() -> None:
    status, body = request("PATCH", "/sessions/proj-1/files", {
        "files": {"app/extra.txt": "patched\n", "deep/nested/file.txt": "x"},
    })
    ok(status == 200 and body == {"written": 2}, "PATCH answers the count")
    workspace = server.SESSIONS_ROOT / "proj-1"
    ok((workspace / "app" / "extra.txt").read_text() == "patched\n", "the edit lands on disk")
    ok((workspace / "deep" / "nested" / "file.txt").exists(), "parents are created")


def test_write_through_bumps_files_version() -> None:
    _, before = request("GET", "/sessions/proj-1")
    ok(isinstance(before.get("filesVersion"), int), "status carries filesVersion")
    request("PATCH", "/sessions/proj-1/files", {"files": {"bump.txt": "x"}})
    _, after = request("GET", "/sessions/proj-1")
    ok(after["filesVersion"] == before["filesVersion"] + 1, "a write-through moves it")
    _, again = request("GET", "/sessions/proj-1")
    ok(again["filesVersion"] == after["filesVersion"], "reading never moves it")


def test_write_failures_answer_400() -> None:
    # app/data.txt exists as a file, so a path through it cannot land — the
    # request must answer, not drop the connection.
    status, body = request("PATCH", "/sessions/proj-1/files", {
        "files": {"app/data.txt/child.txt": "x"},
    })
    ok(status == 400 and "app/data.txt/child.txt" in body["error"], "a parent that is a file answers 400")
    status, body = create("proj-clash", files={"a.txt": "x", "a.txt/b.txt": "y"})
    ok(status == 400 and "a.txt/b.txt" in body["error"], "the same failure on create answers 400")
    ok("proj-clash" not in server.SESSIONS, "nothing half-made survives")
    ok(not (server.SESSIONS_ROOT / "proj-clash").exists(), "and no workspace is left behind")


def test_reposting_the_same_id_replaces() -> None:
    old = server.SESSIONS["proj-1"].procs[0].popen
    status, _ = create("proj-1")
    ok(status == 201, "the same id creates again")
    ok(until(lambda: old.poll() is not None), "the old process is dead")
    workspace = server.SESSIONS_ROOT / "proj-1"
    ok(not (workspace / "app" / "extra.txt").exists(), "the workspace is fresh, not layered")
    _, body = request("GET", "/sessions/proj-1")
    ok(body["processes"][0]["running"] is True, "the replacement is running")


def test_concurrent_creates_for_one_id_serialise() -> None:
    # The internal path, deterministically: both threads race the same id and
    # neither may see the other's rmtree/mkdir mid-flight.
    barrier = threading.Barrier(2)
    errors: list = []

    def race() -> None:
        barrier.wait()
        try:
            server.create_session("proj-race", {"f.txt": "x"}, [])
        except Exception as error:  # noqa: BLE001 — any escape is the failure
            errors.append(error)

    threads = [threading.Thread(target=race) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    ok(errors == [], f"neither create raised: {errors}")
    workspace = server.SESSIONS_ROOT / "proj-race"
    ok(workspace.is_dir() and (workspace / "f.txt").read_text() == "x", "one intact workspace survives")
    ok("proj-race" in server.SESSIONS, "one session holds the id")
    request("DELETE", "/sessions/proj-race")


def test_delete_stops_and_removes() -> None:
    popen = server.SESSIONS["proj-1"].procs[0].popen
    status, body = request("DELETE", "/sessions/proj-1")
    ok(status == 200 and body == {"stopped": True}, "DELETE answers stopped")
    ok(until(lambda: popen.poll() is not None), "the process is killed")
    ok(not (server.SESSIONS_ROOT / "proj-1").exists(), "the workspace is deleted")
    status, _ = request("GET", "/sessions/proj-1")
    ok(status == 404, "the session is gone")


def test_unknown_sessions_404() -> None:
    for method, path in (
        ("GET", "/sessions/nope"),
        ("GET", "/sessions/nope/logs"),
        ("DELETE", "/sessions/nope"),
    ):
        status, body = request(method, path)
        ok(status == 404 and "error" in body, f"{method} {path} answers 404")
    status, body = request("PATCH", "/sessions/nope/files", {"files": {}})
    ok(status == 404 and "error" in body, "PATCH on an unknown session answers 404")


def test_bad_bodies_400() -> None:
    status, body = request("POST", "/sessions", raw=b"not json")
    ok(status == 400 and "error" in body, "non-JSON is a 400")
    status, _ = create("proj-bad", files={"../escape.txt": "x"})
    ok(status == 400, "a path escaping the workspace is a 400")
    status, _ = create("../escape")
    ok(status == 400, "a traversal session id is a 400")
    status, _ = create("proj-bad", processes=[{"name": "x"}])
    ok(status == 400, "a malformed process spec is a 400")
    ok("proj-bad" not in server.SESSIONS, "nothing half-made survives a 400")
    venv = server.SESSIONS_ROOT / ".venv"
    venv.mkdir(parents=True, exist_ok=True)
    (venv / "sentinel").write_text("keep\n")
    status, _ = create(".venv")
    ok(status == 400, "the shared venv's name is not a session id")
    ok((venv / "sentinel").read_text() == "keep\n", "and the venv survives the attempt")


def test_child_env_is_curated_not_inherited() -> None:
    # The service's own env carries platform secrets (dev.sh sources .env);
    # a session process gets the curated base, and ANTHROPIC_API_KEY is the
    # one documented exception — sessions are runner-family.
    os.environ["DATABASE_URL"] = "postgres://sentinel"
    os.environ["ANTHROPIC_API_KEY"] = "the-model-key"
    try:
        status, _ = create("proj-env", files={}, processes=[{
            "name": "env",
            "cwd": ".",
            "cmd": [PY, "-u", "-c",
                    "import os; print('database', os.environ.get('DATABASE_URL')); "
                    "print('key', os.environ.get('ANTHROPIC_API_KEY'))"],
            "port": None,
        }])
        ok(status == 201, "the env probe starts")
        ok(
            until(lambda: ("env", "key the-model-key") in logged("proj-env")),
            "ANTHROPIC_API_KEY reaches the child",
        )
        ok(("env", "database None") in logged("proj-env"), "a platform secret does not")
    finally:
        del os.environ["DATABASE_URL"], os.environ["ANTHROPIC_API_KEY"]
    request("DELETE", "/sessions/proj-env")


def test_civil_python_resolves_to_the_shared_venv() -> None:
    fake = server.venv_python()
    fake.parent.mkdir(parents=True, exist_ok=True)
    if not fake.exists():
        fake.symlink_to(sys.executable)
    status, _ = create("proj-venv", files={}, processes=[{
        "name": "boundary",
        "cwd": ".",
        "cmd": ["$CIVIL_PYTHON", "-u", "-c", "print('spoken through the venv')"],
        "port": None,
    }])
    ok(status == 201, "a $CIVIL_PYTHON process starts")

    def state() -> dict:
        _, body = request("GET", "/sessions/proj-venv")
        return body["processes"][0]

    ok(until(lambda: state()["exitCode"] == 0), "the one-shot process exits 0")
    ok(state()["running"] is False, "and reads as not running")
    ok(("boundary", "spoken through the venv") in logged("proj-venv"), "cmd[0] was substituted")
    request("DELETE", "/sessions/proj-venv")


def test_ensure_venv_skips_on_the_marker() -> None:
    marker = server.SESSIONS_ROOT / ".venv" / ".civil-packages"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("\n".join(server.VENV_PACKAGES) + "\n")

    def no_pip(*args, **kwargs):
        raise AssertionError("pip ran behind an intact marker")

    real = server.subprocess
    server.subprocess = types.SimpleNamespace(run=no_pip)
    try:
        server.ensure_venv()
        ok(True, "an intact venv costs nothing")
    finally:
        server.subprocess = real

    marker.write_text("stale\n")
    ran: list = []
    server.subprocess = types.SimpleNamespace(run=lambda argv, **kwargs: ran.append(argv))
    try:
        server.ensure_venv()
    finally:
        server.subprocess = real
    ok(len(ran) == 2 and "venv" in ran[0] and "install" in ran[1], "a package change reinstalls")
    ok(marker.read_text() == "\n".join(server.VENV_PACKAGES) + "\n", "the marker records what was installed")


def test_idle_sessions_are_reaped() -> None:
    os.environ["CIVIL_SESSION_IDLE_SECONDS"] = "0.5"
    server.start_reaper()
    status, _ = create("proj-idle")
    ok(status == 201, "the doomed session starts")
    popen = server.SESSIONS["proj-idle"].procs[0].popen
    # Polled through the registry, not the API — a GET would touch the clock
    # and keep the session alive, which is exactly the contract.
    ok(until(lambda: "proj-idle" not in server.SESSIONS, timeout=15), "the reaper collects it")
    ok(until(lambda: popen.poll() is not None), "its process dies with it")
    ok(until(lambda: not (server.SESSIONS_ROOT / "proj-idle").exists()), "its workspace is deleted")
    status, _ = request("GET", "/sessions/proj-idle")
    ok(status == 404, "and the API says 404")


def main() -> int:
    # In order, not sorted: the middle tests lean on proj-1 from the first, and
    # the reaper runs last because once armed its half-second clock stays armed.
    tests = [
        test_create_materialises_and_starts,
        test_logs_paginate_by_seq,
        test_patch_writes_through_to_disk,
        test_write_failures_answer_400,
        test_reposting_the_same_id_replaces,
        test_concurrent_creates_for_one_id_serialise,
        test_delete_stops_and_removes,
        test_unknown_sessions_404,
        test_bad_bodies_400,
        test_child_env_is_curated_not_inherited,
        test_civil_python_resolves_to_the_shared_venv,
        test_ensure_venv_skips_on_the_marker,
        test_idle_sessions_are_reaped,
    ]
    for test in tests:
        print(test.__name__)
        test()
    with server.REGISTRY_LOCK:
        leftovers = [server.SESSIONS.pop(sid) for sid in list(server.SESSIONS)]
    for session in leftovers:
        session.destroy()
    HTTPD.shutdown()
    shutil.rmtree(SCRATCH, ignore_errors=True)
    print(f"\n{CHECKS} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
