"""Conversational engines behind one interface.

An application talks to `Engine` — a system prompt, user content, plain-callable
tools, a turn budget — and gets a `Reply` back. Which vendor answers is data, a
key on the constructor, not a different import: switching vendors edits one
string while the calling code keeps its shape. The adapters that speak each
vendor's dialect are internals, and the SDKs they wrap are imported lazily, so
this module imports cleanly where no vendor SDK is installed.

Tools are ordinary functions. Their model-facing schemas are derived from the
signature — parameters become the properties of an object schema, parameters
without defaults are required, the docstring's first line is the description —
so the function is the contract and there is no second declaration to drift.

Credentials and base URLs are the environment's concern (the Anthropic SDK
reads ANTHROPIC_API_KEY itself); nothing here holds or logs a secret.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
from dataclasses import dataclass
from typing import Any, Callable

__all__ = ["Engine", "Reply"]

#: The model id lives in config, not in code. The fallback was chosen at build
#: time, not remembered — override with CIVIL_DEFAULT_MODEL as models move.
_FALLBACK_MODEL = "claude-sonnet-5"

#: Python primitives that map cleanly onto JSON Schema. Anything absent is
#: reported by name with an open schema rather than guessed at — the callable
#: itself remains the contract.
_SCHEMAS: dict[str, dict[str, Any]] = {
    "str": {"type": "string"},
    "int": {"type": "integer"},
    "float": {"type": "number"},
    "bool": {"type": "boolean"},
    "bytes": {"type": "string", "contentEncoding": "base64"},
    "None": {"type": "null"},
    "NoneType": {"type": "null"},
}


@dataclass
class Reply:
    """What a run concluded: the engine's final words, as text or as data."""

    #: The final text blocks of the conversation, concatenated.
    text: str

    def json(self) -> Any:
        """The conclusion parsed as JSON.

        Models mix prose with the answer however firmly the prompt asks
        otherwise, so: the whole text first, then the outermost braced span.
        A reply with no JSON in it raises rather than returning prose as data.
        """
        try:
            return json.loads(self.text)
        except json.JSONDecodeError:
            pass
        start, end = self.text.find("{"), self.text.rfind("}")
        if 0 <= start < end:
            try:
                return json.loads(self.text[start : end + 1])
            except json.JSONDecodeError:
                pass
        preview = self.text if len(self.text) <= 120 else self.text[:117] + "..."
        raise ValueError(f"the reply contains no parseable JSON object: {preview!r}")


def _annotation_schema(annotation: Any) -> dict[str, Any]:
    """A JSON Schema for a parameter annotation, or {} when it cannot be known.

    Annotations may arrive as strings (PEP 563), types, or typing generics;
    all are read by name so the three spellings agree.
    """
    if annotation is inspect.Parameter.empty:
        return {}
    if isinstance(annotation, str):
        name = annotation
    elif isinstance(annotation, type):
        name = annotation.__name__
    else:
        name = str(annotation)

    if name in _SCHEMAS:
        return dict(_SCHEMAS[name])

    # list[X] / dict[K, V] — the container is knowable even when the element is not.
    base, _, inner = name.partition("[")
    base = base.rsplit(".", 1)[-1]
    inner = inner.rstrip("]")
    if base in {"list", "List", "Sequence"}:
        items = _SCHEMAS.get(inner)
        return {"type": "array", **({"items": dict(items)} if items else {})}
    if base in {"dict", "Dict", "Mapping"}:
        return {"type": "object"}
    if base == "Optional":
        item = _SCHEMAS.get(inner)
        return {"anyOf": [dict(item), {"type": "null"}]} if item else {}
    return {}


