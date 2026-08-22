"""Classifier agent: assigns a category and confidence to a normalized document."""

from __future__ import annotations

import json

from civil_runtime.engines import Engine

from src.steps.normalize.main import NormalizedDocument
from src.tools.search.search import search_docs

engine = Engine(model="claude-sonnet-5")

_PROMPT_FILE = "agents/classifier/prompt.md"


def run(document: NormalizedDocument) -> dict:
    system = open(_PROMPT_FILE).read()
    user = json.dumps(document)
    reply = engine.run(
        system=system,
        user=user,
        tools=[search_docs],
        max_turns=8,
    )
    return reply.json()
