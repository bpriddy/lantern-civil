"""Interpretation: how an application thinks (flow) and what it is built on
(architecture), read from a codebase by agents (docs/interpretation.md).

Each request is one task: an analyst draws one diagram — a capability's flow, or one
angle of the architecture — or a synthesizer draws a view's overview from the diagrams
the analysts drew. A verifier then checks every node, edge and decision against the
code, shown them without their evidence. The API checks evidence mechanically, weighs
the verdicts, lays the diagram out and writes it; nothing here writes anywhere.

The prompts follow Civil's technical writing rules (imperative, one instruction per
sentence, terms defined once, checkable criteria, no emphasis, no reasons, lists); the
reasons live here. Their word budgets are tested.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from analyze import EVIDENCE, MAX_READS, Workspace, _decode, _loop, _EVIDENCE_SCHEMA

# Bump whenever a prompt or the diagram shape changes: the API memoises answers on it.
PROMPT_VERSION = "3"

ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")

FLOW_NODE_KINDS = ("actor", "trigger", "agent", "orchestrator", "guard", "step", "tools", "store", "output", "flow")
ARCHITECTURE_NODE_KINDS = ("client", "service", "worker", "datastore", "queue", "external", "platform", "concern")
FLOW_EDGE_KINDS = ("next", "uses")
ARCHITECTURE_EDGE_KINDS = ("uses", "calls", "hosts", "governs")

# A diagram is read at a glance or not at all: analysts keep to a whiteboard's worth.
MAX_NODES = {"analyst": 14, "synth": 20}

# Interpretation reads more than an area's analyst: it follows work across files.
TURNS = int(os.environ.get("CIVIL_INTERPRET_MAX_TURNS", "24"))

# A diagram is a long answer, and a model's thinking shares its token budget: too small
# a budget cut answers off before their edges (found live, 3 of 9 flows).
MAX_TOKENS = int(os.environ.get("CIVIL_INTERPRET_MAX_TOKENS", "20000"))

FLOW_TERMS = """\
Flow roles
- actor: a person or an outside system that starts work or receives a result.
- trigger: a schedule, a queue message, an event, or a webhook that starts work.
- agent: a model call that makes a judgement, with its prompt and tools.
- orchestrator: code or an agent that chooses which agents or steps run.
- guard: a check, a policy, an approval, or a limit that can stop work or send it back.
- step: deterministic work: fetch, transform, save, send.
- tools: a set of actions an agent may call.
- store: state that work reads or writes.
- output: what a person receives.
- flow: a capability's own flow, to step into.

Edges
- next: work passes on. The label says what passes, in 2 to 6 words.
- uses: a role reads a store or calls a tool."""

ARCHITECTURE_TERMS = """\
Architecture pieces
- client: an app people use.
- service: a backend that serves requests.
- worker: a backend that runs background work.
- datastore: a database, a cache, or a bucket.
- queue: where work waits.
- external: a third-party service or a model provider.
- platform: hosting, infrastructure as code, or CI.
- concern: a model that applies across pieces: auth, security, AI governance, observability.

Edges
- uses: a piece reads, writes, or depends on another.
- calls: a piece sends requests to another.
- hosts: a platform runs a piece.
- governs: a concern applies to a piece.

Decisions
- A decision is a choice that defines a piece: a framework, a library, a pattern, or a rule.
- Write the statement in one sentence.
- Add why only when the docs or the code say why."""

FLOW_ANALYST_SYSTEM = f"""\
You trace how one capability of an application works, for Civil. Read the code and \
docs with the tools. Call submit_diagram once.

{FLOW_TERMS}

Input
- The capability: its name, its paths, and the parts that implement it.

