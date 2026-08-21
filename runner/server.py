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

from execute import execute_bundle  # noqa: E402


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
        self.send_response(404)
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/execute":
            self.send_response(404)
            self.end_headers()
            return

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

        body = json.dumps({"done": True}).encode()
        self.send_response(200)
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
