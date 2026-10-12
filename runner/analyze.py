"""Codebase analysis by agents: analysts propose claims, verifiers try to refute them.

The repo lift's agent stage (docs/lift-repo.md, "Claims"). The API's deterministic
reader has already restated what it found as claims; this module adds independent
voices. Each **analyst** is given one area of the repository and read-only tools
(list, read, search) over the files the API sent, and proposes claims at the canvas's
altitude — supporting, refuting, or adding to the reader's. Each **verifier** is shown
only another voice's claims and the same tools, and is asked to check every one
against the code. Weighing is not done here: the API's claims.ts is the one place
beliefs are formed, so every voice is treated by the same rules.

Nothing here executes the repository's code or writes anywhere: the files arrive in
the request and the only output is claims.
"""

from __future__ import annotations

import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any

# Bump whenever a prompt or tool changes: the API keys memoised analyses on it.
PROMPT_VERSION = "2"

MAX_TOKENS = int(os.environ.get("CIVIL_ANALYZE_MAX_TOKENS", "8192"))
MAX_TURNS = int(os.environ.get("CIVIL_ANALYZE_MAX_TURNS", "14"))
MAX_READS = int(os.environ.get("CIVIL_ANALYZE_MAX_READS", "40"))
CONCURRENCY = int(os.environ.get("CIVIL_ANALYZE_CONCURRENCY", "4"))
READ_MAX_LINES = 400
READ_MAX_CHARS = 24_000
LIST_MAX = 300
SEARCH_MAX = 60

ENTITY_KINDS = ("server", "client", "service", "agent", "process")
RELATION_KINDS = ("depends-on", "exposes", "calls", "uses-agent")
KINDS = ENTITY_KINDS + RELATION_KINDS
ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
ATTR_KEYS = {"files", "description", "group", "label", "framework", "path", "schedule", "tools"}

ALTITUDE = """\
Civil draws an application's ARCHITECTURE, not its functions. Claims are made at this \
altitude only:
- server: a deployable backend (an HTTP/API process, a worker, a job runner) — one \
per distinct process the code can be deployed as.
- client: a frontend app (web, mobile) the user runs.
- service: a medium-to-large unit of product functionality inside a server — a \
feature module or subsystem (e.g. "billing", "search"), never a single function, \
helper, or class.
- agent: an LLM agent the code defines (a prompt plus a model call, often with tools).
- process: background work on a schedule or trigger (cron jobs, scheduled tasks, \
queue consumers) — not every function a worker can run.
Relations: depends-on (service → service it uses), exposes (server → service it \
serves over its API), calls (client → server it talks to; process → service it runs), \
uses-agent (service → agent its code invokes).
Calls BETWEEN deployables matter most and are easy to miss: when code in one server \
calls another server — over HTTP (a fetch or client to another service's URL), RPC, \
or a queue — claim depends-on from the calling service to the service that answers, \
even though they run in different processes. Cite the call site (the URL, client, or \
queue name) as evidence.
Routes, operations, endpoints and functions are NEVER claims; mention them only as \
evidence. Infrastructure plumbing (config, logging, database clients, auth guards, \
health checks) is not a service unless it is product functionality."""

EVIDENCE_RULES = """\
Every claim MUST cite evidence: the file path exactly as listed, the 1-based line \
number shown by read_file, and a short quote copied EXACTLY from that line (or the \
lines right around it). Evidence is checked mechanically; a misquoted line counts \
for nothing. Prefer the line that most directly shows the claim (a module \
declaration, a bootstrap call, an import, an agent definition)."""

ANALYST_SYSTEM = f"""\
You are one of several independent analysts reading a codebase so Civil can draw its \
architecture. You are given one AREA of the repository. Read it with the tools, then \
call submit_claims once.

{ALTITUDE}

{EVIDENCE_RULES}

Civil's deterministic reader has already made some claims, listed in the request. \
For each that concerns your area: if the code supports it, repeat it (same kind, \
subject, object) with your OWN evidence — that is independent confirmation; if the \
code contradicts it (for example, a "service" that is only a test helper, or an \
"agent" that is a fake), submit it with stance "refute" and evidence showing why. \
Example, sample, and demo projects bundled in the repository are not the product: \
never claim anything from them. \
Then add what the reader missed, especially agents, background work, and services \
it could not see. Use the reader's ids for things it found; for new things use \
short kebab-case ids from the directory or module name. When unsure, leave it out — \
a missing claim costs less than a wrong one.

Attributes (optional, on entity claims): files (the paths implementing it, \
directories as "dir/**"), description (one plain sentence on what it does for the \
product), group (a 2–4 word name of the larger subsystem it belongs to, shared by \
related services), label, framework, path, schedule (cron), tools \
([{{"name","file"}}] for an agent).

Budget: about {MAX_TURNS} tool calls and {MAX_READS} file reads. Read what tells you \
the most: entry points, module and registry files, agent definitions, schedulers."""