Tasks
1. Find each trigger: a route, a screen action, a job, or a schedule.
2. Follow the work from each trigger to its outcome. Draw a node for each role it \
passes through, and a next edge for each hand-off.
3. Name each role by what it does in the product, for example "Digest writer", not by \
its class name.
4. For each agent, write in its summary: one call or a tool loop; whether its output \
is validated against a schema; whether anything checks it before a person sees it.
5. Draw a guard for each check, approval, or limit, and the edge it sends work back on.
6. Set realizedBy to the ids of the parts that implement the role.
7. Draw a role the whole application shares, such as sign-in, the request guards, the \
job runner, or the model gateway, as one node named for it. Do not trace inside it.
8. Draw at most {MAX_NODES['analyst']} nodes. Merge minor steps into one step.
9. List each node's outgoing edges in its next field.

Rules
{EVIDENCE}
- Give every node except an actor at least one piece of evidence.
- Use kebab-case node ids.
- Call the application by the name in the input.
- Do not draw a function, a class, or a file as a node.

Budget: {TURNS} tool calls and {MAX_READS} file reads."""

ARCHITECTURE_ANALYST_SYSTEM = f"""\
You describe what an application is built on, for Civil, from one angle. Read the \
code and docs with the tools. Call submit_diagram once.

{ARCHITECTURE_TERMS}

Input
- The angle to describe.
- The fact sheet: each package's notable dependencies, the infrastructure resources, \
the images, the CI files, and the docs.
- The parts Civil found.

Tasks
1. Draw a node for each piece and concern in your angle.
2. Give each node its decisions, with evidence. Prefer the decisions a new engineer \
needs first.
3. Draw the edges between your nodes, in each node's next field.
4. Set realizedBy to the ids of the parts that implement the piece.
5. Draw at most {MAX_NODES['analyst']} nodes.

Rules
{EVIDENCE}
- Give every node and every decision at least one piece of evidence.
- Name node ids for the piece, in kebab-case: "api", "postgres", "auth".
- Do not draw a library as a node. A library is a decision of the piece that uses it.

Budget: {TURNS} tool calls and {MAX_READS} file reads."""

FLOW_SYNTH_SYSTEM = f"""\
You draw how an application works end to end, for Civil, from the capability flows \
other analysts traced. Read the code and docs with the tools to confirm. Call \
submit_diagram once.

{FLOW_TERMS}

Input
- The capability flows: each with its id, name, description, and roles.

Tasks
1. Draw one flow node for each capability flow, with ref set to its id.
2. Draw each role that several capabilities share once: an assistant, an \
orchestrator, a guard, a tool library, or a store.
3. Draw next edges for how work passes between capabilities and shared roles.
4. Draw the actors and triggers that start work, and the outputs people receive.
5. Draw at most {MAX_NODES['synth']} nodes.
6. List each node's outgoing edges in its next field.

Rules
{EVIDENCE}
- Give every node except an actor or a flow at least one piece of evidence.
- Use kebab-case node ids."""

ARCHITECTURE_SYNTH_SYSTEM = f"""\
You draw one overview of what an application is built on, for Civil, from angle \
diagrams other analysts drew. Read the code and docs with the tools to confirm. Call \
submit_diagram once.

{ARCHITECTURE_TERMS}

Input
- The angle diagrams: each with its id, name, nodes, decisions, and edges.

Tasks
1. Draw each piece once, merging the same piece from different angles.
2. Keep each piece's most important decisions, with their evidence. Keep at most 4 \
per piece.
3. Draw a concern node for the auth model and for the security model, with governs edges.
4. Set ref on a node to the angle diagram that describes it in more detail.
5. Draw at most {MAX_NODES['synth']} nodes.
6. List each node's outgoing edges in its next field.

Rules
{EVIDENCE}
- Give every node and every decision at least one piece of evidence.
- Use the node ids of the angle diagrams."""

VERIFIER_SYSTEM = f"""\
You check a diagram another analyst drew of a codebase. Read the code and docs with \
the tools for each item. Do not rely on the analyst's evidence. Call submit_verdicts \
once, with one verdict per item.

Items
- node: a role or a piece, with its kind, name, and summary.
- edge: what passes between two nodes.
- decision: a statement about a piece.

