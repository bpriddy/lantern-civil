"""The generative transpiler: civil documents in, ordinary repo code out.

Implements docs/emitted-code.md. Emission is structured output — one forced
emit_files tool call per attempt, never text parsing — checked by deterministic
validators whose complaints go back to the model for up to two retries. The
validators hold the contract's hard lines (no vendor SDKs, Engine at module
level, straight-line run() bodies, no collisions with files owned elsewhere,
a boundary server whenever the composition declares an api boundary);
everything softer rides in the prompt, where the pattern helper prompt speaks
for the repo's own conventions.
"""

from __future__ import annotations

import ast
import json
import os
import re
from typing import Any

# 16384 truncated a real project's emission mid-tool-call (civil-project-test,
# 2026-08-22); streaming lifts the SDK's 10-minute non-streaming ceiling, so the
# default errs high — actual cost follows actual output, not the cap.
MAX_TOKENS = int(os.environ.get("CIVIL_TRANSPILE_MAX_TOKENS", "32768"))

# Three attempts total: the emission, then two chances to fix what the
# validators caught. Past that the issues go to the caller, honestly (422).
MAX_ATTEMPTS = 3

# Vendor lock at the call site is exactly what the Engine facade exists to
# prevent (docs/emitted-code.md, "Agents"). Matched by module root, so
# google.generativeai.types is google.generativeai's — but google.cloud is not.
# fastapi and uvicorn stay off this list on purpose: the boundary server is
# the app's own dependency, the strong-engineer default — not a vendor lock.
VENDOR_MODULES = {
    "anthropic",
    "cohere",
    "google.genai",
    "google.generativeai",
    "groq",
    "litellm",
    "mistralai",
    "ollama",
    "openai",
}
VENDOR_CLASS_NAMES = ("ClaudeEngine", "AnthropicEngine", "OpenAIEngine")

# The role vocabulary the session derives processes from: boundary-server
# files become supervised processes; everything else is classification only.
ROLES = ("agent", "orchestration", "boundary-server", "other")

# Every emitted file names the unit it implements (civil/registry.yaml): the API
# derives the unit list from the documents and sends it; this is the one label
# outside that list, for plumbing that serves several units (a package __init__.py).
SHARED_UNIT = "shared"

EMIT_FILES_TOOL = {
    "name": "emit_files",
    "description": "Emit the complete set of transpiled files for this repository.",
    "input_schema": {
        "type": "object",
        "properties": {
            "files": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string", "description": "Repo-relative path."},
                        "content": {"type": "string", "description": "The complete file content."},
                        "role": {
                            "type": "string",
                            "enum": list(ROLES),
                            "description": "What the file is at the architecture's altitude; omitted means other.",
                        },
                        "unit": {
                            "type": "string",
                            "description": "The id of the unit this file implements, from the unit "
                            f"list in the request; \"{SHARED_UNIT}\" for a file serving several.",
                        },
                    },
                    "required": ["path", "content"],
                },
            }
        },
        "required": ["files"],
    },
}

# The API folds this into its transpile memo hash alongside the resolved model
# id (GET /transpile/meta): bump it whenever SYSTEM_TEMPLATE or the emit_files
# schema changes, or memoized emissions will outlive the prompt that shaped them.
PROMPT_VERSION = "10"

