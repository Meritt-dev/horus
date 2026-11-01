"""Go parser using tree-sitter (HOR-SOURCE).

Extracts symbols (functions, methods, struct/interface type declarations), imports,
and call expressions from Go source via tree-sitter-go, into the shared intermediate
``ParseResult`` consumed by the 12-phase ingestion pipeline.

Mapping (same node taxonomy as the Python/TS parsers):
  * ``func F(...)``                  → kind ``function``
  * ``func (r *T) M(...)``           → kind ``method``; ``class_name`` = receiver type ``T``
  * ``type T struct {...}``          → kind ``class`` (the class-equivalent)
  * ``type T interface {...}``       → kind ``interface``
  * ``type T = U`` / ``type T U``    → kind ``type_alias``
  * ``import``                       → ``ImportInfo`` (path; alias when named)
  * ``f()`` / ``x.M()``              → ``CallInfo`` (with receiver for selector calls)

Go exports are implicit (a symbol is exported iff its name starts with an uppercase
letter), so we mark such names in ``exports`` rather than parsing an export keyword.

Language-specific note (v1): Go interface satisfaction is IMPLICIT (no ``implements``
keyword), so v1 ships WITHOUT implicit-interface heritage edges; struct embedding and
method-set matching are a follow-up. This is a deliberate scope call, not a parser limit.
"""

from __future__ import annotations

import tree_sitter_go as tsgo
from tree_sitter import Language, Node, Parser

from horus_source.core.parsers.base import (
    CallInfo,
    ImportInfo,
    LanguageParser,
    ParseResult,
    SymbolInfo,
    TypeRef,
)

GO_LANGUAGE = Language(tsgo.language())


# Go predeclared types — never repo symbols, skip as type-ref noise.
_GO_BUILTIN_TYPES: frozenset[str] = frozenset({
    "string", "bool", "byte", "rune", "error", "any",
    "int", "int8", "int16", "int32", "int64",
    "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
    "float32", "float64", "complex64", "complex128",
})

def _is_exported(name: str) -> bool:
    """Go visibility: a symbol is exported iff its first letter is uppercase."""
    return bool(name) and name[0].isupper()


def _receiver_type(receiver_text: str) -> str:
    """Extract the bare type name from a receiver clause, e.g. ``(s *Server)`` → ``Server``.

    Handles ``(s Server)``, ``(s *Server)``, ``(*Server)``, and generic ``(s *Server[T])``.
    """
    inner = receiver_text.strip().lstrip("(").rstrip(")").strip()
    # Last whitespace-separated token is the type (drop the optional receiver name).
    type_part = inner.split()[-1] if inner else ""
    type_part = type_part.lstrip("*")
    # Drop type parameters / package qualifiers: Server[T] → Server, pkg.T → T.
    type_part = type_part.split("[", 1)[0]
    if "." in type_part:
        type_part = type_part.rsplit(".", 1)[-1]
    return type_part


