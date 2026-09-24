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
import functools
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


def _openai_tool_schema(fn: Callable[..., Any]) -> dict[str, Any]:
    """The same signature-derived declaration in the OpenAI idiom: the schema
    nests under a ``function`` envelope and ``input_schema`` becomes
    ``parameters``. Derived from `_tool_schema` so there is one source, not two."""
    schema = _tool_schema(fn)
    return {
        "type": "function",
        "function": {
            "name": schema["name"],
            "description": schema["description"],
            "parameters": schema["input_schema"],
        },
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


#: The OpenAI chat-completions dialect is spoken by OpenAI itself and by the
#: local/OSS servers that emulate it (Ollama, vLLM). One adapter serves them
#: all; the kind selects only where to reach the server and whether a missing
#: key is fatal — never how the loop runs. Base URLs and keys are the
#: environment's concern: each kind names the variable that points at its
#: server, and a local kind keeps a conventional localhost default (still
#: overridable) so it works out of the box, with a throwaway key for servers
#: that ignore auth. Nothing here is a secret and nothing is logged.
_OPENAI_COMPATIBLE: dict[str, dict[str, Any]] = {
    "openai": {
        "base_url_env": "OPENAI_BASE_URL",
        "default_base_url": None,
        "key_env": "OPENAI_API_KEY",
        # OpenAI's current models (the reasoning family included) take
        # max_completion_tokens; max_tokens 400s on them.
        "token_field": "max_completion_tokens",
        "local": False,
    },
    "ollama": {
        "base_url_env": "OLLAMA_BASE_URL",
        "default_base_url": "http://localhost:11434/v1",
        "key_env": "OLLAMA_API_KEY",
        "token_field": "max_tokens",
        "local": True,
    },
    "vllm": {
        "base_url_env": "VLLM_BASE_URL",
        "default_base_url": "http://localhost:8000/v1",
        "key_env": "VLLM_API_KEY",
        "token_field": "max_tokens",
        "local": True,
    },
}


class _OpenAIAdapter:
    """The OpenAI dialect: chat.completions.create with a tool-call loop.

    The same construction as the Claude adapter in a different idiom — the
    system prompt is the first message rather than a top-level field, tool
    schemas nest under a ``function`` envelope, tool-call arguments arrive as a
    JSON string, and results go back as ``role: tool`` messages. All of it is
    internal; the public surface and the Reply it returns are identical.
    """

    def __init__(self, kind: str = "openai", *, client: Any | None = None):
        if kind not in _OPENAI_COMPATIBLE:
            raise ValueError(f"{kind!r} is not an OpenAI-compatible kind")
        self._kind = kind
        self._client = client

    def _make_client(self, openai: Any) -> Any:
        """Construct the SDK client for this kind, reading endpoint and key
        from the environment (the SDK reads OPENAI_* on its own; a kind-named
        override and a localhost default cover the local servers)."""
        config = _OPENAI_COMPATIBLE[self._kind]
        kwargs: dict[str, Any] = {}
        base_url = os.environ.get(config["base_url_env"]) or config["default_base_url"]
        if base_url:
            kwargs["base_url"] = base_url
        # Each kind reads its OWN key variable, so a real hosted key is never sent
        # to a local server. The SDK refuses to construct without a key even against
        # a server that ignores it, so a local endpoint gets a throwaway when the
        # environment supplies none; a hosted endpoint is left to the SDK's own error.
        api_key = os.environ.get(config["key_env"])
        if not api_key and config["local"]:
            api_key = "civil-local-unused"
        if api_key:
            kwargs["api_key"] = api_key
        return openai.OpenAI(**kwargs)

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
            try:
                import openai
            except ImportError as error:  # a clear failure beats an opaque one
                raise RuntimeError(
                    f"the 'openai' package is required for the {self._kind!r} engine "
                    "(pip install openai)"
                ) from error
            client = self._client = self._make_client(openai)

        schemas = [_openai_tool_schema(fn) for fn in tools]
        by_name = {schema["function"]["name"]: fn for schema, fn in zip(schemas, tools)}
        # The token-limit field is kind-specific: OpenAI's current models want
        # max_completion_tokens, the OSS servers still take max_tokens.
        request: dict[str, Any] = {
            "model": model,
            _OPENAI_COMPATIBLE[self._kind]["token_field"]: max_tokens,
        }
        if schemas:
            request["tools"] = schemas
        # The system prompt is a message here, not a top-level field.
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]

        for _turn in range(max_turns):
            response = client.chat.completions.create(messages=messages, **request)
            message = response.choices[0].message
            tool_calls = list(getattr(message, "tool_calls", None) or [])
            # Presence of tool calls drives the loop — the OpenAI analogue of
            # Claude's stop_reason == "tool_use", and steadier across the OSS
            # servers, whose finish_reason is not always "tool_calls".
            if not tool_calls:
                return message.content or ""

            messages.append(
                {
                    "role": "assistant",
                    # Some OSS servers reject a null content on an assistant turn.
                    "content": message.content or "",
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.function.name,
                                "arguments": call.function.arguments,
                            },
                        }
                        for call in tool_calls
                    ],
                }
            )
            for call in tool_calls:
                fn = by_name.get(call.function.name)
                if fn is None:
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.id,
                            "content": f"unknown tool {call.function.name}",
                        }
                    )
                    continue
                # Arguments arrive as a JSON string; a malformed or empty one
                # becomes no arguments rather than a crash the model can't see.
                try:
                    args = json.loads(call.function.arguments or "{}")
                except (json.JSONDecodeError, TypeError):
                    args = {}
                try:
                    output = _call_tool(fn, args if isinstance(args, dict) else {})
                    content = json.dumps(output, default=str)
                except Exception as error:  # noqa: BLE001 — the model gets the failure
                    content = str(error)
                messages.append(
                    {"role": "tool", "tool_call_id": call.id, "content": content}
                )

        raise RuntimeError(f"the engine hit its turn budget ({max_turns}) without concluding")


