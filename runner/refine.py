"""The lift's model pass: a repo's skeleton in, names and words out.

The deterministic reader (apps/api/src/lift) has already found every client,
server, service, agent and process the code shows; this pass reads that
skeleton beside the repo's own docs and offers what a reader cannot derive —
clearer ids, which services are plumbing, one sentence per entity, and a few
paragraphs on the system. It may rename, classify and describe; it never adds
or removes an entity, and the schema gives it no way to try.

Same discipline as transpile.py: one forced tool call per attempt, deterministic
validators whose complaints go back for a bounded number of retries, and a
validation error past that. The API validates the answer again and falls back
to the deterministic skeleton on any failure, so this pass is an improvement
the feature never depends on.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

MAX_TOKENS = int(os.environ.get("CIVIL_REFINE_MAX_TOKENS", "8192"))

# The answer, then two chances to fix what the validators caught — the same
# budget as the transpiler. Past that the issues go to the caller (422).
MAX_ATTEMPTS = 3

# The docs are context, not the subject: the skeleton already says what exists.
# A capped total keeps the prompt well inside the window whatever the repo ships.
MAX_DOCS_CHARS = 60_000

# packages/schema/src/manifest/common.ts ID_PATTERN — the ids become node ids.
ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")

# "One plain sentence" with room for a second; the cap stops a paragraph
# arriving as two very long sentences.
MAX_DESCRIPTION_SENTENCES = 2
MAX_DESCRIPTION_CHARS = 300
MAX_SUMMARY_CHARS = 8_000

# A sentence ends at terminal punctuation followed by whitespace and something
# that can start a sentence. Mirrored in apps/api/src/lift/refine.ts — the two
# sides must agree on what they accept.
SENTENCE_BREAK = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")

# Entity kinds as the summary carries them, in prompt order.
KINDS = ("clients", "servers", "services", "agents", "processes")

# Bump whenever SYSTEM or the tool schema changes; it rides back with every
# answer so a refinement can be traced to the prompt that shaped it.
PROMPT_VERSION = "2"

REFINE_TOOL = {
    "name": "refine_skeleton",
    "description": "Rename, classify and describe the entities of the skeleton.",
    "input_schema": {
        "type": "object",
        "properties": {
            "renames": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": "Existing id -> clearer id, only where the current id is "
                "unclear. Omit ids that are fine as they are.",
            },
            "infrastructure": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Ids (after renames) of SERVICES that are cross-cutting "
                "plumbing — config, database, logging, auth guards — not product functionality.",
            },
            "descriptions": {
                "type": "object",
                "additionalProperties": {"type": "string"},
                "description": "Id (after renames) -> one plain sentence on what the entity does.",
            },
            "summary": {
                "type": "string",
                "description": "A few paragraphs of markdown on the system as a whole.",
            },
        },
        "required": ["renames", "infrastructure", "descriptions", "summary"],
    },
}

SYSTEM = """\
You are reading the skeleton of an existing codebase — every client app, \
server app, backend service, LLM agent and scheduled process a deterministic \
reader found in its code — beside the repo's own documentation. Civil will \
draw this skeleton as an architecture graph. Your job is to make that graph \
read the way the system's own authors talk about it.

You may:
- rename an entity whose id is unclear (a directory name, an abbreviation) to \
the name the docs and code use for it. Ids are lowercase letters, digits, \
hyphens and underscores, starting with a letter, at most 64 characters. A new \
id must not equal any other entity's id. Rename sparingly: a clear id stays.
- mark SERVICES that are cross-cutting plumbing (configuration, database \
access, logging, health checks, auth guards) as infrastructure. A service \
that serves routes (routes > 0), runs agents, or is a root is never \
infrastructure: it is what the product does.
- describe entities: one plain sentence each on what it does for the system, \
two at most.
- summarize the system in a few paragraphs of markdown: what it is for, how \
its parts fit, where the docs say it is going.

You may NOT add or remove entities, merge them, or name anything the skeleton \
does not contain. Infrastructure and descriptions use ids AFTER your renames. \
Where the docs and the code disagree, the code (the skeleton) is the truth.