SYSTEM_TEMPLATE = """\
You are Civil's transpiler. You read civil graph documents and emit the \
ordinary Python a strong engineer would hand-write for exactly this \
application — code that reads as if the repo's author wrote it, in files the \
author would have created.

The emitted code contract:

- An agent node becomes a plain function written against the Engine facade: \
`from civil_runtime.engines import Engine`. The engine is constructed at \
module level with literal kwargs — today always \
`engine = Engine(model="{default_model}")`, the resolved model id (Claude, \
the default; other vendor kinds arrive in the library later) — so the \
configuration is data on one line the user edits afterward. The function \
invokes it as \
`engine.run(system=..., user=..., tools=[...], max_turns=<n>)`, where \
max_turns is the agent's turn budget, a literal int defaulting to 8 (edit \
the literal to change it), and gets back a Reply: `.text` is the final text, \
`.json()` the conclusion parsed as data. Serialize structured user content \
with json.dumps, not str(). NEVER import anthropic, openai, or any other \
vendor SDK in emitted files, and never invent vendor-named classes — Engine \
is the only surface.
- Each graph document becomes an orchestration module whose `run()` body is \
straight-line — assignments, calls, a return — mapping the graph's flow edges \
in topological order. No conditionals or loops standing in for control flow \
the graph does not express.
- A composition document (app.yaml / civil.yaml) turns each boundary node of \
the api kind into ONE boundary server file: a FastAPI app exposing every \
entry in the node's exposes list as POST /<name> — JSON body in, JSON result \
out — importing and calling the real service function or graph run() from \
the other emitted and context files. The file ends with a __main__ block \
running uvicorn on host 127.0.0.1 and port int(os.environ["PORT"]). The web \
client calls the server from another origin, so the server admits the \
origins listed in the CORS_ORIGINS environment variable — comma-separated, \
unset or empty meaning none — through fastapi's CORSMiddleware; never a \
wildcard. fastapi \
and uvicorn are the app's own dependencies — the strong-engineer default \
when the repo shows no server pattern of its own; a pattern the repo does \
show wins. mcp boundaries emit nothing today.
- A capability edge becomes an entry in the agent's `tools=[...]` list, \
importing the real function from the human-authored files shown to you as \
context — use the actual names and signatures those files define.
- A subgraph node imports the subgraph module's `run` and calls it like any \
other step.
- io progress nodes emit nothing; instrumentation lives in the observer, not \
the code.
- Prompts are ordinary application assets: each agent's prompt lives at \
`prompts/<agent-node-id>.md` by convention (the raw node id). Define a \
module-level `_PROMPT_FILE = "prompts/<agent-node-id>.md"` and load the \
system prompt from it (the application runs from the repo root). Do not \
inline prompt text, and NEVER emit the prompt file itself — it is a \
human-authored asset that already exists; reference it, never overwrite it.
- Concurrency, when the graph demands it, uses the standard library (asyncio) \
— no orchestration frameworks.
- Comments only where they state a constraint the code cannot show; never \
narration. Docstrings follow the repo's own habits.
- Label every emitted file's role: "agent" for a function wrapping Engine, \
"orchestration" for a graph's run() module, "boundary-server" for a boundary \
server file, "other" for everything else.
- Label every emitted file's unit too: the id, from the unit list in the \
request, of the architectural unit the file implements — an agent's function \
carries its agent unit, a graph's run() module its graph unit, a boundary \
server its boundary unit. A file that serves several units (a package \
__init__.py) carries "shared".

When the request includes the current generated code, you are REVISING it, \
not writing anew: change only what the civil documents now require, return \
every file you leave unchanged byte-for-byte as given, keep each existing \
file at its path and under its unit, and omit the files of a unit no longer \
in the unit list. Write a new file only where the documents now require code \
that no current file provides. Many units have no code at all — clients, mcp \
boundaries, services (their code is their graph's, or the human's handler) — \
and never get a file, not even a placeholder. When an edit removes the last \
use of an import, remove the import too.

Choose emitted file paths yourself, guided by the repo layout visible in the \
context files — put code where this repo's author would have. NEVER emit a \
path that already exists among the context files or the civil documents \
(civil/patterns.md included): those are owned elsewhere.

Call emit_files exactly once with the complete set of files."""

PATTERNS_PREFACE = (
    "The repo's own conventions — follow them; they win over any default:\n\n"
)
NO_PATTERNS = (
    "No pattern analysis exists for this repo yet: use clean, idiomatic Python defaults."
)


class TranspileValidationError(Exception):
    """Raised when the retry budget is spent with validators still complaining."""

    def __init__(self, issues: list[str], attempts: int) -> None:
        super().__init__(f"validation failed after {attempts} attempts")
        self.issues = issues
        self.attempts = attempts


def _is_engine_call(node: ast.AST) -> bool:
    """Engine(...) whether the name is bare or reached through a module alias
    (engines.Engine(...)) — both spellings are the same construction."""
    if not isinstance(node, ast.Call):
        return False
    if isinstance(node.func, ast.Name):
        return node.func.id == "Engine"
    return isinstance(node.func, ast.Attribute) and node.func.attr == "Engine"


