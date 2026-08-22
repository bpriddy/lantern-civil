"""The Civil session service: the local adapter of the session substrate.

docs/app-session.md, "The substrate": the session service speaks a small
contract — create with files and process specs, write files, status, logs,
destroy — and substrates are adapters behind it. This is the local one: a real
workspace under $TMPDIR/civil-sessions and ordinary child processes on the
developer's machine, because frontend tooling demands real files with real
watchers. The deployed adapter (pod-per-session) will speak the same verbs;
nothing here is allowed to leak a local assumption into the contract.

The workspace is ephemeral-but-real: everything in it is reconstructible from
the API's stores (HEAD plus pending), so losing a session loses nothing and
CLAUDE.md's no-local-only-copy invariant holds unchanged. Process starts happen
inside the request, deliberately — the runner's stance — so a 201 means the app
was actually set up and started, while /logs streams the noise to any watcher.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

# civil_runtime must be importable by every session process without an install;
# in the repo the library is a sibling, exactly as the runner sees it.
RUNTIME_SRC = Path(__file__).resolve().parent.parent / "runtime" / "src"

SESSIONS_ROOT = Path(tempfile.gettempdir()) / "civil-sessions"

# The shared venv is the local adapter's dependency warm-up (app-session.md):
# every emitted boundary server runs on one prebuilt interpreter instead of
# paying pip per session. A submitted cmd names it as the literal
# "$CIVIL_PYTHON"; this service owns the substitution.
VENV_PACKAGES = ("fastapi", "uvicorn", "anthropic", "pyyaml")

LOG_CAP = 5000          # lines kept per session; the drawer reads increments by seq
KILL_GRACE_SECONDS = 5  # TERM first; the whole group gets KILL after this

# The id becomes a directory name under SESSIONS_ROOT, so it must be a plain
# name opening with a letter or digit — no separators, and never the dot names
# (".", "..", the shared ".venv").
_ID_SHAPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")

# What a session process inherits from the service: the basics a child needs
# to run, plus ANTHROPIC_API_KEY — sessions are runner-family and hold the
# model key (app-session.md), and no platform credential beyond it. dev.sh
# sources .env into this process; nothing else may ride through.
ENV_PASSTHROUGH = ("PATH", "HOME", "TMPDIR", "LANG", "ANTHROPIC_API_KEY")


class WorkspaceWriteError(Exception):
    """A path that validated but the filesystem still refuses — e.g. a parent
    segment that is an existing file. Callers answer 400; str() names the path."""


def venv_python() -> Path:
    return SESSIONS_ROOT / ".venv" / "bin" / "python"


def ensure_venv() -> None:
    """The marker records what the venv holds: an intact venv costs nothing on
    restart, and a change to VENV_PACKAGES reinstalls instead of going stale."""
    marker = SESSIONS_ROOT / ".venv" / ".civil-packages"
    want = "\n".join(VENV_PACKAGES) + "\n"
    if marker.exists() and marker.read_text() == want:
        return
    SESSIONS_ROOT.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, "-m", "venv", str(SESSIONS_ROOT / ".venv")], check=True)
    subprocess.run([str(venv_python()), "-m", "pip", "install", "-q", *VENV_PACKAGES], check=True)
    marker.write_text(want)


def _signal_group(popen: subprocess.Popen, sig: int) -> None:
    # start_new_session=True made the child a group leader, so this reaches
    # whatever it forked (npm's node, a dev server's workers). A child that
    # already exited answers ESRCH — or EPERM on macOS while it is still an
    # unreaped zombie — and either way there is nothing left to signal.
    try:
        os.killpg(popen.pid, sig)
    except (ProcessLookupError, PermissionError):
        pass


class Proc:
    """One supervised process: no Popen until its setup succeeds; a failed
    setup is recorded as the exit code so status stays honest."""

    def __init__(self, name: str, port: int | None) -> None:
        self.name = name
        self.port = port
        self.popen: subprocess.Popen | None = None
        self.setup_code: int | None = None

    def status(self) -> dict:
        if self.popen is None:
            return {"name": self.name, "running": False, "exitCode": self.setup_code, "port": self.port}
        code = self.popen.poll()
        return {"name": self.name, "running": code is None, "exitCode": code, "port": self.port}


class Session:
    """One running app: a real workspace, its processes, one ordered log."""

    def __init__(self, session_id: str, workspace: Path) -> None:
        self.id = session_id
        self.workspace = workspace
        self.procs: list[Proc] = []
        self.stopped = False
        self.last_seen = time.monotonic()
        self._active_setup: subprocess.Popen | None = None
        self._log_lock = threading.Lock()
        self._lines: deque = deque(maxlen=LOG_CAP)
        self._seq = 0

    def touch(self) -> None:
        self.last_seen = time.monotonic()

    def log(self, proc: str, line: str) -> None:
        with self._log_lock:
            self._seq += 1
            self._lines.append((self._seq, proc, line))

    def lines_after(self, after: int) -> tuple[list[dict], int]:
        with self._log_lock:
            lines = [
                {"seq": seq, "proc": proc, "line": line}
                for seq, proc, line in self._lines
                if seq > after
            ]
        return lines, lines[-1]["seq"] if lines else after

    def write_files(self, files: dict) -> int:
        # Plain writes on purpose: the frontend's watcher is the delivery
        # mechanism, so the bytes must land where it is watching.
        for rel, content in files.items():
            path = self.workspace / rel
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            except OSError as error:
                raise WorkspaceWriteError(f"{rel}: {error}") from error
        return len(files)

    def start(self, spec: dict) -> None:
        """Setup commands sequentially, then the long-lived cmd — all in the
        caller's thread, so the POST answers once the app is actually started."""
        proc = Proc(spec["name"], spec.get("port"))
        self.procs.append(proc)
        env = self._env(spec.get("env") or {}, proc.port)
        cwd = self.workspace / spec["cwd"]
        cwd.mkdir(parents=True, exist_ok=True)

        for argv in spec.get("setup") or []:
            if self.stopped or not self._run_setup(proc, argv, cwd, env):
                return
        if self.stopped:
            return

        argv = list(spec["cmd"])
        if argv[0] == "$CIVIL_PYTHON":
            argv[0] = str(venv_python())
        try:
            proc.popen = self._spawn(argv, cwd, env)
        except OSError as error:
            proc.setup_code = 127
            self.log(proc.name, f"failed to start {argv[0]}: {error}")
            return
        if self.stopped:  # destroyed underneath us mid-start; do not leak the child
            _signal_group(proc.popen, signal.SIGKILL)
            proc.popen.wait()
            return
        threading.Thread(
            target=self._pump, args=(proc.name, proc.popen),
            daemon=True, name=f"session-{self.id}-{proc.name}",
        ).start()

    def _run_setup(self, proc: Proc, argv: list, cwd: Path, env: dict) -> bool:
        tag = f"{proc.name}:setup"
        try:
            popen = self._spawn(argv, cwd, env)
        except OSError as error:
            proc.setup_code = 127
            self.log(tag, f"failed to start {argv[0]}: {error}")
            return False
        self._active_setup = popen  # visible to destroy(), so DELETE can kill a long npm install
        if self.stopped:
            _signal_group(popen, signal.SIGKILL)
        for line in popen.stdout:
            self.log(tag, line.rstrip("\n"))
        code = popen.wait()
        self._active_setup = None
        if code != 0:
            proc.setup_code = code
            self.log(tag, f"exited {code}; {proc.name} will not start")
            return False
        return True

    def _spawn(self, argv: list, cwd: Path, env: dict) -> subprocess.Popen:
        # Its own process group, so teardown can kill everything it forked.
        return subprocess.Popen(
            argv, cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, errors="replace", bufsize=1,
            start_new_session=True,
        )

    def _pump(self, name: str, popen: subprocess.Popen) -> None:
        for line in popen.stdout:
            self.log(name, line.rstrip("\n"))
        popen.stdout.close()

    def _env(self, extra: dict, port: int | None) -> dict:
        # A curated base, never dict(os.environ): the service's environment
        # carries platform secrets a session must not see (ENV_PASSTHROUGH
        # holds the one exception). PYTHONPATH gains the workspace and the
        # runtime library so emitted imports resolve without an install.
        env = {
            key: value
            for key, value in os.environ.items()
            if key in ENV_PASSTHROUGH or key.startswith("LC_")
        }
        env.update(extra)
        entries = [str(self.workspace), str(RUNTIME_SRC)]
        if env.get("PYTHONPATH"):
            entries.append(env["PYTHONPATH"])
        env["PYTHONPATH"] = os.pathsep.join(entries)
        if port is not None:
            env["PORT"] = str(port)
        return env

    def destroy(self) -> None:
        self.stopped = True
        popens = [p.popen for p in self.procs if p.popen is not None]
        if self._active_setup is not None:
            popens.append(self._active_setup)
        for popen in popens:
            _signal_group(popen, signal.SIGTERM)
        deadline = time.monotonic() + KILL_GRACE_SECONDS
        for popen in popens:
            try:
                popen.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                _signal_group(popen, signal.SIGKILL)
                popen.wait()
        shutil.rmtree(self.workspace, ignore_errors=True)


