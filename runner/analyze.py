"""Codebase analysis by agents: analysts propose claims, verifiers try to refute them,
and an architect reviews the whole domain tree.

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
PROMPT_VERSION = "6"

MAX_TOKENS = int(os.environ.get("CIVIL_ANALYZE_MAX_TOKENS", "8192"))
MAX_TURNS = int(os.environ.get("CIVIL_ANALYZE_MAX_TURNS", "14"))
MAX_READS = int(os.environ.get("CIVIL_ANALYZE_MAX_READS", "40"))
CONCURRENCY = int(os.environ.get("CIVIL_ANALYZE_CONCURRENCY", "4"))
READ_MAX_LINES = 400
READ_MAX_CHARS = 24_000
LIST_MAX = 300
SEARCH_MAX = 60

ENTITY_KINDS = ("server", "client", "service", "agent", "process", "datastore", "domain")
RELATION_KINDS = ("depends-on", "exposes", "calls", "uses-agent", "contains")
KINDS = ENTITY_KINDS + RELATION_KINDS
ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
ATTR_KEYS = {"files", "description", "name", "foundation", "label", "framework", "path", "schedule", "tools", "engine"}

# Levels a domain may hold before the architect is asked to group it (containment.ts).
MAX_CHILDREN = 12

# The prompts follow Civil's technical writing rules: imperative, one instruction per
# sentence, each term defined once with the schema's word, checkable criteria, no
# emphasis, no reasons (they live here, in comments), lists over prose. Their word
# budgets are tested (tests/test_analyze.py).

TERMS = """\
Terms
- server: a deployable backend process.
- client: a frontend app.
- service: server code with product behaviour, larger than one class.
- agent: a model call with a prompt, and optionally tools.
- process: work the deployed application starts on a schedule, a queue, or an event. \
CI and deploy pipelines are not processes.
- datastore: a database, cache, bucket, queue, or topic.
- domain: members Civil draws as one level. A capability domain holds a product \
feature and its services. A foundation domain holds code that several capabilities use.
- member: a service, process, datastore, or domain inside a domain.

Relations
- depends-on: service to a service or datastore it uses.
- exposes: server to a service it serves.
- calls: client to a server; process to a service it runs; service to another server.
- uses-agent: service to an agent its code calls.
- contains: domain to a member."""

EVIDENCE = """\
Evidence
- Cite each claim: the path as listed, the line number from read_file, and a quote \
copied from that line.
- Omit a claim you cannot cite."""

ANALYST_SYSTEM = f"""\
You analyse one area of a codebase for Civil. Read the code with the tools. Call \
submit_claims once.

{TERMS}

Input
- The area: its paths. When the area is a domain: its id, name, members, and unsure members.
- The reader's claims about these paths.

Tasks
1. When the area is a domain, claim the domain with attrs.name in 1 to 3 words. Use the \
module or folder name if one exists.
2. Add attrs.description: one sentence on what the domain does for the user.
3. For each unsure member, claim contains from the domain that holds it. Omit the claim \
if the code does not show which domain.
4. Claim each agent, process, and datastore in the area. When the area is a domain, \
claim contains from the domain to each process, and to each datastore no other domain uses.
5. Claim calls for each call to another server. Cite the URL, client, or queue name.
6. Refute a reader claim that the code contradicts, for example a test double.
7. Refute the domain if it is test code, example code, or tooling.

Rules
{EVIDENCE}
- Use the reader's ids. Give a new entity a kebab-case id from its directory or module.
- Claim a new datastore only where it is declared: infrastructure code or an ORM config.
- Do not claim routes, endpoints, functions, or classes.
- Do not claim code in example, sample, or demo projects.
- Attributes: files, description, label, framework, path, schedule (cron), tools \
([{{"name","file"}}]), engine; name and foundation for a domain.

Budget: {MAX_TURNS} tool calls and {MAX_READS} file reads."""

VERIFIER_SYSTEM = f"""\
You check claims another analyst made about a codebase. Read the code with the tools \
for each claim. Do not rely on the analyst's evidence. Call submit_verdicts once, with \
one verdict per claim.

Verdicts
- support: the code shows the claim.
- refute: the code contradicts the claim, the claim names a route or a function, or \
the code is a test double or an example.
- Refute a claim the code does not show.
- When the budget ends, submit the verdicts you have.

{TERMS}

{EVIDENCE}"""

ARCHITECT_SYSTEM = f"""\
You review the domain tree Civil drew for a codebase. Read the repository's docs \
(README.md, docs/) first: they may name the product's parts. Read the code with the \
tools. Call submit_claims once.

{TERMS}

Input: the concept view's tree: services, processes, and datastores. Clients and \
servers are not in this view. Each domain has an id, a name, a description, and its \
unsure members. A level marked over holds more than \
{MAX_CHILDREN} members.

