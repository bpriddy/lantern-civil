"""The pattern analyzer: the repo's code in, a code pattern helper prompt out.

The user's pattern IS the pattern (docs/emitted-code.md rule 1). This component
reads the code a human wrote and describes the conventions it actually follows,
as markdown the transpiler will carry in its prompt. Deliberately less
prescriptive to start (docs/roadmap.md, "Transpiler hardening path"): the model
describes what is there, and prompt refinement narrows it as patterns stabilize.
Nondeterminism is quarantined here — the output is snapshotted into
civil/patterns.md, so the transpiler's inputs stay versioned files.
"""

from __future__ import annotations

import os
from typing import Any

MAX_TOKENS = int(os.environ.get("CIVIL_PATTERNS_MAX_TOKENS", "2048"))

# The prompt must fit the model's window with room for the answer; oversized
# files are almost always assets or lockfiles, not style evidence.
MAX_FILE_BYTES = 100_000
MAX_TOTAL_BYTES = 300_000

SYSTEM = """\
You are reading a repository in order to write a short code pattern helper \
prompt: a concise markdown description of this repo's ACTUAL conventions, \
which another model will follow when writing new code for the same repo.

Describe what the code does, in these dimensions where the code shows them: \
naming, module layout, sync or async style, type-hint density, docstring \
habits, import style and ordering, error handling. Where the repo is \
inconsistent, say which way it leans.

Describe what IS — do not invent rules the code does not demonstrate, do not \
prescribe improvements, and do not pad dimensions the code gives no evidence \
for. Output only the markdown helper prompt, concise enough to sit inside \
another model's system prompt."""


def _select(files: dict[str, str]) -> tuple[list[tuple[str, str]], list[str]]:
    """Sorted traversal keeps the prompt stable across calls with the same repo."""
    included: list[tuple[str, str]] = []
    skipped: list[str] = []
    total = 0
    for path in sorted(files):
        content = files[path]
        size = len(content.encode("utf-8", errors="replace"))
        if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_BYTES:
            skipped.append(path)
            continue
        total += size
        included.append((path, content))
    return included, skipped


def analyze(files: dict[str, str], client: Any, model: str) -> str:
    included, skipped = _select(files)

    parts = ["The repository's files follow. Write the code pattern helper prompt."]
    for path, content in included:
        parts.append(f"--- {path} ---\n{content}")
    if skipped:
        parts.append(
            "Not shown, for size — judge only from the files above: "
            + ", ".join(skipped)
        )

    response = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        system=SYSTEM,
        messages=[{"role": "user", "content": "\n\n".join(parts)}],
    )
    return "".join(block.text for block in response.content if block.type == "text").strip()
