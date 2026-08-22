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
import os
import re
from typing import Any

MAX_TOKENS = int(os.environ.get("CIVIL_TRANSPILE_MAX_TOKENS", "16384"))

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
PROMPT_VERSION = "3"

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
the default; other vendor kinds arrive in the library later), unless the \
agent document pins a different model id — so the configuration is data on \
one line. The function invokes it as \
`engine.run(system=..., user=..., tools=[...], max_turns=<n>)`, where \
max_turns is the agent's turn budget (agent.yaml maxTurns) written as a \
literal int, and gets back a Reply: `.text` is the final text, `.json()` the \
conclusion parsed as data. Serialize structured user content with \
json.dumps, not str(). NEVER import anthropic, openai, or any other vendor \
SDK in emitted files, and never invent vendor-named classes — Engine is the \
only surface.
- Each graph document becomes an orchestration module whose `run()` body is \
straight-line — assignments, calls, a return — mapping the graph's flow edges \
in topological order. No conditionals or loops standing in for control flow \
the graph does not express.
- A composition document (app.yaml / civil.yaml) turns each boundary node of \
the api kind into ONE boundary server file: a FastAPI app exposing every \
entry in the node's exposes list as POST /<name> — JSON body in, JSON result \
out — importing and calling the real service function or graph run() from \
the other emitted and context files. The file ends with a __main__ block \
running uvicorn on host 127.0.0.1 and port int(os.environ["PORT"]). fastapi \
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
- Prompts are ordinary application assets: load each prompt file from the \
repo path it already has (the application runs from the repo root). Do not \
inline prompt text.
- Concurrency, when the graph demands it, uses the standard library (asyncio) \
— no orchestration frameworks.
- Comments only where they state a constraint the code cannot show; never \
narration. Docstrings follow the repo's own habits.
- Label every emitted file's role: "agent" for a function wrapping Engine, \
"orchestration" for a graph's run() module, "boundary-server" for a boundary \
server file, "other" for everything else.

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


def _parse_emission(tool_input: Any) -> tuple[dict[str, str], dict[str, str], list[str]]:
    if not isinstance(tool_input, dict) or not isinstance(tool_input.get("files"), list):
        return {}, {}, ['emit_files input must be {"files": [{"path", "content"}, ...]}']
    files: dict[str, str] = {}
    roles: dict[str, str] = {}
    issues: list[str] = []
    for entry in tool_input["files"]:
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
    return files, roles, issues


def transpile(
    documents: dict[str, str],
    patterns: str | None,
    context: dict[str, str],
    client: Any,
    model: str,
) -> dict[str, Any]:
    parts = []
    if context:
        parts.append(_section(
            "Human-authored context files — import from these, never overwrite them:",
            context,
        ))
    parts.append(_section("The civil documents to transpile:", documents))
    parts.append(PATTERNS_PREFACE + patterns if patterns else NO_PATTERNS)

    messages: list[dict[str, Any]] = [{"role": "user", "content": "\n\n".join(parts)}]
    issues: list[str] = []
    # The emitting model doubles as the default the emitted code names: both
    # resolve from CIVIL_DEFAULT_MODEL, and "model ids resolved at build time"
    # (docs/emitted-code.md) means a real id lands in the literal, never a guess.
    system = SYSTEM_TEMPLATE.format(default_model=model)

    for attempt in range(1, MAX_ATTEMPTS + 1):
        response = client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=messages,
            tools=[EMIT_FILES_TOOL],
            tool_choice={"type": "tool", "name": "emit_files"},
        )

        block = next((b for b in response.content if b.type == "tool_use"), None)
        if block is None:
            # tool_choice forces the call; its absence is the model failing, not
            # the emission failing validation.
            raise ValueError("the model reply carried no emit_files call")

        files, roles, issues = _parse_emission(block.input)
        if not issues:
            issues = validate(files, documents, context, roles)
        if not issues:
            return {"files": files, "roles": roles, "attempts": attempt}

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