Tasks
1. Bring each level marked over to {MAX_CHILDREN} members or fewer. Group related \
members: claim contains from an existing domain, or propose a domain (claim it with \
attrs.name) and claim contains to each of its members.
2. Claim contains to move a member to its domain.
3. Merge two domains that implement one product feature: claim contains from one to \
each member of the other, and refute the other.
4. Claim the domain with attrs.foundation true when most other domains depend on it.
5. Refute a domain whose members share no feature, data, or caller.

Rules
{EVIDENCE}
- For contains, cite code or docs that tie the member to the domain: an import, a call, \
or a description.
- For a proposed domain, cite a file of one of its members.
- Use the ids in the tree. Give a new domain a kebab-case id that ends in -domain.
- Do not rename a domain in the tree."""

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


def _loop(client: Any, model: str, system: str, prompt: str, submit: dict, ws: Workspace,
          turns: int | None = None) -> tuple[dict | None, int]:
    """A bounded tool loop that ends in one forced call to `submit`."""
    limit = turns or MAX_TURNS
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
    for turn in range(1, limit + 1):
        final = turn == limit or ws.reads >= MAX_READS
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
    return None, limit


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
    domain = area.get("domain")
    described = (
        "Domain:\n" + json.dumps({k: domain[k] for k in ("id", "name", "members", "unsure", "surfaces") if k in domain}, indent=1)
        if isinstance(domain, dict) else "Domain: none. Skip tasks 1 to 3 and 7."
    )
    return (
        f"Area: {area.get('title', area['id'])}. Paths: {', '.join(prefixes) or 'the whole repository'}.\n"
        f"{area.get('hint', '')}\n\n{described}\n\nFiles:\n{listing}\n\n"
        "Reader claims:\n"
        + (json.dumps(concerning, indent=1)[:20_000] if concerning else "none")
        + "\n\nRead files outside the area to follow an import."
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
           files: dict[str, str], index: list[str], turns: int | None = None) -> dict[str, Any]:
    """One verifier over one analyst's claims: a verdict per claim, as new claims."""
    ws = Workspace(files, index)
    by = f"verifier:{label}"
    shown = [{"key": claim_key(c), **{k: c[k] for k in ("kind", "subject", "object", "attrs", "note") if k in c}} for c in claims]
    prompt = "Claims to check:\n" + json.dumps(shown, indent=1)[:30_000] + "\n\nCheck each against the code, then submit_verdicts."
    answer, turns = _loop(client, model, VERIFIER_SYSTEM, prompt, SUBMIT_VERDICTS, ws, turns)
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


# The architect reads across the whole tree, so it gets a larger budget than an area.
ARCHITECT_TURNS = int(os.environ.get("CIVIL_ARCHITECT_MAX_TURNS", "28"))


def architect(client: Any, model: str, tree: Any, files: dict[str, str], index: list[str]) -> dict[str, Any]:
    """One review of the whole domain tree: the questions no single area's analyst can
    answer (which domain a member belongs to across areas, what to merge, how to group an
    overfull level). Its claims are verified like an analyst's."""
    ws = Workspace(files, index)
    levels = tree.get("levels", []) if isinstance(tree, dict) else []
    over = [f"{lv.get('domain') or 'top'} ({len(lv.get('members', []))} members)" for lv in levels if lv.get("over")]
    prompt = (
        ("Levels over the limit: " + ", ".join(over) + ".\n\n" if over else "")
        + "Tree:\n" + json.dumps(tree, indent=1)[:40_000]
    )
    answer, turns = _loop(client, model, ARCHITECT_SYSTEM, prompt, SUBMIT_CLAIMS, ws, ARCHITECT_TURNS)
    claims, issues = validate_claims((answer or {}).get("claims"), set(ws.index), "architect:tree")
    checked = [c for c in claims if c["stance"] == "assert"]
    # A whole tree's claims take longer to check than an area's: the verifier gets the
    # architect's budget.
    verified = verify(client, model, "architect", checked, files, index, ARCHITECT_TURNS) if checked else {"claims": [], "issues": []}
    return {
        "claims": claims + verified["claims"],
        "areas": [{"area": "architect", "turns": turns, "reads": ws.reads, "issues": issues,
                   **({} if answer is not None else {"error": "no answer within the turn budget"})}],
        "verifiers": [{k: verified[k] for k in ("label", "turns", "reads", "issues") if k in verified}] if checked else [],
        "promptVersion": PROMPT_VERSION,
    }


def analyze(body: dict[str, Any], client: Any, model: str) -> dict[str, Any]:
    """Every area's analyst, then a verifier per analyst, concurrently and bounded. With
    mode "architect", the one review of the whole tree instead."""
    if body.get("mode") == "architect":
        return architect(client, model, body.get("tree"), body["files"], body.get("index") or sorted(body["files"]))
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