Verdicts
- support: the code or the docs show the item.
- refute: the code contradicts the item, or a node names a function, a class, or a \
file instead of a role or a piece.
- Refute an item the code and docs do not show.
- When the budget ends, submit the verdicts you have.

{EVIDENCE}"""

SUBMIT_DIAGRAM = {
    "name": "submit_diagram",
    "description": "Submit the diagram. Call exactly once, at the end. Put each node's outgoing edges in its next field.",
    "input_schema": {
        "type": "object",
        "properties": {
            "description": {"type": "string"},
            "nodes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "kind": {"type": "string"},
                        "name": {"type": "string"},
                        "summary": {"type": "string"},
                        "realizedBy": {"type": "array", "items": {"type": "string"}},
                        "evidence": _EVIDENCE_SCHEMA,
                        "decisions": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "statement": {"type": "string"},
                                    "why": {"type": "string"},
                                    "source": {"type": "string", "enum": ["code", "docs"]},
                                    "evidence": _EVIDENCE_SCHEMA,
                                },
                                "required": ["statement", "evidence"],
                            },
                        },
                        "ref": {"type": "string"},
                        "next": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "to": {"type": "string"},
                                    "kind": {"type": "string"},
                                    "label": {"type": "string"},
                                    "evidence": _EVIDENCE_SCHEMA,
                                },
                                "required": ["to", "kind"],
                            },
                        },
                    },
                    "required": ["id", "kind", "name"],
                },
            },
            "edges": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "from": {"type": "string"},
                        "to": {"type": "string"},
                        "kind": {"type": "string"},
                        "label": {"type": "string"},
                        "evidence": _EVIDENCE_SCHEMA,
                    },
                    "required": ["from", "to", "kind"],
                },
            },
        },
        "required": ["nodes", "edges"],
    },
}

SUBMIT_ITEM_VERDICTS = {
    "name": "submit_verdicts",
    "description": "Submit one verdict per item you were given. Call exactly once.",
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
                        "note": {"type": "string"},
                    },
                    "required": ["key", "verdict"],
                },
            }
        },
        "required": ["verdicts"],
    },
}


def _clip(text: str, most: int) -> str:
    """Shortened at a word, never mid-word."""
    text = text.strip()
    if len(text) <= most:
        return text
    cut = text[:most].rsplit(" ", 1)[0].rstrip(",;:")
    return cut + "…"


def _evidence(raw: Any, index: set[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for ev in _decode(raw) or []:
        if isinstance(ev, dict) and isinstance(ev.get("file"), str) and ev["file"] in index:
            entry: dict[str, Any] = {"file": ev["file"]}
            if isinstance(ev.get("line"), int) and ev["line"] > 0:
                entry["line"] = ev["line"]
            if isinstance(ev.get("quote"), str) and ev["quote"].strip():
                entry["quote"] = ev["quote"].strip()[:200]
            out.append(entry)
    return out[:5]


def validate_diagram(raw: Any, shape: str, role: str, index: set[str], refs: set[str]) -> tuple[dict[str, Any], list[str]]:
    """Keeps a well-formed diagram and says why the rest was dropped. Shape only — the
    API checks evidence against the code and weighs the verdicts."""
    issues: list[str] = []
    doc = _decode(raw) if not isinstance(raw, dict) else raw
    doc = doc if isinstance(doc, dict) else {}
    node_kinds = FLOW_NODE_KINDS if shape == "flow" else ARCHITECTURE_NODE_KINDS
    edge_kinds = FLOW_EDGE_KINDS if shape == "flow" else ARCHITECTURE_EDGE_KINDS
    nodes: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in _decode(doc.get("nodes")) or []:
        if not isinstance(item, dict):
            continue
        nid, kind, name = item.get("id"), item.get("kind"), item.get("name")
        if not isinstance(nid, str) or not ID_PATTERN.match(nid) or nid in seen:
            issues.append(f"node {str(nid)[:40]!r}: a missing, malformed or repeated id")
            continue
        if kind not in node_kinds or not isinstance(name, str) or not name.strip():
            issues.append(f"node {nid}: kind {kind!r} is not a {shape} kind, or it has no name")
            continue
        node: dict[str, Any] = {"id": nid, "kind": kind, "name": name.strip()[:80]}
        if isinstance(item.get("summary"), str) and item["summary"].strip():
            node["summary"] = _clip(item["summary"], 600)
        realized = [p for p in (_decode(item.get("realizedBy")) or []) if isinstance(p, str) and ID_PATTERN.match(p)]
        if realized:
            node["realizedBy"] = realized[:8]
        evidence = _evidence(item.get("evidence"), index)
        if evidence:
            node["evidence"] = evidence
        decisions = []
        for d in _decode(item.get("decisions")) or []:
            if not isinstance(d, dict) or not isinstance(d.get("statement"), str) or not d["statement"].strip():
                continue
            dec: dict[str, Any] = {"statement": _clip(d["statement"], 300), "evidence": _evidence(d.get("evidence"), index)}
            if isinstance(d.get("why"), str) and d["why"].strip():
                dec["why"] = _clip(d["why"], 300)
            if d.get("source") in ("code", "docs"):
                dec["source"] = d["source"]
            decisions.append(dec)
        if decisions:
            node["decisions"] = decisions[:6]
        ref = item.get("ref")
        if isinstance(ref, str) and ref in refs:
            node["ref"] = ref
        seen.add(nid)
        nodes.append(node)
    limit = MAX_NODES[role]
    if len(nodes) > limit:
        issues.append(f"{len(nodes)} nodes, more than {limit}: the rest were dropped")
        nodes = nodes[:limit]
    ids = {n["id"] for n in nodes}
    edges: list[dict[str, Any]] = []
    keys: set[str] = set()
    # Edges arrive inside each node (next), so an answer cut short loses only its tail;
    # a top-level list is read too.
    listed_edges = list(_decode(doc.get("edges")) or [])
    for item in _decode(doc.get("nodes")) or []:
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            for out in _decode(item.get("next")) or []:
                if isinstance(out, dict):
                    listed_edges.append({**out, "from": item["id"]})
    for item in listed_edges:
        if not isinstance(item, dict):
            continue
        a, b, kind = item.get("from"), item.get("to"), item.get("kind")
        if a not in ids or b not in ids or kind not in edge_kinds:
            issues.append(f"edge {a}->{b}: an end is not a node, or kind {kind!r} is not a {shape} kind")
            continue
        key = f"{a}->{b}:{kind}"
        if key in keys:
            continue
        keys.add(key)
        edge: dict[str, Any] = {"from": a, "to": b, "kind": kind}
        if isinstance(item.get("label"), str) and item["label"].strip():
            edge["label"] = item["label"].strip()[:60]
        evidence = _evidence(item.get("evidence"), index)
        if evidence:
            edge["evidence"] = evidence
        edges.append(edge)
    out: dict[str, Any] = {"nodes": nodes, "edges": edges}
    if isinstance(doc.get("description"), str) and doc["description"].strip():
        out["description"] = doc["description"].strip()[:400]
    return out, issues


def item_keys(diagram: dict[str, Any]) -> list[dict[str, Any]]:
    """What a verifier is shown: every node, edge and decision, without evidence."""
    items: list[dict[str, Any]] = []
    for n in diagram["nodes"]:
        items.append({"key": f"node:{n['id']}", "kind": n["kind"], "name": n["name"], **({"summary": n["summary"]} if "summary" in n else {})})
        for i, d in enumerate(n.get("decisions", [])):
            items.append({"key": f"decision:{n['id']}#{i}", "piece": n["name"], "statement": d["statement"]})
    for e in diagram["edges"]:
        items.append({"key": f"edge:{e['from']}->{e['to']}:{e['kind']}", "from": e["from"], "to": e["to"], **({"label": e["label"]} if "label" in e else {})})
    return items


def verify_diagram(client: Any, model: str, diagram: dict[str, Any], files: dict[str, str], index: list[str]) -> dict[str, Any]:
    items = item_keys(diagram)
    if not items:
        return {"verdicts": {}, "turns": 0, "reads": 0}
    ws = Workspace(files, index)
    prompt = "Items to check:\n" + json.dumps(items, indent=1)[:40_000]
    answer, turns = _loop(client, model, VERIFIER_SYSTEM, prompt, SUBMIT_ITEM_VERDICTS, ws, TURNS, MAX_TOKENS)
    known = {i["key"] for i in items}
    verdicts: dict[str, dict[str, str]] = {}
    for v in _decode((answer or {}).get("verdicts")) or []:
        if isinstance(v, dict) and v.get("key") in known and v.get("verdict") in ("support", "refute"):
            verdicts[v["key"]] = {"verdict": v["verdict"], **({"note": v["note"][:200]} if isinstance(v.get("note"), str) and v["note"] else {})}
    return {"verdicts": verdicts, "turns": turns, "reads": ws.reads}


def _task_prompt(task: dict[str, Any], ws: Workspace) -> str:
    """The analyst's or synthesizer's request: the task, what it covers, and what Civil
    already knows. Inputs are trimmed to stay a reasonable size."""
    sections = [f"Application: {task['product']}." if task.get("product") else "", f"Task: {task.get('title', task['id'])}."]
    if task.get("focus"):
        sections.append(f"Angle: {task['focus']}")
    if task.get("description"):
        sections.append(f"Described as: {task['description']}")
    prefixes = task.get("paths") or []
    if prefixes:
        inside = [p for p in ws.index if any(p == x or p.startswith(x) for x in prefixes)]
        sections.append("Paths:\n" + "\n".join(inside[:200]) + (f"\n… and {len(inside) - 200} more" if len(inside) > 200 else ""))
    if task.get("parts"):
        sections.append("Parts Civil found (id, kind):\n" + json.dumps(task["parts"])[:12_000])
    if task.get("facts"):
        sections.append("Fact sheet:\n" + json.dumps(task["facts"], indent=1)[:16_000])
    if task.get("inputs"):
        sections.append("Diagrams to work from:\n" + json.dumps(task["inputs"], indent=1)[:40_000])
    return "\n\n".join(x for x in sections if x)


def interpret(body: dict[str, Any], client: Any, model: str) -> dict[str, Any]:
    """One task: an analyst or a synthesizer draws a diagram, and a verifier checks it."""
    task: dict[str, Any] = body["task"]
    files: dict[str, str] = body["files"]
    index: list[str] = body.get("index") or sorted(files)
    shape = "flow" if task.get("shape") == "flow" else "architecture"
    role = "synth" if task.get("role") == "synth" else "analyst"
    system = {
        ("flow", "analyst"): FLOW_ANALYST_SYSTEM,
        ("architecture", "analyst"): ARCHITECTURE_ANALYST_SYSTEM,
        ("flow", "synth"): FLOW_SYNTH_SYSTEM,
        ("architecture", "synth"): ARCHITECTURE_SYNTH_SYSTEM,
    }[(shape, role)]
    ws = Workspace(files, index)
    answer, turns = _loop(client, model, system, _task_prompt(task, ws), SUBMIT_DIAGRAM, ws, TURNS, MAX_TOKENS)
    refs = {i["id"] for i in task.get("inputs") or [] if isinstance(i, dict) and isinstance(i.get("id"), str)}
    diagram, issues = validate_diagram(answer or {}, shape, role, set(ws.index), refs)
    checked = verify_diagram(client, model, diagram, files, index)
    return {
        "diagram": diagram,
        "verdicts": checked["verdicts"],
        "issues": issues,
        "turns": turns,
        "reads": ws.reads,
        "verifierTurns": checked["turns"],
        **({} if answer is not None else {"error": "no answer within the turn budget"}),
        "promptVersion": PROMPT_VERSION,
    }