VERIFIER_SYSTEM = f"""\
You are a skeptical verifier. Another analyst proposed the claims below about a \
codebase. For EACH claim, check it against the code with the tools — do not trust its \
cited evidence; read the code yourself — then call submit_verdicts once with a \
verdict per claim: "support" (the code clearly shows it, at this altitude) or \
"refute" (it is wrong, below the altitude, a test helper, or not shown by the code). \
When in doubt, refute.

{ALTITUDE}

{EVIDENCE_RULES}"""

_EVIDENCE_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "file": {"type": "string"},
            "line": {"type": "integer"},
            "quote": {"type": "string"},
        },
        "required": ["file", "line", "quote"],
    },
}

TOOLS = [
    {
        "name": "list_paths",
        "description": "List repository paths under a prefix (directory). Empty prefix lists from the root.",
        "input_schema": {"type": "object", "properties": {"prefix": {"type": "string"}}, "required": ["prefix"]},
    },
    {
        "name": "read_file",
        "description": "Read a file with 1-based line numbers. Optionally a line range.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "from_line": {"type": "integer"},
                "to_line": {"type": "integer"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "search",
        "description": "Search file contents with a regular expression, optionally under a path prefix. Returns path:line: text.",
        "input_schema": {
            "type": "object",
            "properties": {"pattern": {"type": "string"}, "prefix": {"type": "string"}},
            "required": ["pattern"],
        },
    },
]

SUBMIT_CLAIMS = {
    "name": "submit_claims",
    "description": "Submit your claims about this area. Call exactly once, at the end.",
    "input_schema": {
        "type": "object",
        "properties": {
            "claims": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "kind": {"type": "string", "enum": list(KINDS)},
                        "subject": {"type": "string"},
                        "object": {"type": "string"},
                        "stance": {"type": "string", "enum": ["assert", "refute"]},
                        "attrs": {"type": "object"},
                        "evidence": _EVIDENCE_SCHEMA,
                        "note": {"type": "string"},
                    },
                    "required": ["kind", "subject", "stance", "evidence"],
                },
            }
        },
        "required": ["claims"],
    },
}

SUBMIT_VERDICTS = {
    "name": "submit_verdicts",
    "description": "Submit one verdict per claim you were given. Call exactly once.",
    "input_schema": {
        "type": "object",
        "properties": {
            "verdicts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": {"type": "string"},
                        "verdict": {"type": "string", "enum": ["support", "refute"]},
                        "evidence": _EVIDENCE_SCHEMA,
                        "note": {"type": "string"},
                    },
                    "required": ["key", "verdict", "evidence"],
                },
            }
        },
        "required": ["verdicts"],
    },
}


def claim_key(claim: dict[str, Any]) -> str:
    """The same key claims.ts uses, so a verdict names the claim it judges."""
    obj = claim.get("object")
    return f"{claim['kind']}:{claim['subject']}" + (f"->{obj}" if obj else "")


class Workspace:
    """The repository as the request gave it: read-only, in memory, bounded."""

    def __init__(self, files: dict[str, str], index: list[str]) -> None:
        self.files = files
        self.index = sorted(set(index) | set(files))
        self.reads = 0

    def list_paths(self, prefix: str) -> str:
        prefix = prefix.strip().lstrip("./")
        hits = [p for p in self.index if p.startswith(prefix)]
        more = f"\n… and {len(hits) - LIST_MAX} more" if len(hits) > LIST_MAX else ""
        return "\n".join(hits[:LIST_MAX]) + more if hits else f"(nothing under {prefix!r})"

    def read_file(self, path: str, from_line: int | None = None, to_line: int | None = None) -> str:
        content = self.files.get(path)
        if content is None:
            return f"(not readable: {path} — {'listed but not sent' if path in self.index else 'no such file'})"
        self.reads += 1
        lines = content.split("\n")
        start = max(1, from_line or 1)
        end = min(len(lines), to_line or start + READ_MAX_LINES - 1, start + READ_MAX_LINES - 1)
        out = "\n".join(f"{n}: {lines[n - 1]}" for n in range(start, end + 1))
        if len(out) > READ_MAX_CHARS:
            out = out[:READ_MAX_CHARS] + "\n… (truncated; read a narrower range)"
        tail = f"\n… ({len(lines)} lines; read from_line={end + 1} for more)" if end < len(lines) else ""
        return out + tail

    def search(self, pattern: str, prefix: str = "") -> str:
        try:
            rx = re.compile(pattern)
        except re.error as error:
            return f"(bad pattern: {error})"
        hits: list[str] = []
        for path in sorted(self.files):
            if not path.startswith(prefix):
                continue
            for n, line in enumerate(self.files[path].split("\n"), 1):
                if rx.search(line):
                    hits.append(f"{path}:{n}: {line.strip()[:200]}")
                    if len(hits) >= SEARCH_MAX:
                        return "\n".join(hits) + "\n… (more; narrow the pattern or prefix)"
        return "\n".join(hits) or "(no matches)"

    def run(self, name: str, args: dict[str, Any]) -> str:
        if name == "list_paths":
            return self.list_paths(str(args.get("prefix", "")))
        if name == "read_file":
            if self.reads >= MAX_READS:
                return "(read budget spent — submit now)"
            return self.read_file(str(args.get("path", "")), args.get("from_line"), args.get("to_line"))
        if name == "search":
            return self.search(str(args.get("pattern", "")), str(args.get("prefix", "")))
        return f"(unknown tool {name})"


