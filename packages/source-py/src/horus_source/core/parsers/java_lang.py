"""Java parser using tree-sitter (HOR-SOURCE).

Extracts symbols (classes, records, enums, interfaces, methods/constructors), imports,
calls, annotations, and heritage (extends / implements) from Java source via
tree-sitter-java, into the shared ``ParseResult`` IR.

Mapping (same node taxonomy as the Python/TS/Go parsers):
  * ``class C`` / ``record R(...)``  → kind ``class`` (the class-equivalent)
  * ``enum E``                       → kind ``enum``
  * ``interface I``                  → kind ``interface``
  * methods / constructors           → kind ``method``; ``class_name`` = enclosing type
  * ``extends`` / ``implements``     → ``heritage`` (explicit — maps onto the existing
                                       heritage phase, unlike Go's implicit interfaces)
  * ``@RestController`` / ``@GetMapping("/x")`` → ``decorators`` + ``decorator_args``
                                       (reuses the decorator-driven entrypoint detection)
  * ``import a.b.C;`` / ``import a.b.*;`` → ``ImportInfo``
  * ``obj.method(...)`` / ``method(...)`` → ``CallInfo``
"""

from __future__ import annotations

import tree_sitter_java as tsjava
from tree_sitter import Language, Node, Parser

from horus_source.core.parsers.base import (
    CallInfo,
    ImportInfo,
    LanguageParser,
    ParseResult,
    SymbolInfo,
)

JAVA_LANGUAGE = Language(tsjava.language())

_TYPE_DECLS = {
    "class_declaration": "class",
    "record_declaration": "class",
    "enum_declaration": "enum",
    "interface_declaration": "interface",
}


