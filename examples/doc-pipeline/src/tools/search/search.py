"""Capability target for the classifier agent.

PRD 5: tools are not their own node type in v1 — an agent references a function
inside a code node, wired by a capability edge. There is no entrypoint here because
this node never sits on a flow edge.
"""

from __future__ import annotations

from typing import TypedDict


class SearchHit(TypedDict):
    id: str
    category: str
    excerpt: str


def search_docs(query: str, limit: int = 5) -> list[SearchHit]:
    """Find previously classified documents matching `query`."""
    del query, limit
    return []