#: Vendor identity is data: the constructor key selects from here, and adding a
#: vendor adds a row, never a second public class. The OpenAI-compatible kinds
#: are one adapter differentiated by data (endpoint, key policy), bound per row.
_ADAPTERS: dict[str, Callable[[], Any]] = {
    "claude": _ClaudeAdapter,
    "openai": functools.partial(_OpenAIAdapter, "openai"),
    "ollama": functools.partial(_OpenAIAdapter, "ollama"),
    "vllm": functools.partial(_OpenAIAdapter, "vllm"),
}


class Engine:
    """One conversational engine, whichever vendor answers.

    `Engine()` is Claude; `Engine("<kind>", model=...)` is any other registered
    vendor — `"openai"`, `"ollama"`, and `"vllm"` all speak the OpenAI
    chat-completions dialect behind this same surface. The model defaults from
    the CIVIL_DEFAULT_MODEL environment variable, resolved when the engine is
    constructed.
    """

    def __init__(
        self,
        kind: str = "claude",
        *,
        model: str | None = None,
        max_tokens: int = 4096,
        _adapter: Any = None,
    ):
        # Validate the kind first: an unknown kind is a more basic error than a
        # missing model, and its message names the known kinds.
        if _adapter is None:
            adapter_type = _ADAPTERS.get(kind)
            if adapter_type is None:
                known = ", ".join(sorted(_ADAPTERS))
                raise ValueError(f"unknown engine kind {kind!r} (known kinds: {known})")
            _adapter = adapter_type()
        self._adapter = _adapter
        resolved = model or os.environ.get("CIVIL_DEFAULT_MODEL")
        if resolved is None:
            # The built-in fallback is a Claude model id; handing it to another
            # vendor would send a Claude name to that server and fail opaquely.
            if kind != "claude":
                raise ValueError(
                    f"Engine({kind!r}) needs an explicit model "
                    "(pass model=..., or set CIVIL_DEFAULT_MODEL)"
                )
            resolved = _FALLBACK_MODEL
        self._model = resolved
        self._max_tokens = max_tokens

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