def _tool_schema(fn: Callable[..., Any]) -> dict[str, Any]:
    """The model-facing declaration of one tool, read off its signature."""
    properties: dict[str, Any] = {}
    required: list[str] = []
    for name, parameter in inspect.signature(fn).parameters.items():
        if parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD):
            continue
        properties[name] = _annotation_schema(parameter.annotation)
        if parameter.default is parameter.empty:
            required.append(name)
    docstring = inspect.getdoc(fn)
    return {
        "name": fn.__name__,
        # First line only: the rest of a docstring is for the human reader.
        "description": docstring.strip().split("\n")[0] if docstring else fn.__name__,
        "input_schema": {"type": "object", "properties": properties, "required": required},
    }


def _call_tool(fn: Callable[..., Any], args: dict[str, Any]) -> Any:
    """Sync or async, arguments keyed by parameter name — the signature the
    schema was read from is the signature the call mirrors."""
    result = fn(**args)
    if asyncio.iscoroutine(result):
        return asyncio.run(result)
    return result


class _ClaudeAdapter:
    """The Anthropic dialect: messages.create with a tool-use loop."""

    def __init__(self, client: Any | None = None):
        self._client = client

    def run(
        self,
        *,
        system: str,
        user: str,
        tools: tuple[Callable[..., Any], ...],
        max_turns: int,
        model: str,
        max_tokens: int,
    ) -> str:
        client = self._client
        if client is None:
            # Imported at first use, not at module import: the interface must
            # be loadable where this vendor's SDK is not installed.
            import anthropic

            client = self._client = anthropic.Anthropic()

        schemas = [_tool_schema(fn) for fn in tools]
        by_name = {schema["name"]: fn for schema, fn in zip(schemas, tools)}
        request: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "system": system}
        if schemas:
            request["tools"] = schemas
        messages: list[dict[str, Any]] = [{"role": "user", "content": user}]

        for _turn in range(max_turns):
            response = client.messages.create(messages=messages, **request)
            if response.stop_reason != "tool_use":
                return "".join(block.text for block in response.content if block.type == "text")

            messages.append({"role": "assistant", "content": response.content})
            results: list[dict[str, Any]] = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                fn = by_name.get(block.name)
                if fn is None:
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": f"unknown tool {block.name}",
                            "is_error": True,
                        }
                    )
                    continue
                try:
                    output = _call_tool(fn, block.input if isinstance(block.input, dict) else {})
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": json.dumps(output, default=str),
                        }
                    )
                except Exception as error:  # noqa: BLE001 — the model gets the failure
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": str(error),
                            "is_error": True,
                        }
                    )
            messages.append({"role": "user", "content": results})

        raise RuntimeError(f"the engine hit its turn budget ({max_turns}) without concluding")


#: Vendor identity is data: the constructor key selects from here, and adding a
#: vendor adds a row, never a second public class.
_ADAPTERS: dict[str, type] = {
    "claude": _ClaudeAdapter,
}


class Engine:
    """One conversational engine, whichever vendor answers.

    `Engine()` is Claude; `Engine("<kind>", model=...)` is any other registered
    vendor. The model defaults from the CIVIL_DEFAULT_MODEL environment
    variable, resolved when the engine is constructed.
    """

    def __init__(
        self,
        kind: str = "claude",
        *,
        model: str | None = None,
        max_tokens: int = 4096,
        _adapter: Any = None,
    ):
        self._model = model or os.environ.get("CIVIL_DEFAULT_MODEL") or _FALLBACK_MODEL
        self._max_tokens = max_tokens
        if _adapter is None:
            adapter_type = _ADAPTERS.get(kind)
            if adapter_type is None:
                known = ", ".join(sorted(_ADAPTERS))
                raise ValueError(f"unknown engine kind {kind!r} (known kinds: {known})")
            _adapter = adapter_type()
        self._adapter = _adapter

    def run(
        self,
        *,
        system: str,
        user: str,
        tools: tuple[Callable[..., Any], ...] | list[Callable[..., Any]] = (),
        max_turns: int = 8,
    ) -> Reply:
        """One conversation to its conclusion; tool calls happen inside."""
        text = self._adapter.run(
            system=system,
            user=user,
            tools=tuple(tools),
            max_turns=max_turns,
            model=self._model,
            max_tokens=self._max_tokens,
        )
        return Reply(text)