def _module_level_engine_call(tree: ast.Module) -> bool:
    """The contract's shape is a top-level statement, `engine = Engine(...)` —
    an Engine constructed inside a function is configuration hidden from lift."""
    for statement in tree.body:
        if not isinstance(statement, (ast.Assign, ast.AnnAssign, ast.Expr)):
            continue
        for node in ast.walk(statement):
            if _is_engine_call(node):
                return True
    return False


def _uses_engine(tree: ast.Module) -> bool:
    """Whether the file deals in Engine at all. Importing only Reply from the
    engines module carries no construction obligation."""
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module == "civil_runtime.engines":
            if any(alias.name == "Engine" for alias in node.names):
                return True
        if _is_engine_call(node):
            return True
    return False


def _is_vendor_module(module: str) -> bool:
    """Root match on the dotted path: google.generativeai.types is caught,
    google.cloud is not."""
    parts = module.split(".")
    return any(".".join(parts[: i + 1]) in VENDOR_MODULES for i in range(len(parts)))


def _reads_cors_origins(tree: ast.Module) -> bool:
    """Whether the file names the CORS_ORIGINS variable. The name is the contract
    the session keeps (it sets the variable to the preview's origins); how the
    server admits them is the repo's pattern, so only the name is checked."""
    return any(
        isinstance(node, ast.Constant) and node.value == "CORS_ORIGINS"
        for node in ast.walk(tree)
    )


def _vendor_imports(tree: ast.Module) -> list[str]:
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found += [a.name for a in node.names if _is_vendor_module(a.name)]
        elif isinstance(node, ast.ImportFrom):
            if node.module and _is_vendor_module(node.module):
                found.append(node.module)
    return found


def _vendor_class_names(tree: ast.Module) -> list[str]:
    """Vendor-named classes as code — defined, referenced, or imported. Prose
    (a docstring that merely mentions ClaudeEngine) is not a leak."""
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name in VENDOR_CLASS_NAMES:
            found.add(node.name)
        elif isinstance(node, ast.Name) and node.id in VENDOR_CLASS_NAMES:
            found.add(node.id)
        elif isinstance(node, ast.Attribute) and node.attr in VENDOR_CLASS_NAMES:
            found.add(node.attr)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            found.update(a.name for a in node.names if a.name in VENDOR_CLASS_NAMES)
    return sorted(found)


def _is_graph_document(path: str) -> bool:
    name = path.rsplit("/", 1)[-1]
    return name.endswith((".yaml", ".yml")) and ("graphs/" in path or ".graph." in name)


def _is_composition_document(path: str) -> bool:
    return path.rsplit("/", 1)[-1] in ("app.yaml", "civil.yaml")


# A string heuristic, deliberately: this module must run without PyYAML (the
# test suite stubs it), and the composition schema puts the `boundary` key
# nowhere but boundary nodes. Comments are stripped before the search — a
# commented-out node declares nothing. Only the api kind demands a server —
# mcp boundaries emit nothing today.
_API_BOUNDARY = re.compile(r"\bboundary:\s*[\"']?api\b")


def _declares_api_boundary(text: str) -> bool:
    return bool(_API_BOUNDARY.search(re.sub(r"(?m)#.*$", "", text)))


