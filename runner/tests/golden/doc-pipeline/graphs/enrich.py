"""Orchestration for the enrich subgraph: attach related-document references."""

from __future__ import annotations

from src.steps.enrich.main import handler as lookup
from src.steps.enrich.main import EnrichedRecord, Record


def run(classified: Record) -> EnrichedRecord:
    enriched = lookup(classified)
    return enriched
