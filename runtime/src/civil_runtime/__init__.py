"""Executes Civil graph manifests.

See README.md for why this is a Python package rather than part of the TypeScript
monorepo, and for the split of responsibilities between the two.
"""

from __future__ import annotations

__all__ = ["__version__", "EVENT_TYPES"]

__version__ = "0.0.0"

#: PRD 9.1's event vocabulary. The event log is the spine: Civil's canvas, the trace
#: viewer, and a deployed frontend all consume these same events through the same
#: code, which is what makes replay and live use one path rather than two.
#:
#: Mirrored by the CHECK constraint on run_events in the API's migration 001. Adding
#: a type means changing both, deliberately — the constraint is what stops a typo in
#: an emitter from silently producing events nothing consumes.
EVENT_TYPES: frozenset[str] = frozenset(
    {
        "run.started",
        "node.queued",
        "node.started",
        "node.progress",
        "node.token",
        "node.tool_call",
        "node.tool_result",
        "node.output",
        "node.failed",
        "node.finished",
        "run.finished",
    }
)
