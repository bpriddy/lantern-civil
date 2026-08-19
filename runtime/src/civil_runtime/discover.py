"""Read a function's contract out of its source.

PRD 7.2: "the contract — name, description, input and output shape — is read from the
source, not duplicated in a manifest… Editing the function *is* editing the ports. No
second place to disagree."

This lives in the Python package rather than in the TypeScript API for one reason that
matters more than convenience: at M4 the runtime has to bind inputs to this same
function. If the editor discovered the contract one way and the runner bound arguments
another, they would be two implementations of the same question, free to disagree —
which is exactly the second place the PRD is refusing to create.

Static only. Nothing here imports or executes the module under inspection: a project's
code is not Civil's to run at edit time, and importing it would run everything at
module scope.
"""

from __future__ import annotations

import ast
import json
import sys
from typing import Any

#: PRD 7.2: "Entrypoint by convention (declared `entrypoint`, exported handler within
#: it)." A module may hold helpers; this is the one Civil binds to.
HANDLER_NAME = "handler"

#: Python primitives that map cleanly onto JSON Schema. Anything absent from this is
#: reported by name without a schema rather than guessed at — PRD 7.2 says an inferred
#: shape is offered as a proposal, never adopted silently.
_PRIMITIVES: dict[str, dict[str, Any]] = {
    "str": {"type": "string"},
    "int": {"type": "integer"},
    "float": {"type": "number"},
    "bool": {"type": "boolean"},
    "bytes": {"type": "string", "contentEncoding": "base64"},
    "None": {"type": "null"},
    "NoneType": {"type": "null"},
}


class DiscoveryError(Exception):
    """The source could not be read well enough to state a contract."""


def _annotation_name(node: ast.expr | None) -> str | None:
    """The annotation as written, so the node face can show what the author typed."""
    if node is None:
        return None
    try:
        return ast.unparse(node)
    except Exception:  # pragma: no cover - unparse is total on parsed trees
        return None


def _collect_typed_dicts(tree: ast.Module) -> dict[str, ast.ClassDef]:
    """TypedDict classes defined in this module, by name.

    Only this module: following imports would mean resolving the project's whole
    import graph, and a contract that depends on reading five files is one the author
    cannot see by looking at the function.
    """
    found: dict[str, ast.ClassDef] = {}
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        for base in node.bases:
            if _annotation_name(base) in {"TypedDict", "typing.TypedDict"}:
                found[node.name] = node
    return found


def _schema_for(
    annotation: ast.expr | None,
    typed_dicts: dict[str, ast.ClassDef],
    depth: int = 0,
) -> dict[str, Any] | None:
    """A JSON Schema for an annotation, or None when it cannot be known statically."""
    if annotation is None or depth > 4:
        return None

    name = _annotation_name(annotation)
    if name is None:
        return None

    if name in _PRIMITIVES:
        return dict(_PRIMITIVES[name])

    if name in typed_dicts:
        return _typed_dict_schema(typed_dicts[name], typed_dicts, depth + 1)

    # list[X] / dict[K, V] — the container is knowable even when the element is not.
    if isinstance(annotation, ast.Subscript):
        container = _annotation_name(annotation.value)
        if container in {"list", "List", "typing.List", "Sequence"}:
            items = _schema_for(annotation.slice, typed_dicts, depth + 1)
            return {"type": "array", **({"items": items} if items else {})}
        if container in {"dict", "Dict", "typing.Dict", "Mapping"}:
            # PRD 7.2 calls dict[str, Any] the weak case: the shape is genuinely
            # unknown here, and fixtures are what would fill it in (PRD 10).
            return {"type": "object"}
        if container in {"Optional", "typing.Optional"}:
            inner = _schema_for(annotation.slice, typed_dicts, depth + 1)
            return {"anyOf": [inner, {"type": "null"}]} if inner else None

    return None


