"""Contract discovery is what the node face shows and what M4 will bind arguments to.

Getting it wrong does not raise — it draws the wrong ports, which is the silent kind
of failure PRD 2 says is worth testing. Plain asserts and no test framework, so this
runs from `npm test` without a virtualenv.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from civil_runtime.discover import DiscoveryError, discover  # noqa: E402

PASSED = 0


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        PASSED += 1
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        raise SystemExit(1)


def test_typed_dicts_become_schemas() -> None:
    contract = discover(
        '''
from typing import TypedDict

class Document(TypedDict):
    id: str
    body: str
    pages: int

class Summary(TypedDict):
    text: str

def handler(document: Document) -> Summary:
    """Summarise a document."""
    return {"text": ""}
'''
    )
    check("handler is found", contract["name"] == "handler")
    check("docstring becomes the description", contract["description"] == "Summarise a document.")
    check("one input", len(contract["inputs"]) == 1)
    check("input keeps the name the author wrote", contract["inputs"][0]["name"] == "document")
    check("input keeps the annotation as written", contract["inputs"][0]["type"] == "Document")
    check(
        "TypedDict resolves to a schema",
        contract["inputs"][0]["schema"]["properties"]["pages"] == {"type": "integer"},
    )
    check(
        "fields are required by default",
        sorted(contract["inputs"][0]["schema"]["required"]) == ["body", "id", "pages"],
    )
    check("output resolves too", contract["output"]["schema"]["properties"]["text"] == {"type": "string"})


def test_defaults_make_an_input_optional() -> None:
    contract = discover(
        '''
def handler(query: str, limit: int = 5) -> list[str]:
    return []
'''
    )
    check("required input", contract["inputs"][0]["required"] is True)
    # A defaulted argument the caller may omit is not a required port.
    check("defaulted input is optional", contract["inputs"][1]["required"] is False)
    check("list container is known", contract["output"]["schema"]["type"] == "array")
    check("list element is known", contract["output"]["schema"]["items"] == {"type": "string"})


def test_weak_types_report_no_schema_rather_than_guessing() -> None:
    contract = discover(
        '''
from typing import Any

def handler(payload: dict[str, Any]) -> Any:
    return payload
'''
    )
    # PRD 7.2: where types are weak, a shape is inferred from fixtures and offered as
    # a proposal — never adopted silently. So the object is known, its fields are not.
    check("dict is an object", contract["inputs"][0]["schema"] == {"type": "object"})
    check("Any yields no schema", contract["output"]["schema"] is None)
    check("but the annotation is still reported", contract["output"]["type"] == "Any")


def test_a_lone_public_function_needs_no_conventional_name() -> None:
    contract = discover('def search_docs(query: str) -> list[str]:\n    return []\n')
    check("single public function is the entrypoint", contract["name"] == "search_docs")


def test_ambiguity_is_refused_rather_than_guessed() -> None:
    try:
        discover('def one(a: str) -> str:\n    return a\n\ndef two(b: str) -> str:\n    return b\n')
    except DiscoveryError as error:
        check("ambiguity names the candidates", "one, two" in str(error))
        check("ambiguity says how to fix it", "handler" in str(error))
    else:
        check("ambiguity refused", False, "expected DiscoveryError")


def test_private_helpers_are_not_candidates() -> None:
    contract = discover(
        '''
def _helper(x: str) -> str:
    return x

def handler(a: str) -> str:
    return _helper(a)
'''
    )
    check("underscore functions are ignored", contract["name"] == "handler")


def test_a_named_function_can_be_requested() -> None:
    # Capability targets name the function on the edge (PRD 5), not by convention.
    contract = discover(
        '''
def handler(a: str) -> str:
    return a

def search_docs(query: str, limit: int = 5) -> list[str]:
    """Find previously classified documents."""
    return []
''',
        function="search_docs",
    )
    check("named function wins over convention", contract["name"] == "search_docs")
    check("its docstring is used", contract["description"] == "Find previously classified documents.")


def test_module_docstring_is_the_fallback() -> None:
    contract = discover('"""A function-backed service."""\n\ndef handler(a: str) -> str:\n    return a\n')
    check("module docstring describes the service", contract["description"] == "A function-backed service.")


def test_broken_source_is_a_diagnostic_not_a_crash() -> None:
    try:
        discover("def handler(:\n")
    except DiscoveryError as error:
        check("syntax errors report the line", "line" in str(error))
    else:
        check("syntax error refused", False, "expected DiscoveryError")


def test_async_handlers_are_recognised() -> None:
    contract = discover('async def handler(a: str) -> str:\n    return a\n')
    check("async is reported", contract["isAsync"] is True)


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            print(name)
            fn()
    print(f"\n{PASSED} checks passed")