SESSIONS: dict = {}
REGISTRY_LOCK = threading.Lock()

# Creation is serialised per id: two concurrent creates for one id must not
# interleave their rmtree/mkdir on the same workspace. Entries stay for the
# process's life — ids are few and a lock is small.
_CREATION_LOCKS: dict = {}


def _creation_lock(session_id: str) -> threading.Lock:
    with REGISTRY_LOCK:
        return _CREATION_LOCKS.setdefault(session_id, threading.Lock())


def create_session(session_id: str, files: dict, processes: list) -> Session:
    """The create verb behind POST /sessions: the same id again means the old
    app dies and the new one takes its place. Raises WorkspaceWriteError with
    nothing registered and no workspace left behind."""
    with _creation_lock(session_id):
        with REGISTRY_LOCK:
            old = SESSIONS.pop(session_id, None)
        if old is not None:
            old.destroy()

        workspace = SESSIONS_ROOT / session_id
        shutil.rmtree(workspace, ignore_errors=True)  # a crashed predecessor's leavings
        workspace.mkdir(parents=True)
        session = Session(session_id, workspace)
        try:
            session.write_files(files)
        except WorkspaceWriteError:
            shutil.rmtree(workspace, ignore_errors=True)
            raise
        # Registered before the processes start: a long npm install must be
        # watchable through /logs and killable through DELETE while it runs.
        with REGISTRY_LOCK:
            SESSIONS[session_id] = session
        for spec in processes:
            if session.stopped:
                break
            session.start(spec)
        return session