def _typed_dict_schema(
    cls: ast.ClassDef,
    typed_dicts: dict[str, ast.ClassDef],
    depth: int,
) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []

    for statement in cls.body:
        if not isinstance(statement, ast.AnnAssign) or not isinstance(statement.target, ast.Name):
            continue
        field = statement.target.id
        schema = _schema_for(statement.annotation, typed_dicts, depth)
        properties[field] = schema if schema else {}
        # total=False and NotRequired are not modelled yet; a TypedDict field is
        # required by default and saying otherwise would be a guess.
        required.append(field)

    schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        schema["required"] = required
    return schema


def _find_handler(tree: ast.Module) -> ast.FunctionDef | ast.AsyncFunctionDef:
    functions = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and not node.name.startswith("_")
    ]

    for node in functions:
        if node.name == HANDLER_NAME:
            return node

    # A module with exactly one public function is unambiguous, so requiring the name
    # would be pedantry. Two or more and Civil should not be picking for the author.
    if len(functions) == 1:
        return functions[0]

    if not functions:
        raise DiscoveryError("no public function found to read a contract from")
    names = ", ".join(f.name for f in functions)
    raise DiscoveryError(
        f"several public functions ({names}); name one `{HANDLER_NAME}` so Civil knows which is the entrypoint"
    )


def discover(source: str, *, function: str | None = None) -> dict[str, Any]:
    """The contract of `function`, or of the module's entrypoint by convention."""
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        raise DiscoveryError(f"could not parse: {error.msg} (line {error.lineno})") from error

    typed_dicts = _collect_typed_dicts(tree)

    if function:
        target = next(
            (
                node
                for node in tree.body
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and node.name == function
            ),
            None,
        )
        if target is None:
            raise DiscoveryError(f"no function named {function!r}")
    else:
        target = _find_handler(tree)

    inputs = []
    arguments = target.args
    positional = arguments.posonlyargs + arguments.args
    # Defaults bind to the tail of the positional list.
    first_defaulted = len(positional) - len(arguments.defaults)

    for index, argument in enumerate(positional):
        if argument.arg in {"self", "cls"}:
            continue
        inputs.append(
            {
                "name": argument.arg,
                "type": _annotation_name(argument.annotation),
                "schema": _schema_for(argument.annotation, typed_dicts),
                "required": index < first_defaulted,
            }
        )

    for argument in arguments.kwonlyargs:
        inputs.append(
            {
                "name": argument.arg,
                "type": _annotation_name(argument.annotation),
                "schema": _schema_for(argument.annotation, typed_dicts),
                "required": False,
            }
        )

    # A function-backed service often documents itself at module level rather than on
    # the handler — the module IS the service. Fall back to that before giving up.
    docstring = ast.get_docstring(target) or ast.get_docstring(tree)

    return {
        "name": target.name,
        # First line only: the node face has one line to spend, and the rest of a
        # docstring belongs in the editor.
        "description": docstring.strip().split("\n")[0] if docstring else None,
        "isAsync": isinstance(target, ast.AsyncFunctionDef),
        "inputs": inputs,
        "output": {
            "type": _annotation_name(target.returns),
            "schema": _schema_for(target.returns, typed_dicts),
        },
    }


def main() -> int:
    """Reads a batch of sources on stdin, writes their contracts on stdout.

    Batched because a project has many code nodes and spawning an interpreter per node
    would make opening a canvas cost a process per port. One process answers the whole
    bundle.

    Source arrives as text rather than as paths because the file Civil is looking at
    may exist only as a pending change in Postgres or as a blob in GitHub — see
    CLAUDE.md on not writing to the container filesystem.
    """
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError as error:
        json.dump({"error": f"malformed request: {error}"}, sys.stdout)
        return 1

    results: dict[str, Any] = {}
    for item in request.get("requests", []):
        key = item.get("key")
        if not isinstance(key, str):
            continue
        try:
            results[key] = discover(item.get("source", ""), function=item.get("function"))
        except DiscoveryError as error:
            # A contract that cannot be read is a diagnostic on one node, not a failure
            # of the batch: the rest of the canvas should still draw.
            results[key] = {"error": str(error)}

    json.dump({"results": results}, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