def validate(
    files: dict[str, str],
    documents: dict[str, str],
    context: dict[str, str],
    roles: dict[str, str] | None = None,
) -> list[str]:
    """Every hard line of the contract, checked deterministically on every attempt."""
    issues: list[str] = []
    trees: dict[str, ast.Module] = {}
    roles = roles or {}

    for path in sorted(files):
        content = files[path]
        if path in context:
            issues.append(f"{path}: collides with a human-owned file — pick another path")
        if path in documents or path == "civil/patterns.md":
            issues.append(
                f"{path}: collides with a civil document — the transpiler's "
                "inputs are never its outputs"
            )
        if path.endswith(".py"):
            try:
                trees[path] = ast.parse(content)
            except SyntaxError as error:
                issues.append(f"{path}: does not parse — {error.msg} (line {error.lineno})")

    run_modules = 0
    for path, tree in trees.items():
        issues.extend(_unused_imports(path, tree))
        for module in _vendor_imports(tree):
            issues.append(f"{path}: imports {module} — emitted code never imports a vendor SDK")
        for name in _vendor_class_names(tree):
            issues.append(
                f"{path}: names {name} — vendor identity is data on the "
                "Engine constructor, never a class"
            )
        if _uses_engine(tree) and not _module_level_engine_call(tree):
            issues.append(
                f"{path}: uses Engine but never constructs Engine(...) at "
                "module level with literal kwargs"
            )
        if roles.get(path, "other") == "boundary-server":
            if not _reads_cors_origins(tree):
                issues.append(
                    f"{path}: the boundary server never reads CORS_ORIGINS — the "
                    "web client calls it cross-origin and every request would be refused"
                )
            # Transport, not orchestration: the boundary file has no run(),
            # so the straight-line rule has nothing to hold it to — and a
            # run() it did define would not be a graph's.
            continue
        runs = [
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "run"
        ]
        if runs:
            run_modules += 1
        for fn in runs:
            if any(isinstance(node, (ast.If, ast.While, ast.Try)) for node in ast.walk(fn)):
                issues.append(
                    f"{path}: run() must stay straight-line: the graph does "
                    "not express control flow"
                )

    graph_documents = [p for p in sorted(documents) if _is_graph_document(p)]
    if run_modules < len(graph_documents):
        issues.append(
            f"{len(graph_documents)} graph document(s) but only {run_modules} "
            "emitted module(s) define run() — each graph becomes an orchestration "
            "module with a run() entrypoint"
        )

    declares_api_boundary = any(
        _declares_api_boundary(documents[path])
        for path in documents
        if _is_composition_document(path)
    )
    if declares_api_boundary and not any(
        roles.get(path, "other") == "boundary-server" for path in files
    ):
        issues.append(
            "the composition declares an api boundary but no emitted file "
            'carries role "boundary-server" — the boundary server is part '
            "of the emission"
        )

    return issues


def _section(title: str, files: dict[str, str]) -> str:
    parts = [title]
    for path in sorted(files):
        parts.append(f"--- {path} ---\n{files[path]}")
    return "\n\n".join(parts)


def _files_list(tool_input: Any) -> list[Any] | None:
    """The emit_files `files` array, tolerating the model's occasional
    double-encoding. Roughly half the forced calls arrive with `files` as a JSON
    *string* — the array serialized a second time, sometimes trailed by a leaked
    tool-call scaffold token (`</invoke>`) — instead of the array the schema asks
    for. It shows up on the create and stream paths at the same rate (measured
    2026-09-23), so it is the model, not accumulation, and the data is all there
    and valid: recover it rather than spend a retry on what is already a complete
    emission. raw_decode reads the first complete JSON value and drops any
    trailing junk; a re-encoded whole object unwraps to its files."""
    if not isinstance(tool_input, dict):
        return None
    files = tool_input.get("files")
    if isinstance(files, list):
        return files
    if isinstance(files, str):
        try:
            decoded, _ = json.JSONDecoder().raw_decode(files.lstrip())
        except ValueError:
            return None
        if isinstance(decoded, dict):
            decoded = decoded.get("files")
        if isinstance(decoded, list):
            return decoded
    return None


def _parse_emission(
    tool_input: Any,
) -> tuple[dict[str, str], dict[str, str], dict[str, str], list[str]]:
    entries = _files_list(tool_input)
    if entries is None:
        return {}, {}, {}, ['emit_files input must be {"files": [{"path", "content"}, ...]}']
    files: dict[str, str] = {}
    roles: dict[str, str] = {}
    units: dict[str, str] = {}
    issues: list[str] = []
    for entry in entries:
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("path"), str)
            or not isinstance(entry.get("content"), str)
        ):
            issues.append(f"emit_files entry is not {{path, content}} strings: {entry!r:.120}")
            continue
        if entry["path"] in files:
            issues.append(f"{entry['path']}: emitted twice — emit each file once, complete")
            continue
        # The schema holds the enum, but the schema is advisory to a model:
        # an unknown role goes back as an issue, an absent one means other.
        role = entry.get("role", "other")
        if role not in ROLES:
            issues.append(f"{entry['path']}: role {role!r} is not one of {', '.join(ROLES)}")
            continue
        files[entry["path"]] = entry["content"]
        roles[entry["path"]] = role
        # Absent reads as shared here; whether that is allowed is the validator's
        # call, which knows the unit list.
        unit = entry.get("unit", SHARED_UNIT)
        units[entry["path"]] = unit if isinstance(unit, str) else repr(unit)
    return files, roles, units, issues