def _string_map(value: object) -> bool:
    return isinstance(value, dict) and all(
        isinstance(k, str) and isinstance(v, str) for k, v in value.items()
    )


def _inside_workspace(rel: str) -> bool:
    parts = Path(rel).parts
    return bool(parts) and not Path(rel).is_absolute() and ".." not in parts


def _files_issue(files: object) -> str | None:
    if not _string_map(files):
        return '"files" must map workspace paths to contents'
    for rel in files:
        if not _inside_workspace(rel):
            return f'"{rel}" does not stay inside the workspace'
    return None


def _process_issue(spec: object) -> str | None:
    if not isinstance(spec, dict):
        return "each process must be an object"
    if not isinstance(spec.get("name"), str) or not spec["name"]:
        return 'a process "name" must be a non-empty string'
    cwd = spec.get("cwd")
    if not isinstance(cwd, str) or (cwd != "." and not _inside_workspace(cwd)):
        return '"cwd" must be a workspace-relative path'
    cmd = spec.get("cmd")
    if not isinstance(cmd, list) or not cmd or not all(isinstance(a, str) for a in cmd):
        return '"cmd" must be a non-empty list of strings'
    setup = spec.get("setup")
    if setup is not None and (
        not isinstance(setup, list)
        or not all(
            isinstance(c, list) and c and all(isinstance(a, str) for a in c) for c in setup
        )
    ):
        return '"setup" must be a list of argv lists'
    env = spec.get("env")
    if env is not None and not _string_map(env):
        return '"env" must map strings to strings'
    port = spec.get("port")
    if port is not None and (isinstance(port, bool) or not isinstance(port, int)):
        return '"port" must be an integer or null'
    return None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 — stdlib naming
        if self.path == "/healthz":
            self._json(200, {"ok": True})
            return
        parts, query = self._route()
        if len(parts) == 2 and parts[0] == "sessions":
            session = self._session(parts[1])
            if session is None:
                return
            self._json(200, {
                "processes": [proc.status() for proc in session.procs],
                "workspace": str(session.workspace),
            })
            return
        if len(parts) == 3 and parts[0] == "sessions" and parts[2] == "logs":
            session = self._session(parts[1])
            if session is None:
                return
            try:
                after = int(query.get("after", ["0"])[0])
            except ValueError:
                self._json(400, {"error": '"after" must be an integer'})
                return
            lines, last = session.lines_after(after)
            self._json(200, {"lines": lines, "last": last})
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        parts, _ = self._route()
        if parts != ["sessions"]:
            self.send_response(404)
            self.end_headers()
            return
        body = self._body()
        if body is None:
            return
        session_id = body.get("sessionId")
        if not isinstance(session_id, str) or not _ID_SHAPE.fullmatch(session_id):
            self._json(400, {
                "error": '"sessionId" must be a plain name (letters, digits, '
                         '. _ -; the first a letter or digit)',
            })
            return
        files = body.get("files")
        processes = body.get("processes")
        issue = _files_issue(files)
        if issue is None and not isinstance(processes, list):
            issue = '"processes" must be a list'
        if issue is None:
            issue = next(filter(None, map(_process_issue, processes)), None)
        # Validated before anything is touched: a bad body must not kill a
        # running session that happens to share the id.
        if issue is not None:
            self._json(400, {"error": issue})
            return

        try:
            session = create_session(session_id, files, processes)
        except WorkspaceWriteError as error:
            self._json(400, {"error": str(error)})
            return
        self._json(201, {"sessionId": session_id, "workspace": str(session.workspace)})

    def do_PATCH(self) -> None:  # noqa: N802
        parts, _ = self._route()
        if len(parts) == 3 and parts[0] == "sessions" and parts[2] == "files":
            session = self._session(parts[1])
            if session is None:
                return
            body = self._body()
            if body is None:
                return
            issue = _files_issue(body.get("files"))
            if issue is not None:
                self._json(400, {"error": issue})
                return
            try:
                written = session.write_files(body["files"])
            except WorkspaceWriteError as error:
                self._json(400, {"error": str(error)})
                return
            self._json(200, {"written": written})
            return
        self.send_response(404)
        self.end_headers()

    def do_DELETE(self) -> None:  # noqa: N802
        parts, _ = self._route()
        if len(parts) == 2 and parts[0] == "sessions":
            with REGISTRY_LOCK:
                session = SESSIONS.pop(parts[1], None)
            if session is None:
                self._json(404, {"error": "unknown session"})
                return
            session.destroy()
            self._json(200, {"stopped": True})
            return
        self.send_response(404)
        self.end_headers()

    def _route(self) -> tuple[list, dict]:
        url = urlparse(self.path)
        parts = [unquote(part) for part in url.path.strip("/").split("/") if part]
        return parts, parse_qs(url.query)

    def _session(self, session_id: str):
        """The named session with its idle clock touched, or None with the 404
        already sent."""
        with REGISTRY_LOCK:
            session = SESSIONS.get(session_id)
        if session is None:
            self._json(404, {"error": "unknown session"})
            return None
        session.touch()
        return session

    def _body(self) -> dict | None:
        """The parsed JSON object, or None with the 400 already sent."""
        length = int(self.headers.get("content-length") or 0)
        try:
            body = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self._json(400, {"error": "the request body is not JSON"})
            return None
        if not isinstance(body, dict):
            self._json(400, {"error": "the request body must be a JSON object"})
            return None
        return body

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[session] {fmt % args}")


def start_reaper() -> None:
    """Sessions cost real processes; an idle one is stopped, not kept warm.
    Every request that names a session touches its clock."""
    idle = float(os.environ.get("CIVIL_SESSION_IDLE_SECONDS") or "3600")

    def reap() -> None:
        while True:
            time.sleep(min(60.0, max(idle / 4, 0.25)))
            cutoff = time.monotonic() - idle
            with REGISTRY_LOCK:
                stale = [sid for sid, session in SESSIONS.items() if session.last_seen < cutoff]
                sessions = [SESSIONS.pop(sid) for sid in stale]
            for session in sessions:
                print(f"[session] reaped idle session {session.id}")
                session.destroy()

    threading.Thread(target=reap, daemon=True, name="session-reaper").start()


def main() -> None:
    ensure_venv()
    start_reaper()
    # The local adapter serves the dev stack on this machine and nobody else.
    port = int(os.environ.get("CIVIL_SESSION_PORT") or "8082")
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"[session] listening on 127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