class JavaParser(LanguageParser):
    """Parse Java source files via tree-sitter."""

    def __init__(self) -> None:
        self._parser = Parser(JAVA_LANGUAGE)

    def parse(self, content: str, file_path: str) -> ParseResult:
        tree = self._parser.parse(content.encode("utf-8"))
        result = ParseResult()
        self._walk(tree.root_node, result)
        return result

    def _walk(self, node: Node, result: ParseResult, visited: set[int] | None = None) -> None:
        if visited is None:
            visited = set()
        if node.id in visited:
            return
        visited.add(node.id)

        ntype = node.type
        if ntype in _TYPE_DECLS:
            self._extract_type(node, result, visited)
        elif ntype == "import_declaration":
            self._extract_import(node, result)
        elif ntype == "method_invocation":
            self._extract_call(node, result)

        for child in node.children:
            self._walk(child, result, visited)

    # -- annotations ----------------------------------------------------------

    def _extract_annotations(self, node: Node) -> tuple[list[str], list[str]]:
        """Read annotations from a declaration's ``modifiers`` child → (names, string-args)."""
        names: list[str] = []
        args: list[str] = []
        modifiers = next((c for c in node.children if c.type == "modifiers"), None)
        if modifiers is None:
            return names, args
        for child in modifiers.children:
            if child.type not in ("annotation", "marker_annotation"):
                continue
            name_node = child.child_by_field_name("name")
            if name_node is not None:
                names.append(name_node.text.decode())
            # String-literal arguments (route/queue/job names) — flattened.
            arg_list = child.child_by_field_name("arguments")
            if arg_list is not None:
                args.extend(self._string_literals(arg_list))
        return names, args

    def _is_exported(self, node: Node) -> bool:
        """Java visibility: ``public``/``protected`` declarations are API surface.

        Mirrors Rust ``pub`` and Go's uppercase rule so exported Java symbols are
        exempt from dead-code (an uncalled public method is API, not dead). The
        modifiers child carries visibility keywords as typed children.
        """
        modifiers = next((c for c in node.children if c.type == "modifiers"), None)
        if modifiers is None:
            return False
        return any(child.type in ("public", "protected") for child in modifiers.children)

    def _string_literals(self, node: Node) -> list[str]:
        out: list[str] = []
        for desc in self._descendants(node):
            if desc.type == "string_literal":
                out.append(desc.text.decode().strip('"'))
        return out

    def _descendants(self, node: Node) -> list[Node]:
        acc: list[Node] = []
        stack = list(node.children)
        while stack:
            n = stack.pop()
            acc.append(n)
            stack.extend(n.children)
        return acc

    # -- type declarations ----------------------------------------------------

    def _extract_type(self, node: Node, result: ParseResult, visited: set[int]) -> None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return
        name = name_node.text.decode()
        kind = _TYPE_DECLS[node.type]
        decorators, decorator_args = self._extract_annotations(node)

        result.symbols.append(
            SymbolInfo(
                name=name,
                kind=kind,
                start_line=node.start_point[0] + 1,
                end_line=node.end_point[0] + 1,
                content=node.text.decode(),
                signature=self._header(node),
                decorators=decorators,
                decorator_args=decorator_args,
            )
        )
        if self._is_exported(node):
            result.exports.append(name)

        # Heritage (explicit): superclass + super_interfaces.
        self._extract_heritage(name, node, result)

        # Methods + constructors are owned by this type. Walk the body, marking each
        # visited so the generic _walk doesn't double-process them.
        body = node.child_by_field_name("body")
        if body is not None:
            in_interface = node.type == "interface_declaration"
            for member in body.children:
                if member.type in ("method_declaration", "constructor_declaration"):
                    self._extract_method(member, name, result, in_interface=in_interface)

    def _extract_heritage(self, class_name: str, node: Node, result: ParseResult) -> None:
        for child in node.children:
            if child.type == "superclass":
                for sub in child.children:
                    if sub.type in ("type_identifier", "scoped_type_identifier", "generic_type"):
                        result.heritage.append((class_name, "extends", self._type_name(sub)))
            elif child.type in ("super_interfaces", "extends_interfaces"):
                for sub in self._descendants(child):
                    if sub.type in ("type_identifier", "scoped_type_identifier"):
                        result.heritage.append((class_name, "implements", self._type_name(sub)))

    def _type_name(self, node: Node) -> str:
        if node.type == "generic_type":
            inner = node.child_by_field_name("name")
            if inner is not None:
                return inner.text.decode()
        text = node.text.decode()
        return text.rsplit(".", 1)[-1]  # scoped a.b.C → C

    def _extract_method(
        self, node: Node, owner: str, result: ParseResult, *, in_interface: bool = False
    ) -> None:
        # NOTE: do NOT mark the method visited — the generic _walk must still descend into
        # the body to capture method_invocation calls. _walk doesn't dispatch on
        # method_declaration, so the symbol is added here exactly once (no double-count).
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return
        name = name_node.text.decode()
        decorators, decorator_args = self._extract_annotations(node)
        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="method",
                start_line=node.start_point[0] + 1,
                end_line=node.end_point[0] + 1,
                content=node.text.decode(),
                signature=self._header(node),
                class_name=owner,
                decorators=decorators,
                decorator_args=decorator_args,
            )
        )
        # Interface members are IMPLICITLY public (no modifier keyword in source),
        # so the explicit public/protected check alone would wrongly leave API
        # contract methods un-exported (and dead-code would flag them).
        if in_interface or self._is_exported(node):
            result.exports.append(name)

    def _header(self, node: Node) -> str:
        """The declaration header (up to the opening brace), single-lined + trimmed."""
        text = node.text.decode()
        head = text.split("{", 1)[0]
        return " ".join(head.split()).strip()

    # -- imports --------------------------------------------------------------

    def _extract_import(self, node: Node, result: ParseResult) -> None:
        # import a.b.C;  |  import a.b.*;  |  import static a.b.C.m;
        raw = node.text.decode().strip()
        raw = raw[len("import"):].strip().rstrip(";").strip()
        if raw.startswith("static "):
            raw = raw[len("static "):].strip()
        if not raw:
            return
        last = raw.rsplit(".", 1)[-1]
        result.imports.append(ImportInfo(module=raw, names=[last]))

    # -- calls ----------------------------------------------------------------

    def _extract_call(self, node: Node, result: ParseResult) -> None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return
        obj_node = node.child_by_field_name("object")
        result.calls.append(
            CallInfo(
                name=name_node.text.decode(),
                line=node.start_point[0] + 1,
                receiver=obj_node.text.decode() if obj_node is not None else "",
            )
        )