def _loop(client: Any, model: str, system: str, prompt: str, submit: dict, ws: Workspace) -> tuple[dict | None, int]:
    """A bounded tool loop that ends in one forced call to `submit`."""
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
    for turn in range(1, MAX_TURNS + 1):
        final = turn == MAX_TURNS or ws.reads >= MAX_READS
        response = client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=messages,
            tools=[*TOOLS, submit],
            tool_choice={"type": "tool", "name": submit["name"]} if final else {"type": "auto"},
        )
        uses = [b for b in response.content if getattr(b, "type", "") == "tool_use"]
        done = next((b for b in uses if b.name == submit["name"]), None)
        if done is not None:
            return (done.input if isinstance(done.input, dict) else None), turn
        if not uses:
            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": f"Call {submit['name']} now with your answer."})
            continue
        messages.append({"role": "assistant", "content": response.content})
        messages.append({
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": b.id, "content": ws.run(b.name, b.input or {})}
                for b in uses
            ],
        })
    return None, MAX_TURNS


def _decode(value: Any) -> Any:
    """Tolerates the model's occasional double-encoding of an array argument."""
    if isinstance(value, str):
        try:
            return json.JSONDecoder().raw_decode(value.lstrip())[0]
        except ValueError:
            return None
    return value


def validate_claims(raw: Any, index: set[str], by: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Keeps well-formed claims and says why the rest were dropped. Shape only — the
    API checks evidence against the code and does the weighing."""
    claims: list[dict[str, Any]] = []
    issues: list[str] = []
    for item in _decode(raw) or []:
        if not isinstance(item, dict):
            issues.append(f"not an object: {str(item)[:80]}")
            continue
        kind, subject, obj = item.get("kind"), item.get("subject"), item.get("object")
        if kind not in KINDS or not isinstance(subject, str) or not ID_PATTERN.match(subject):
            issues.append(f"bad kind or subject: {kind!r} {subject!r}")
            continue
        if kind in RELATION_KINDS and (not isinstance(obj, str) or not ID_PATTERN.match(obj)):
            issues.append(f"{kind}:{subject}: a relation needs a valid object")
            continue
        evidence = []
        for ev in _decode(item.get("evidence")) or []:
            if isinstance(ev, dict) and isinstance(ev.get("file"), str) and ev["file"] in index:
                entry: dict[str, Any] = {"file": ev["file"]}
                if isinstance(ev.get("line"), int) and ev["line"] > 0:
                    entry["line"] = ev["line"]
                if isinstance(ev.get("quote"), str) and ev["quote"].strip():
                    entry["quote"] = ev["quote"].strip()[:200]
                evidence.append(entry)
        if not evidence:
            issues.append(f"{kind}:{subject}: no evidence in a listed file")
            continue
        claim: dict[str, Any] = {
            "kind": kind,
            "subject": subject,
            "stance": "refute" if item.get("stance") == "refute" else "assert",
            "evidence": evidence[:5],
            "by": by,
        }
        if kind in RELATION_KINDS:
            claim["object"] = obj
        attrs = _decode(item.get("attrs"))
        if isinstance(attrs, dict) and kind in ENTITY_KINDS:
            kept = {k: v for k, v in attrs.items() if k in ATTR_KEYS}
            if kept:
                claim["attrs"] = kept
        if isinstance(item.get("note"), str) and item["note"].strip():
            claim["note"] = item["note"].strip()[:300]
        claims.append(claim)
    return claims, issues


def _area_prompt(area: dict[str, Any], reader_claims: list[dict[str, Any]], ws: Workspace) -> str:
    prefixes = area.get("prefixes") or []
    inside = [p for p in ws.index if any(p.startswith(x) for x in prefixes)]
    concerning = [
        c for c in reader_claims
        if any(any(ev.get("file", "").startswith(x) for x in prefixes) for ev in c.get("evidence", []))
    ]
    listing = "\n".join(inside[:LIST_MAX]) + (f"\n… and {len(inside) - LIST_MAX} more" if len(inside) > LIST_MAX else "")
    return (
        f"AREA: {area.get('title', area['id'])} — paths under {', '.join(prefixes) or '(the whole repository)'}\n"
        f"{area.get('hint', '')}\n\nFiles in this area:\n{listing}\n\n"
        "The reader's claims touching this area (kind, subject, object, evidence):\n"
        + (json.dumps(concerning, indent=1)[:20_000] if concerning else "(none — the reader saw nothing here)")
        + "\n\nYou may read files outside the area when following an import. Read, then submit_claims."
    )


def analyze_area(client: Any, model: str, area: dict[str, Any], reader_claims: list[dict[str, Any]],
                 files: dict[str, str], index: list[str]) -> dict[str, Any]:
    ws = Workspace(files, index)
    by = f"analyst:{area['id']}"
    answer, turns = _loop(client, model, ANALYST_SYSTEM, _area_prompt(area, reader_claims, ws), SUBMIT_CLAIMS, ws)
    claims, issues = validate_claims((answer or {}).get("claims"), set(ws.index), by)
    return {"area": area["id"], "claims": claims, "issues": issues, "turns": turns, "reads": ws.reads,
            **({} if answer is not None else {"error": "no answer within the turn budget"})}


def verify(client: Any, model: str, label: str, claims: list[dict[str, Any]],
           files: dict[str, str], index: list[str]) -> dict[str, Any]:
    """One verifier over one analyst's claims: a verdict per claim, as new claims."""
    ws = Workspace(files, index)
    by = f"verifier:{label}"
    shown = [{"key": claim_key(c), **{k: c[k] for k in ("kind", "subject", "object", "attrs", "note") if k in c}} for c in claims]
    prompt = "Claims to check:\n" + json.dumps(shown, indent=1)[:30_000] + "\n\nCheck each against the code, then submit_verdicts."
    answer, turns = _loop(client, model, VERIFIER_SYSTEM, prompt, SUBMIT_VERDICTS, ws)
    by_key = {claim_key(c): c for c in claims}
    out: list[dict[str, Any]] = []
    issues: list[str] = []
    for v in _decode((answer or {}).get("verdicts")) or []:
        if not isinstance(v, dict) or v.get("key") not in by_key:
            issues.append(f"verdict for an unknown claim: {str(v)[:80]}")
            continue
        target = by_key[v["key"]]
        raw = {**{k: target[k] for k in ("kind", "subject", "object") if k in target},
               "stance": "refute" if v.get("verdict") == "refute" else "assert",
               "evidence": v.get("evidence"), "note": v.get("note")}
        kept, problems = validate_claims([raw], set(ws.index), by)
        out.extend(kept)
        issues.extend(problems)
    return {"label": label, "claims": out, "issues": issues, "turns": turns, "reads": ws.reads}


def analyze(body: dict[str, Any], client: Any, model: str) -> dict[str, Any]:
    """Every area's analyst, then a verifier per analyst, concurrently and bounded."""
    files: dict[str, str] = body["files"]
    index: list[str] = body.get("index") or sorted(files)
    reader_claims: list[dict[str, Any]] = body.get("claims") or []
    areas: list[dict[str, Any]] = body["areas"]
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        analysed = list(pool.map(lambda a: analyze_area(client, model, a, reader_claims, files, index), areas))
        to_verify = [(r["area"], [c for c in r["claims"] if c["stance"] == "assert"]) for r in analysed]
        verified = list(pool.map(
            lambda pair: verify(client, model, pair[0], pair[1], files, index) if pair[1] else
            {"label": pair[0], "claims": [], "issues": [], "turns": 0, "reads": 0},
            to_verify,
        ))
    return {
        "claims": [c for r in analysed for c in r["claims"]] + [c for r in verified for c in r["claims"]],
        "areas": [{k: r[k] for k in ("area", "turns", "reads", "issues", "error") if k in r} for r in analysed],
        "verifiers": [{k: r[k] for k in ("label", "turns", "reads", "issues") if k in r} for r in verified],
        "promptVersion": PROMPT_VERSION,
    }
