"""Lift: a graph's emitted orchestration read back into its flow edges.

The inverse of transpile's orchestration emission (docs/lift.md). The transpiler
emits each graph's run() as a straight-line body — assignments, calls, a return,
in topological order — and the validators enforce that shape precisely so this is
a parse, not an inference. Flow edges only; capability edges and tool calls are
transpile's business, not run()'s.

No model, no network: pure ast plus a tolerant scan of the graph document for its
node ids and paths (the caller's yaml is a stub in tests, so pyyaml is avoided).
"""

from __future__ import annotations

import ast
import re

# The transpiler names a call after its node: `... import handler as normalize`
# makes `normalize(...)` the normalize node. Node identity resolves by that alias
# first; the import module path is the fallback when an alias was not reused.
_ID = r"[a-z][a-z0-9_-]*"
_NODE_ID_LINE = re.compile(rf"\bid:\s*['\"]?({_ID})['\"]?")
_PATH_KEY = re.compile(rf"\b(?:entrypoint|ref):\s*['\"]?([^\s'\"}}]+)['\"]?")


class LiftError(Exception):
    """A bad request the caller answers 400 — not an unliftable run(), which is a
    lawful 200 answer the graph simply cannot represent."""


def _module_of(path: str) -> str:
    """A repo path as the dotted module the emitted code imports it by:
    src/steps/normalize/main.py -> src.steps.normalize.main; a graph ref
    graphs/enrich.graph.yaml -> graphs.enrich (its emitted module stem)."""
    stem = re.sub(r"\.graph\.ya?ml$", "", path)
    stem = re.sub(r"\.(py|ya?ml)$", "", stem)
    return stem.replace("/", ".")


def _graph_nodes(graph_doc: str) -> tuple[set[str], set[str], dict[str, str]]:
    """Node ids, the io node ids among them, and module->nodeId for the fallback.
    Tolerant line scan: the document is Civil's own emission of a known shape, and
    the test suite stubs pyyaml, so this stays regex-simple on purpose."""
    node_ids: set[str] = set()
    io_ids: set[str] = set()
    module_to_node: dict[str, str] = {}
    in_edges = False
    for raw in graph_doc.splitlines():
        line = raw.strip()
        if line.startswith("edges:"):
            in_edges = True
        elif line.startswith(("nodes:", "layout:")):
            in_edges = False
        # Node ids live on node lines and edge endpoints alike; edge endpoints are
        # `from`/`to`, never new nodes, so ignore ids once inside edges.
        if in_edges:
            continue
        m = _NODE_ID_LINE.search(line)
        if not m:
            continue
        node_id = m.group(1)
        node_ids.add(node_id)
        if "type: io" in line or "type:io" in line:
            io_ids.add(node_id)
        path = _PATH_KEY.search(line)
        if path:
            module_to_node[_module_of(path.group(1))] = node_id
    return node_ids, io_ids, module_to_node


def _run_function(tree: ast.Module) -> ast.FunctionDef | ast.AsyncFunctionDef | None:
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "run":
            return node
    return None


_CONTROL_FLOW = (ast.If, ast.While, ast.For, ast.AsyncFor, ast.Try, ast.With, ast.AsyncWith)


def _call_symbol(call: ast.Call) -> str | None:
    """The name a call is made by: bare `normalize(...)` or `mod.normalize(...)`."""
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _import_modules(tree: ast.Module) -> dict[str, str]:
    """alias -> imported module, so an alias that is not itself a node id can still
    resolve through the module path (the fallback the seam specifies)."""
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for name in node.names:
                aliases[name.asname or name.name] = node.module
    return aliases