def _unit_issues(units: dict[str, str], known: list[dict[str, str]]) -> list[str]:
    """Every file must name a unit the documents define, or shared. A made-up id
    would put a file in the registry under an architecture that does not exist."""
    ids = {unit["id"] for unit in known}
    issues = []
    for path in sorted(units):
        if units[path] != SHARED_UNIT and units[path] not in ids:
            issues.append(
                f"{path}: unit {units[path]!r} is not in the unit list — use one of "
                f"{', '.join(sorted(ids))}, or {SHARED_UNIT!r} for a file serving several"
            )
    return issues


def _unused_imports(path: str, tree: ast.Module) -> list[str]:
    """Names a module imports and never mentions. Revising in place makes this
    the characteristic leftover — remove a route, keep its handler's import — so
    it is checked rather than hoped for. A package __init__.py imports to
    re-export, and a module listing __all__ declares its own; both are exempt."""
    if path.endswith("__init__.py"):
        return []
    imported: dict[str, int] = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                imported[(alias.asname or alias.name).split(".")[0]] = node.lineno
        elif isinstance(node, ast.ImportFrom) and node.module != "__future__":
            for alias in node.names:
                if alias.name != "*":
                    imported[alias.asname or alias.name] = node.lineno
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
    if "__all__" in used:
        return []
    # Names in string annotations ("Engine") count as uses too.
    used |= {
        n.value for n in ast.walk(tree)
        if isinstance(n, ast.Constant) and isinstance(n.value, str) and n.value.isidentifier()
    }
    return [
        f"{path}: imports {name} (line {line}) but never uses it — remove the import"
        for name, line in sorted(imported.items(), key=lambda item: item[1])
        if name not in used
    ]


def _route_issues(
    files: dict[str, str],
    roles: dict[str, str],
    file_units: dict[str, str],
    known: list[dict[str, Any]],
) -> list[str]:
    """An api boundary's server serves exactly what the boundary exposes: every
    exposed service has its route, and no service the boundary does not expose
    does. Revising in place makes the second half the live risk — asked to keep
    unchanged code byte-for-byte, a model can keep a route the sketch removed.
    Checked on route literals, so it holds whatever server framework the repo's
    pattern chose."""
    by_id = {unit["id"]: unit for unit in known}
    services = sorted(u["id"].removeprefix("app/") for u in known if u["kind"] == "service")
    issues = []
    for path in sorted(files):
        unit = by_id.get(file_units.get(path, ""))
        if roles.get(path) != "boundary-server" or not unit or unit.get("boundary") != "api":
            continue
        try:
            tree = ast.parse(files[path])
        except SyntaxError:
            continue  # reported by validate
        literals = {
            n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)
        }
        exposes = unit.get("exposes") or []
        for name in exposes:
            if f"/{name}" not in literals:
                issues.append(f"{path}: {unit['id']} exposes {name} but serves no /{name} route")
        for name in services:
            if name not in exposes and f"/{name}" in literals:
                issues.append(
                    f"{path}: serves /{name}, but {unit['id']} no longer exposes {name} — "
                    "remove the route and anything only it used"
                )
    return issues


def _codeless(unit: dict[str, str]) -> bool:
    """Units that never own generated code: a client is the human's frontend, an
    mcp boundary emits nothing today, and a service's code is its graph's (its own
    unit) or the human's handler."""
    return unit["kind"] in ("client", "service") or unit.get("boundary") == "mcp"


def _codeless_issues(file_units: dict[str, str], known: list[dict[str, str]]) -> list[str]:
    codeless = {unit["id"] for unit in known if _codeless(unit)}
    return [
        f"{path}: unit {file_units[path]!r} has no generated code — emit nothing for it, "
        "not even a placeholder"
        for path in sorted(file_units)
        if file_units[path] in codeless
    ]


