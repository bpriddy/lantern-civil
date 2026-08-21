"""One bundle, one run: materialise, walk, report, clean up.

The bundle is everything the run needs and nothing it must not have (PRD 12):
files, input, the graph to walk, and the address + token its events go home
with. Scratch on disk is fine here — it is derived entirely from the bundle and
deleted after, so losing the container loses nothing (CLAUDE.md's test).
"""

from __future__ import annotations

import json
import shutil
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

import yaml

from civil_runtime.runner import CancelledRun, GraphError, run_graph
from agent import run_agent


class EventReporter:
    """Events go home one POST at a time; the answer is the cancellation poll."""

    def __init__(self, events_url: str, token: str) -> None:
        self.events_url = events_url
        self.token = token

    def send(self, events: list[dict[str, Any]]) -> bool:
        request = urllib.request.Request(
            self.events_url,
            data=json.dumps({"events": events}).encode(),
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.token}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                answer = json.loads(response.read() or b"{}")
                return bool(answer.get("cancelled"))
        except Exception as error:  # noqa: BLE001
            # A run must not die because one report missed; the next one carries on.
            print(f"[runner] event report failed: {error}")
            return False

    def __call__(self, event: dict[str, Any]) -> bool:
        return self.send([event])


def execute_bundle(bundle: dict[str, Any]) -> None:
    report = EventReporter(bundle["eventsUrl"], bundle["token"])
    scratch = Path(tempfile.mkdtemp(prefix="civil-run-"))

    try:
        for path, content in bundle.get("files", {}).items():
            target = scratch / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)

        def load_graph(path: str) -> dict[str, Any]:
            file = scratch / path
            if not file.is_file():
                raise GraphError(f"{path} is not in the bundle")
            doc = yaml.safe_load(file.read_text())
            spec = (doc or {}).get("spec")
            if not isinstance(spec, dict):
                raise GraphError(f"{path} has no spec")
            return spec

        def agent(node: Any, value: Any, tools: list[Any]) -> Any:
            return run_agent(
                scratch=scratch,
                node=node,
                value=value,
                tools=tools,
                tool_validation=bundle.get("toolValidation", "strict"),
                report=report,
            )

        report({"type": "run.started"})

        outputs = run_graph(
            scratch=scratch,
            graph_path=bundle["graphPath"],
            spec=load_graph(bundle["graphPath"]),
            run_input=bundle.get("input"),
            report=report,
            agent=agent,
            load_subgraph=load_graph,
        )

        report({
            "type": "run.finished",
            "payload": {"status": "finished", "output": outputs},
        })
    except CancelledRun:
        report({"type": "run.finished", "payload": {"status": "cancelled"}})
    except Exception as error:  # noqa: BLE001 — the log is where failures go
        report({
            "type": "run.finished",
            "payload": {"status": "failed", "error": str(error)},
        })
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
