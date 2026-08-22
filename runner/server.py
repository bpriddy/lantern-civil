"""The Civil runner: the service that executes project code and holds no secrets.

PRD 12: the API holds the platform credentials and never runs project code; this
service runs project code and holds exactly one thing — model access, the single
documented exception. Its whole conversation with the platform is outbound: it
receives a bundle, and it reports events home with a per-run token that works for
one run and dies when the run finishes.

Execution happens inside the request, deliberately: on Cloud Run the instance is
guaranteed CPU while a request is in flight, so a run is a long request rather
than a background thread that starves when the connection closes. The dispatching
API treats the call as fire-and-account, so nobody is actually waiting.
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# civil-runtime ships beside this service in the image; in the repo it is a sibling.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "runtime" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent import DEFAULT_MODEL  # noqa: E402
from execute import execute_bundle  # noqa: E402
from patterns import analyze  # noqa: E402
from transpile import PROMPT_VERSION, TranspileValidationError, transpile  # noqa: E402


def _string_map(value: object) -> bool:
    return isinstance(value, dict) and all(
        isinstance(k, str) and isinstance(v, str) for k, v in value.items()
    )


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 — stdlib naming
        if self.path == "/healthz":
            body = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/transpile/meta":
            # The API folds both values into its transpile memo hash, so a
            # model upgrade or a prompt edit busts the cache instead of
            # serving stale emissions. Same resolved model id POST uses.
            self._json(200, {"model": DEFAULT_MODEL, "promptVersion": PROMPT_VERSION})
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/execute":
            self._execute()
            return
        if self.path == "/analyze":
            self._analyze()
            return
        if self.path == "/transpile":
            self._transpile()
            return
        self.send_response(404)
        self.end_headers()

    def _execute(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        try:
            bundle = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return

        # The run happens here, inside the request. The response says only that
        # the run was carried to a conclusion — the conclusion itself lives in the
        # event log, where every watcher already looks.
        execute_bundle(bundle)
        self._json(200, {"done": True})

    def _analyze(self) -> None:
        body = self._body()
        if body is None:
            return
        files = body.get("files")
        if not _string_map(files) or not files:
            self._json(400, {"error": '"files" must map repo paths to file contents'})
            return

        client = self._model_client()
        if client is None:
            return
        try:
            self._json(200, {"patterns": analyze(files, client, DEFAULT_MODEL)})
        except Exception as error:  # noqa: BLE001 — the model is the failure domain here
            self._json(502, {"error": str(error)})

    def _transpile(self) -> None:
        body = self._body()
        if body is None:
            return
        documents = body.get("documents")
        patterns = body.get("patterns")
        context = body.get("context") or {}
        if not _string_map(documents) or not documents:
            self._json(400, {"error": '"documents" must map civil document paths to contents'})
            return
        if patterns is not None and not isinstance(patterns, str):
            self._json(400, {"error": '"patterns" must be a string or null'})
            return
        if not _string_map(context):
            self._json(400, {"error": '"context" must map repo paths to file contents'})
            return

        client = self._model_client()
        if client is None:
            return
        try:
            result = transpile(documents, patterns, context, client, DEFAULT_MODEL)
        except TranspileValidationError as error:
            self._json(422, {
                "error": "validation failed",
                "issues": error.issues,
                "attempts": error.attempts,
            })
            return
        except Exception as error:  # noqa: BLE001
            self._json(502, {"error": str(error)})
            return
        self._json(200, result)

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

    def _model_client(self):
        """Mirrors agent.py: the key is this service's one secret (PRD 12). A
        missing client is a model failure to the caller, so the answer is 502."""
        try:
            import anthropic
        except ImportError:
            self._json(502, {"error": "the runner has no model client installed (pip install anthropic)"})
            return None
        if not os.environ.get("ANTHROPIC_API_KEY"):
            self._json(502, {"error": "model access is not configured (ANTHROPIC_API_KEY)"})
            return None
        return anthropic.Anthropic()

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[runner] {fmt % args}")


def main() -> None:
    # CIVIL_RUNNER_PORT locally, where a sourced .env carries the API's PORT too;
    # PORT on Cloud Run, where every container is handed its own.
    port = int(os.environ.get("CIVIL_RUNNER_PORT") or os.environ.get("PORT") or "8081")
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[runner] listening on :{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