def _revision_issues(
    files: dict[str, str],
    file_units: dict[str, str],
    current: list[dict[str, str]],
    known: list[dict[str, str]],
) -> list[str]:
    """The backstop for revising in place: a file of a unit that still exists
    must come back at the same path, under the same unit. Paths are how the
    registry, the diff, and a human reviewer recognise the same code across
    emissions; a moved file reads as one deleted and another written."""
    ids = {unit["id"] for unit in known if not _codeless(unit)}
    issues = []
    for entry in sorted(current, key=lambda e: e["path"]):
        path, unit = entry["path"], entry["unit"]
        if unit not in ids:
            # The unit left the documents, or never should have had code (a
            # placeholder an earlier emission wrote): dropping its files is right.
            continue
        if path not in files:
            issues.append(
                f"{path}: an existing file of unit {unit!r} is missing — revise it in "
                "place at this path; never move, rename, or drop it while its unit exists"
            )
        elif file_units.get(path) != unit:
            issues.append(
                f"{path}: belongs to unit {unit!r}, but came back labelled "
                f"{file_units.get(path)!r} — a file stays with its unit"
            )
    return issues


def _current_section(current: list[dict[str, str]]) -> str:
    parts = ["The current generated code — revise it; return unchanged files exactly as given:"]
    for entry in sorted(current, key=lambda e: e["path"]):
        parts.append(
            f"--- {entry['path']} (unit: {entry['unit']}, role: {entry['role']}) ---\n{entry['content']}"
        )
    return "\n\n".join(parts)


def _unit_section(units: list[dict[str, str]]) -> str:
    lines = ["The units of this application — label every emitted file with the one it implements:"]
    for unit in units:
        kind = f"{unit['boundary']} {unit['kind']}" if unit.get("boundary") else unit["kind"]
        lines.append(f"- {unit['id']} ({kind}, defined in {unit['source']})")
    return "\n".join(lines)


def transpile(
    documents: dict[str, str],
    patterns: str | None,
    context: dict[str, str],
    client: Any,
    model: str,
    units: list[dict[str, str]] | None = None,
    current: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    parts = []
    if context:
        parts.append(_section(
            "Human-authored context files — import from these, never overwrite them:",
            context,
        ))
    parts.append(_section("The civil documents to transpile:", documents))
    parts.append(PATTERNS_PREFACE + patterns if patterns else NO_PATTERNS)
    if units:
        parts.append(_unit_section(units))
    if current:
        parts.append(_current_section(current))

    messages: list[dict[str, Any]] = [{"role": "user", "content": "\n\n".join(parts)}]
    issues: list[str] = []
    # The emitting model doubles as the default the emitted code names: both
    # resolve from CIVIL_DEFAULT_MODEL, and "model ids resolved at build time"
    # (docs/emitted-code.md) means a real id lands in the literal, never a guess.
    system = SYSTEM_TEMPLATE.format(default_model=model)

    for attempt in range(1, MAX_ATTEMPTS + 1):
        request = dict(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=messages,
            tools=[EMIT_FILES_TOOL],
            tool_choice={"type": "tool", "name": "emit_files"},
        )
        # A full emission can outlast the SDK's 10-minute non-streaming ceiling,
        # so stream when the client can and accumulate to the same Message shape.
        stream = getattr(client.messages, "stream", None)
        if stream is not None:
            with stream(**request) as events:
                response = events.get_final_message()
        else:
            response = client.messages.create(**request)

        block = next((b for b in response.content if b.type == "tool_use"), None)
        if block is None:
            # tool_choice forces the call; its absence is the model failing, not
            # the emission failing validation.
            raise ValueError("the model reply carried no emit_files call")

        if getattr(response, "stop_reason", None) == "max_tokens":
            # A truncated emission can parse as malformed OR as a shorter file set
            # that validates — both are wrong, and retrying only grows the prompt.
            raise ValueError(
                "the model hit the output ceiling mid-emission "
                f"(CIVIL_TRANSPILE_MAX_TOKENS={MAX_TOKENS}); raise it for this project"
            )

        files, roles, file_units, issues = _parse_emission(block.input)
        if not issues:
            issues = validate(files, documents, context, roles)
            if units is not None:
                issues += _unit_issues(file_units, units)
                issues += _codeless_issues(file_units, units)
                issues += _route_issues(files, roles, file_units, units)
                if current:
                    issues += _revision_issues(files, file_units, current, units)
        if not issues:
            return {"files": files, "roles": roles, "units": file_units, "attempts": attempt}

        messages.append({"role": "assistant", "content": response.content})
        messages.append({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": "Validation failed:\n- " + "\n- ".join(issues)
                + "\n\nCall emit_files again with the complete corrected set of files.",
                "is_error": True,
            }],
        })

    raise TranspileValidationError(issues, MAX_ATTEMPTS)