class GoParser(LanguageParser):
    """Parse Go source files via tree-sitter."""

    def __init__(self) -> None:
        self._parser = Parser(GO_LANGUAGE)

    def parse(self, content: str, file_path: str) -> ParseResult:
        tree = self._parser.parse(content.encode("utf-8"))
        result = ParseResult()
        self._walk(tree.root_node, content, result)
        return result

    def _walk(
        self, node: Node, source: str, result: ParseResult, visited: set[int] | None = None
    ) -> None:
        if visited is None:
            visited = set()
        if node.id in visited:
            return
        visited.add(node.id)

        ntype = node.type
        if ntype == "function_declaration":
            self._extract_function(node, result)
        elif ntype == "method_declaration":
            self._extract_method(node, result)
        elif ntype == "type_declaration":
            self._extract_type_declaration(node, result)
        elif ntype == "import_declaration":
            self._extract_import(node, result)
        elif ntype == "call_expression":
            self._extract_call(node, result)
        elif ntype == "composite_literal":
            # `Form{}` / `var Form = formBinding{}` — Go's dominant way of USING a
            # type. Without this edge, private-but-used types read as dead and
            # impact on structs is empty (dogfood cycle-2 N7).
            self._extract_composite_literal_type(node, result)
        elif ntype in ("parameter_declaration", "field_declaration"):
            # func params/results + struct fields — type-annotation references.
            self._extract_declared_types(node, result)

        for child in node.children:
            self._walk(child, source, result, visited)

    # -- declarations ---------------------------------------------------------

    def _signature(self, node: Node, name: str) -> str:
        """First line of the declaration (the func/type header), trimmed."""
        first_line = node.text.decode().splitlines()[0] if node.text else name
        return first_line.strip().rstrip("{").strip()

    def _extract_function(self, node: Node, result: ParseResult) -> None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return
        name = name_node.text.decode()
        self._extract_result_types(node, result)
        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="function",
                start_line=node.start_point[0] + 1,
                end_line=node.end_point[0] + 1,
                content=node.text.decode(),
                signature=self._signature(node, name),
            )
        )
        if _is_exported(name):
            result.exports.append(name)

    def _extract_method(self, node: Node, result: ParseResult) -> None:
        name_node = node.child_by_field_name("name")
        receiver_node = node.child_by_field_name("receiver")
        if name_node is None:
            return
        self._extract_result_types(node, result)
        name = name_node.text.decode()
        owner = _receiver_type(receiver_node.text.decode()) if receiver_node else ""
        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="method",
                start_line=node.start_point[0] + 1,
                end_line=node.end_point[0] + 1,
                content=node.text.decode(),
                signature=self._signature(node, name),
                class_name=owner,
            )
        )
        if _is_exported(name):
            result.exports.append(name)

    def _extract_type_declaration(self, node: Node, result: ParseResult) -> None:
        """A ``type_declaration`` holds one or more ``type_spec`` (grouped ``type (...)``)."""
        for spec in node.children:
            if spec.type != "type_spec" and spec.type != "type_alias":
                continue
            name_node = spec.child_by_field_name("name")
            if name_node is None:
                continue
            name = name_node.text.decode()
            # Classify by the underlying type node.
            underlying = spec.child_by_field_name("type")
            if spec.type == "type_alias":
                kind = "type_alias"
            elif underlying is not None and underlying.type == "struct_type":
                kind = "class"
            elif underlying is not None and underlying.type == "interface_type":
                kind = "interface"
            else:
                kind = "type_alias"
            result.symbols.append(
                SymbolInfo(
                    name=name,
                    kind=kind,
                    start_line=spec.start_point[0] + 1,
                    end_line=spec.end_point[0] + 1,
                    content=spec.text.decode(),
                    signature=self._signature(spec, name),
                )
            )
            if _is_exported(name):
                result.exports.append(name)

    def _collect_type_identifiers(self, node: Node) -> list[Node]:
        """All type_identifier descendants (including *node* itself)."""
        found: list[Node] = []
        stack = [node]
        while stack:
            n = stack.pop()
            if n.type == "type_identifier":
                found.append(n)
            stack.extend(n.children)
        return found

    def _emit_type_refs(self, node: Node, kind: str, result: ParseResult) -> None:
        for ident in self._collect_type_identifiers(node):
            name = ident.text.decode()
            if name in _GO_BUILTIN_TYPES:
                continue
            result.type_refs.append(
                TypeRef(name=name, kind=kind, line=ident.start_point[0] + 1)
            )

    def _extract_result_types(self, node: Node, result: ParseResult) -> None:
        """Return types: a bare `*Engine` result is NOT a parameter_declaration, so the
        _walk dispatch never sees it — emit from the function's `result` field. (A
        parenthesized result list IS parameter_declarations; those are deduped by the
        uses_type edge id, so double-emission is harmless.)"""
        result_node = node.child_by_field_name("result")
        if result_node is not None:
            self._emit_type_refs(result_node, "return", result)

    def _extract_composite_literal_type(self, node: Node, result: ParseResult) -> None:
        type_node = node.child_by_field_name("type")
        if type_node is not None:
            self._emit_type_refs(type_node, "variable", result)

    def _extract_declared_types(self, node: Node, result: ParseResult) -> None:
        type_node = node.child_by_field_name("type")
        if type_node is not None:
            kind = "param" if node.type == "parameter_declaration" else "variable"
            self._emit_type_refs(type_node, kind, result)

    # -- imports --------------------------------------------------------------

    def _extract_import(self, node: Node, result: ParseResult) -> None:
        """Handle single and grouped imports; capture path + alias (named import)."""
        for spec in self._import_specs(node):
            path_node = spec.child_by_field_name("path")
            if path_node is None:
                continue
            module = path_node.text.decode().strip('"`')
            alias_node = spec.child_by_field_name("name")
            alias = alias_node.text.decode() if alias_node is not None else ""
            # `names` carries the last path segment (the default package identifier).
            last_segment = module.rsplit("/", 1)[-1]
            result.imports.append(
                ImportInfo(module=module, names=[last_segment], alias=alias)
            )

    def _import_specs(self, node: Node) -> list[Node]:
        specs: list[Node] = []
        for child in node.children:
            if child.type == "import_spec":
                specs.append(child)
            elif child.type == "import_spec_list":
                specs.extend(c for c in child.children if c.type == "import_spec")
        return specs

    # -- calls ----------------------------------------------------------------

    def _extract_call(self, node: Node, result: ParseResult) -> None:
        func_node = node.child_by_field_name("function")
        if func_node is None:
            return
        line = node.start_point[0] + 1
        if func_node.type == "selector_expression":
            operand = func_node.child_by_field_name("operand")
            field = func_node.child_by_field_name("field")
            if field is not None:
                result.calls.append(
                    CallInfo(
                        name=field.text.decode(),
                        line=line,
                        receiver=operand.text.decode() if operand is not None else "",
                    )
                )
        elif func_node.type == "identifier":
            result.calls.append(CallInfo(name=func_node.text.decode(), line=line))