Call refine_skeleton exactly once."""


class RefineValidationError(Exception):
    """Raised when the retry budget is spent with validators still complaining."""

    def __init__(self, issues: list[str], attempts: int) -> None:
        super().__init__(f"validation failed after {attempts} attempts")
        self.issues = issues
        self.attempts = attempts


def entity_ids(skeleton: dict[str, Any]) -> dict[str, set[str]]:
    """Id -> the kinds carrying it. A client and a service may share an id;
    a rename of that id renames both, which keeps every reference intact."""
    ids: dict[str, set[str]] = {}
    for kind in KINDS:
        for entity in skeleton.get(kind) or []:
            if isinstance(entity, dict) and isinstance(entity.get("id"), str):
                ids.setdefault(entity["id"], set()).add(kind)
    return ids


def select_docs(docs: dict[str, str]) -> tuple[list[tuple[str, str]], list[str]]:
    """README first, then docs in path order — a stable prompt for the same repo.
    A doc that would cross the cap is cut whole, never truncated mid-file, and
    named so the model (and the author, through the API's note) know it was."""
    order = sorted(docs, key=lambda p: (not p.lower().endswith("readme.md"), p.count("/"), p))
    included: list[tuple[str, str]] = []
    cut: list[str] = []
    total = 0
    for path in order:
        content = docs[path]
        if total + len(content) > MAX_DOCS_CHARS:
            cut.append(path)
            continue
        total += len(content)
        included.append((path, content))
    return included, cut


def _answer(tool_input: Any) -> dict[str, Any] | None:
    """The tool input, tolerating the double-encoding transpile.py documents in
    _files_list: a field (or the whole object) arriving as a JSON string, maybe
    trailed by a leaked scaffold token. raw_decode keeps the first value."""

    def decode(value: Any) -> Any:
        if not isinstance(value, str):
            return value
        try:
            decoded, _ = json.JSONDecoder().raw_decode(value.lstrip())
        except ValueError:
            return value
        return decoded

    tool_input = decode(tool_input)
    if not isinstance(tool_input, dict):
        return None
    answer = dict(tool_input)
    for key in ("renames", "infrastructure", "descriptions"):
        if key in answer:
            answer[key] = decode(answer[key])
    if isinstance(answer.get("summary"), str):
        answer["summary"] = plain_text(answer["summary"])
    return answer


def plain_text(text: str) -> str:
    """Prose as the model meant it. A summary sometimes arrives JSON-encoded —
    wrapped in quotes, its newlines written as backslash-n — and landing that
    verbatim puts one long line of escapes into architecture.md. Mirrors the API's
    plainText (apps/api/src/lift/refine.ts)."""
    out = text.strip()
    if len(out) >= 2 and out.startswith('"') and out.endswith('"'):
        try:
            decoded = json.loads(out)
        except ValueError:
            decoded = out[1:-1]
        if isinstance(decoded, str):
            out = decoded.strip()
    if "\n" not in out and "\\n" in out:
        out = out.replace("\\n", "\n").replace("\\t", "  ").replace('\\"', '"').strip()
    return out


def protected_services(skeleton: dict[str, Any]) -> set[str]:
    """Services the model may not call infrastructure: one that serves routes,
    runs agents, or is a deployment's root. Mirrors protectedServices in the API."""
    out: set[str] = set()
    for entry in skeleton.get("services") or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        routes = entry.get("routes")
        if (isinstance(routes, int) and routes > 0) or entry.get("agents") or entry.get("root"):
            out.add(entry["id"])
    return out


def _sentences(text: str) -> int:
    return len([part for part in SENTENCE_BREAK.split(text.strip()) if part])


def validate(answer: Any, skeleton: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """The answer normalized, and every way it oversteps. Normalized means: no-op
    renames dropped, and infrastructure/description keys given as an id the
    answer itself renamed away mapped to the new id — unambiguous, and cheaper
    than a retry."""
    if not isinstance(answer, dict):
        return {}, ["refine_skeleton input must be an object with renames, infrastructure, descriptions, summary"]

    issues: list[str] = []
    ids = entity_ids(skeleton)
    services = {e["id"] for e in skeleton.get("services") or [] if isinstance(e, dict)}
    guarded = protected_services(skeleton)

    renames_in = answer.get("renames", {})
    renames: dict[str, str] = {}
    if not isinstance(renames_in, dict):
        issues.append("renames must be an object mapping existing ids to new ids")
        renames_in = {}
    for old, new in renames_in.items():
        if not isinstance(new, str):
            issues.append(f"renames[{old!r}]: the new id must be a string")
        elif old not in ids:
            issues.append(f"renames: {old!r} is not an entity in the skeleton — rename only what exists")
        elif not ID_PATTERN.match(new):
            issues.append(
                f"renames[{old!r}]: {new!r} is not a valid id (lowercase letters, digits, "
                "hyphens and underscores, starting with a letter, max 64 chars)"
            )
        elif new != old:
            renames[old] = new

    # The distinct-id -> final-id map must stay one-to-one: a new id may not land
    # on an id that remains, nor on another rename's new id.
    final: dict[str, str] = {}
    for old in ids:
        target = renames.get(old, old)
        if target in final:
            issues.append(
                f"renames: {final[target]!r} and {old!r} would both be called {target!r} — ids must stay unique"
            )
        else:
            final[target] = old
    renamed_away = {old: new for old, new in renames.items() if old not in final}

    def resolve(name: str) -> str:
        return renamed_away.get(name, name)

    infra_in = answer.get("infrastructure", [])
    infrastructure: list[str] = []
    if not isinstance(infra_in, list):
        issues.append("infrastructure must be a list of service ids")
        infra_in = []
    for name in infra_in:
        if not isinstance(name, str):
            issues.append(f"infrastructure: {name!r} is not an id")
            continue
        name = resolve(name)
        if name not in final:
            issues.append(f"infrastructure: {name!r} is not an entity in the skeleton")
        elif final[name] not in services:
            issues.append(f"infrastructure: {name!r} is not a service — only services are infrastructure")
        elif final[name] in guarded:
            # Dropped, not refused: the reader's product class stands, and a retry
            # would spend a model call on a rule this side can apply itself.
            continue
        elif name not in infrastructure:
            infrastructure.append(name)

    desc_in = answer.get("descriptions", {})
    descriptions: dict[str, str] = {}
    if not isinstance(desc_in, dict):
        issues.append("descriptions must be an object mapping ids to one sentence")
        desc_in = {}
    for name, text in desc_in.items():
        key = resolve(name)
        if key not in final:
            issues.append(f"descriptions: {name!r} is not an entity in the skeleton (use ids after renames)")
        elif not isinstance(text, str) or not text.strip():
            issues.append(f"descriptions[{name!r}]: must be a non-empty sentence")
        elif "\n" in text.strip():
            issues.append(f"descriptions[{name!r}]: one or two sentences on one line, not a paragraph")
        elif len(text.strip()) > MAX_DESCRIPTION_CHARS or _sentences(text) > MAX_DESCRIPTION_SENTENCES:
            issues.append(
                f"descriptions[{name!r}]: one or two sentences, at most {MAX_DESCRIPTION_CHARS} characters"
            )
        else:
            descriptions[key] = text.strip()

    summary = answer.get("summary")
    if isinstance(summary, str):
        summary = plain_text(summary)
    if not isinstance(summary, str) or not summary.strip():
        issues.append("summary must be a few paragraphs of markdown")
        summary = ""
    elif len(summary) > MAX_SUMMARY_CHARS:
        issues.append(f"summary: a few paragraphs, at most {MAX_SUMMARY_CHARS} characters")

    refinement = {
        "renames": renames,
        "infrastructure": infrastructure,
        "descriptions": descriptions,
        "summary": summary.strip(),
    }
    return refinement, issues


def _prompt(skeleton: dict[str, Any], docs: dict[str, str]) -> tuple[str, list[str]]:
    included, cut = select_docs(docs)
    parts = [
        "The skeleton the reader found (JSON):\n\n" + json.dumps(skeleton, indent=1, sort_keys=True)
    ]
    if included:
        parts.append("The repo's own documentation follows.")
        for path, content in included:
            parts.append(f"--- {path} ---\n{content}")
    else:
        parts.append("The repo ships no documentation: judge from the skeleton alone.")
    if cut:
        parts.append("Not shown, for size: " + ", ".join(cut))
    return "\n\n".join(parts), cut


def refine(
    skeleton: dict[str, Any], docs: dict[str, str], client: Any, model: str
) -> dict[str, Any]:
    content, cut = _prompt(skeleton, docs)
    messages: list[dict[str, Any]] = [{"role": "user", "content": content}]
    issues: list[str] = []

    for attempt in range(1, MAX_ATTEMPTS + 1):
        response = client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=SYSTEM,
            messages=messages,
            tools=[REFINE_TOOL],
            tool_choice={"type": "tool", "name": "refine_skeleton"},
        )
        block = next((b for b in response.content if b.type == "tool_use"), None)
        if block is None:
            # tool_choice forces the call; its absence is the model failing.
            raise ValueError("the model reply carried no refine_skeleton call")
        if getattr(response, "stop_reason", None) == "max_tokens":
            raise ValueError(
                "the model hit the output ceiling mid-answer "
                f"(CIVIL_REFINE_MAX_TOKENS={MAX_TOKENS})"
            )

        refinement, issues = validate(_answer(block.input), skeleton)
        if not issues:
            return {
                "refinement": refinement,
                "attempts": attempt,
                "docsCut": cut,
                "promptVersion": PROMPT_VERSION,
            }

        messages.append({"role": "assistant", "content": response.content})
        messages.append({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": "Validation failed:\n- " + "\n- ".join(issues)
                + "\n\nCall refine_skeleton again with the complete corrected answer.",
                "is_error": True,
            }],
        })

    raise RefineValidationError(issues, MAX_ATTEMPTS)
