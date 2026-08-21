"""The agent loop (PRD 11.2): an objective, a model, and the tools its edges grant.

Everything the agent may call arrives as capability edges resolved to files in
the scratch — never declared twice: the tool's contract is discovered from its
source (PRD 7.2), and the same discovered schema is what tool calls are
validated against at the boundary (PRD 11.3): strict refuses a malformed call,
lenient logs it and lets the code decide.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import yaml

import asyncio

from civil_runtime.discover import discover
from civil_runtime.runner import GraphError, load_function


def call_tool(fn: Callable[..., Any], args: dict[str, Any]) -> Any:
    result = fn(**args)
    if asyncio.iscoroutine(result):
        return asyncio.run(result)
    return result

# PRD 12: the model id lives in config. The fallback was resolved at build time,
# not remembered — override with CIVIL_DEFAULT_MODEL as models move.
DEFAULT_MODEL = os.environ.get("CIVIL_DEFAULT_MODEL", "claude-sonnet-5")
MAX_TOKENS = int(os.environ.get("CIVIL_MAX_TOKENS", "4096"))


@dataclass
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    entrypoint: str
    function: str


def _resolve_entrypoint(scratch: Path, ref: str) -> str:
    """A capability target names its files by glob when it has no entrypoint."""
    if "*" not in ref and "?" not in ref:
        return ref
    matches = sorted(scratch.glob(ref))
    for match in matches:
        if match.suffix == ".py":
            return str(match.relative_to(scratch))
    raise GraphError(f"no Python file matches {ref}")


def _load_tools(scratch: Path, refs: list[Any]) -> list[Tool]:
    tools: list[Tool] = []
    for ref in refs:
        entrypoint = _resolve_entrypoint(scratch, ref.entrypoint)
        source = (scratch / entrypoint).read_text()
        contract = discover(source, function=ref.function)
        # The model's input_schema must be a top-level object, so the function's
        # parameters become its properties — exactly the ports discovery projects
        # (PRD 7.2, no second declaration). Calls come back keyed by parameter.
        properties: dict[str, Any] = {}
        required: list[str] = []
        for port in contract.get("inputs") or []:
            properties[port["name"]] = port.get("schema") or {}
            if port.get("required"):
                required.append(port["name"])
        tools.append(
            Tool(
                name=contract["name"],
                description=contract.get("description") or f"{entrypoint}:{contract['name']}",
                input_schema={"type": "object", "properties": properties, "required": required},
                entrypoint=entrypoint,
                function=contract["name"],
            )
        )
    return tools


def _validate(tool: Tool, args: Any, mode: str) -> str | None:
    """Boundary validation (PRD 11.3). Returns the complaint, or None."""
    schema = tool.input_schema
    if schema.get("type") == "object" and isinstance(args, dict):
        required = schema.get("required") or []
        missing = [k for k in required if k not in args]
        properties = schema.get("properties") or {}
        unknown = [k for k in args if properties and k not in properties]
        if missing or unknown:
            parts = []
            if missing:
                parts.append(f"missing {', '.join(missing)}")
            if unknown:
                parts.append(f"unexpected {', '.join(unknown)}")
            return f"call to {tool.name} does not match its contract: {'; '.join(parts)}"
        return None
    if schema.get("type") == "object" and not isinstance(args, dict):
        return f"call to {tool.name} must be an object"
    return None


def _conclude(text: str) -> Any:
    """The agent's last words, as data when they contain data.

    Models mix reasoning with the answer however firmly the prompt asks
    otherwise, so: the whole text as JSON first, then the outermost braced
    span, then — honestly — just the text.
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass
    return text


def run_agent(
    *,
    scratch: Path,
    node: Any,
    value: Any,
    tools: list[Any],
    tool_validation: str,
    report: Callable[[dict[str, Any]], bool],
) -> Any:
    try:
        import anthropic
    except ImportError as error:
        raise GraphError("the runner has no model client installed (pip install anthropic)") from error
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise GraphError("model access is not configured (ANTHROPIC_API_KEY)")

    # The agent manifest: objective file, model, turn budget (PRD 6.3).
    ref = node.raw.get("ref")
    agent_doc = yaml.safe_load((scratch / ref).read_text()) if ref else {}
    spec = (agent_doc or {}).get("spec") or {}
    prompt_file = spec.get("promptFile")
    system = (scratch / prompt_file).read_text() if prompt_file else "You are a step in a dataflow graph."
    model = spec.get("model") or DEFAULT_MODEL
    max_turns = int(spec.get("maxTurns") or 8)

    loaded = _load_tools(scratch, tools)
    by_name = {t.name: t for t in loaded}

    client = anthropic.Anthropic()
    messages: list[dict[str, Any]] = [
        {
            "role": "user",
            "content": value if isinstance(value, str) else json.dumps(value, default=str),
        }
    ]

    for _turn in range(max_turns):
        response = client.messages.create(
            model=model,
            max_tokens=MAX_TOKENS,
            system=system,
            messages=messages,
            tools=[
                {"name": t.name, "description": t.description, "input_schema": t.input_schema}
                for t in loaded
            ]
            or anthropic.NOT_GIVEN,
        )

        if response.stop_reason == "tool_use":
            messages.append({"role": "assistant", "content": response.content})
            results: list[dict[str, Any]] = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                tool = by_name.get(block.name)
                report({
                    "type": "node.tool_call",
                    "nodeId": node.id,
                    "payload": {"tool": block.name, "input": block.input},
                })
                if tool is None:
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": f"unknown tool {block.name}",
                        "is_error": True,
                    })
                    continue

                complaint = _validate(tool, block.input, tool_validation)
                if complaint and tool_validation == "strict":
                    # PRD 11.3 strict: the mismatch is the result — the model sees
                    # exactly what it got wrong, and the code never runs.
                    report({
                        "type": "node.tool_result",
                        "nodeId": node.id,
                        "payload": {"tool": block.name, "error": complaint},
                    })
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": complaint,
                        "is_error": True,
                    })
                    continue
                if complaint:
                    print(f"[runner] lenient: {complaint}")

                try:
                    fn = load_function(scratch, tool.entrypoint, tool.function)
                    # Tool arguments arrive keyed by parameter name; the call
                    # mirrors the signature the schema was read from.
                    args = block.input if isinstance(block.input, dict) else {}
                    output = call_tool(fn, args)
                    report({
                        "type": "node.tool_result",
                        "nodeId": node.id,
                        "payload": {"tool": block.name, "output": output},
                    })
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(output, default=str),
                    })
                except Exception as error:  # noqa: BLE001 — the model gets the failure
                    report({
                        "type": "node.tool_result",
                        "nodeId": node.id,
                        "payload": {"tool": block.name, "error": str(error)},
                    })
                    results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(error),
                        "is_error": True,
                    })
            messages.append({"role": "user", "content": results})
            continue

        text = "".join(block.text for block in response.content if block.type == "text")
        return _conclude(text)

    raise GraphError(f'agent "{node.id}" hit its turn budget ({max_turns}) without concluding')
