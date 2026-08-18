"""Normalize a raw document before it reaches the classifier.

PRD 7.2: the contract is read from this signature, not duplicated in a manifest.
Editing this function is editing the node's ports.
"""

from __future__ import annotations

import re
import unicodedata
from typing import TypedDict


class Document(TypedDict):
    id: str
    body: str


class NormalizedDocument(TypedDict):
    id: str
    body: str
    word_count: int


_WHITESPACE = re.compile(r"\s+")


def handler(document: Document) -> NormalizedDocument:
    """Collapse whitespace and normalize unicode so the classifier sees stable text."""
    body = unicodedata.normalize("NFKC", document["body"])
    body = _WHITESPACE.sub(" ", body).strip()
    return {"id": document["id"], "body": body, "word_count": len(body.split())}
