"""Orchestration for the classify graph: normalize, classify, enrich."""

from __future__ import annotations

from agents.classifier.agent import run as classifier
from graphs.enrich import run as enrich
from src.steps.normalize.main import Document, handler as normalize


def run(document: Document) -> dict:
    normalized = normalize(document)
    classified = classifier(normalized)
    record = enrich(classified)
    return record
