"""Attach related-document references to a classified record."""

from __future__ import annotations

from typing import TypedDict


class Record(TypedDict):
    id: str
    category: str
    confidence: float


class EnrichedRecord(TypedDict):
    id: str
    category: str
    confidence: float
    enrichedFrom: list[str]


def handler(record: Record) -> EnrichedRecord:
    related = _related_ids(record["category"])
    return {
        "id": record["id"],
        "category": record["category"],
        "confidence": record["confidence"],
        "enrichedFrom": related,
    }


def _related_ids(category: str) -> list[str]:
    # Placeholder for the real lookup; the shape is what the graph cares about.
    return [] if category == "other" else [f"{category}-index"]
