"""A function-backed service.

PRD 4: this and the graph-backed `classify` are one thing at two resolutions.
Nothing upstream cares which it is, and this could become a graph later with no
change to the composition.
"""

from __future__ import annotations

from typing import TypedDict


class Record(TypedDict):
    id: str
    category: str
    confidence: float


class SaveResult(TypedDict):
    id: str
    stored: bool


def handler(record: Record) -> SaveResult:
    return {"id": record["id"], "stored": True}