def lift_graph(graph_path: str, graph_doc: str, orchestration: str) -> dict:
    """Flow edges recovered from the orchestration's run(), or unliftable with a
    reason the canvas cannot swallow (control flow, or a symbol that is no node)."""
    node_ids, io_ids, module_to_node = _graph_nodes(graph_doc)
    if not node_ids:
        return {"edges": [], "unliftable": True, "reason": f"{graph_path} declares no nodes"}

    try:
        tree = ast.parse(orchestration)
    except SyntaxError as error:
        raise LiftError(f"orchestration does not parse: {error.msg} (line {error.lineno})")

    run = _run_function(tree)
    if run is None:
        return {"edges": [], "unliftable": True, "reason": "no run() function to read"}

    for node in ast.walk(run):
        if isinstance(node, _CONTROL_FLOW):
            return {
                "edges": [],
                "unliftable": True,
                "reason": "run() has control flow the canvas does not represent",
            }

    import_aliases = _import_modules(tree)

    def resolve(symbol: str) -> str | None:
        if symbol in node_ids:
            return symbol
        module = import_aliases.get(symbol)
        if module and module in module_to_node:
            return module_to_node[module]
        return None

    io_in = next(iter(_graph_io_dir(graph_doc, "in")), None)
    io_out_ids = _graph_io_dir(graph_doc, "out")

    # Which node produced each variable. The single parameter is the io-in node's
    # output; every other var is produced by the call assigned to it.
    producer: dict[str, str] = {}
    params = run.args.args
    if params and io_in:
        producer[params[0].arg] = io_in

    edges: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add_edge(src: str, dst: str) -> None:
        key = (src, dst)
        if src != dst and key not in seen:
            seen.add(key)
            edges.append({"from": src, "to": dst})

    for stmt in run.body:
        call = _assignment_call(stmt)
        if call is not None:
            target, node_call = call
            symbol = _call_symbol(node_call)
            resolved = symbol and resolve(symbol)
            if not resolved:
                return {
                    "edges": [],
                    "unliftable": True,
                    "reason": f"call to {symbol!r} resolves to no node",
                }
            for arg in _call_arg_names(node_call):
                if arg in producer:
                    add_edge(producer[arg], resolved)
            if target is not None:
                producer[target] = resolved
        elif isinstance(stmt, ast.Return) and isinstance(stmt.value, ast.Name):
            src = producer.get(stmt.value.id)
            # The returned var names its io-out node when their ids coincide (the
            # transpiler's convention); failing that, a lone io-out node is
            # unambiguous. Several io-out nodes with no id match is unliftable —
            # guessing which one the return feeds is exactly the inference the
            # straight-line convention exists to avoid.
            io_out = (
                stmt.value.id if stmt.value.id in io_out_ids
                else io_out_ids[0] if len(io_out_ids) == 1
                else None
            )
            if src and io_out:
                add_edge(src, io_out)

    return {"edges": edges, "unliftable": False}


def _assignment_call(stmt: ast.stmt) -> tuple[str | None, ast.Call] | None:
    """`x = fn(...)` -> ('x', call); a bare `fn(...)` expression -> (None, call)."""
    if isinstance(stmt, ast.Assign) and isinstance(stmt.value, ast.Call):
        target = stmt.targets[0]
        return (target.id if isinstance(target, ast.Name) else None, stmt.value)
    if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.value, ast.Call):
        return (stmt.target.id if isinstance(stmt.target, ast.Name) else None, stmt.value)
    if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Call):
        return (None, stmt.value)
    return None


def _call_arg_names(call: ast.Call) -> list[str]:
    names: list[str] = []
    for arg in call.args:
        if isinstance(arg, ast.Name):
            names.append(arg.id)
    for kw in call.keywords:
        if isinstance(kw.value, ast.Name):
            names.append(kw.value.id)
    return names


def _graph_io_dir(graph_doc: str, direction: str) -> list[str]:
    """io node ids of a direction, in document order. The first io-in is the
    run() parameter's node; a lone io-out is what a bare return feeds."""
    ids: list[str] = []
    needle = f"direction: {direction}"
    for raw in graph_doc.splitlines():
        line = raw.strip()
        if needle in line or needle.replace(" ", "") in line:
            m = _NODE_ID_LINE.search(line)
            if m:
                ids.append(m.group(1))
    return ids
