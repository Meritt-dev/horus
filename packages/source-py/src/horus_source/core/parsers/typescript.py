"""TypeScript / TSX / JavaScript parser using tree-sitter.

Extracts symbols (functions, classes, methods, interfaces, type aliases),
imports, call expressions, type annotation references, and heritage
(extends / implements) relationships from TypeScript, TSX, and JavaScript
source files.
"""

from __future__ import annotations

import tree_sitter_javascript as tsjavascript
import tree_sitter_typescript as tstypescript
from tree_sitter import Language, Node, Parser

from horus_source.core.parsers.base import (
    CallInfo,
    ImportInfo,
    LanguageParser,
    ParseResult,
    SymbolInfo,
    TypeRef,
)

TS_LANGUAGE = Language(tstypescript.language_typescript())
TSX_LANGUAGE = Language(tstypescript.language_tsx())
JS_LANGUAGE = Language(tsjavascript.language())

_DIALECT_MAP: dict[str, Language] = {
    "typescript": TS_LANGUAGE,
    "tsx": TSX_LANGUAGE,
    "javascript": JS_LANGUAGE,
}

_BUILTIN_TYPES: frozenset[str] = frozenset(
    {
        "string",
        "number",
        "boolean",
        "void",
        "any",
        "unknown",
        "never",
        "null",
        "undefined",
        "object",
    }
)

class TypeScriptParser(LanguageParser):
    """Parse TypeScript, TSX, or JavaScript files via tree-sitter.

    Args:
        dialect: One of ``"typescript"``, ``"tsx"``, or ``"javascript"``.
    """

    def __init__(self, dialect: str = "typescript") -> None:
        if dialect not in _DIALECT_MAP:
            raise ValueError(
                f"Unknown dialect {dialect!r}. "
                f"Expected one of: {', '.join(sorted(_DIALECT_MAP))}"
            )
        self.dialect = dialect
        self._language = _DIALECT_MAP[dialect]
        self._parser = Parser(self._language)

    def parse(self, content: str, file_path: str) -> ParseResult:
        """Parse *content* and return an intermediate :class:`ParseResult`."""
        tree = self._parser.parse(content.encode("utf-8"))

        result = ParseResult()
        self._walk(tree.root_node, content, result)
        return result

    def _walk(
        self, node: Node, source: str, result: ParseResult, visited: set[int] | None = None
    ) -> None:
        """Walk the tree recursively, dispatching on node type.

        Uses a *visited* set (keyed by node ``id``) to avoid processing
        the same subtree twice — e.g. class bodies that are walked by both
        ``_extract_class`` and the generic child recursion.
        """
        if visited is None:
            visited = set()

        node_key = node.id
        if node_key in visited:
            return
        visited.add(node_key)

        ntype = node.type

        if ntype == "export_statement":
            self._extract_export(node, source, result)
        elif ntype == "function_declaration":
            self._extract_function_declaration(node, source, result)
        elif ntype in ("lexical_declaration", "variable_declaration"):
            self._extract_variable_declaration(node, source, result)
        elif ntype == "class_declaration":
            self._extract_class(node, source, result)
        elif ntype == "interface_declaration":
            self._extract_interface(node, source, result)
        elif ntype == "type_alias_declaration":
            self._extract_type_alias(node, source, result)
        elif ntype == "import_statement":
            self._extract_import(node, source, result)
        elif ntype == "call_expression":
            self._extract_call(node, source, result)
        elif ntype == "new_expression":
            self._extract_new_expression(node, source, result)
        elif ntype == "expression_statement":
            self._maybe_extract_module_exports(node, source, result)
        elif ntype == "method_definition":
            self._extract_method(node, source, result)

        for child in node.children:
            self._walk(child, source, result, visited)

    def _extract_export(
        self, node: Node, source: str, result: ParseResult
    ) -> None:
        """Handle ``export`` statements — mark exported symbol names.

        Handles ``export function foo()``, ``export class Bar``,
        ``export const baz = ...``, and ``export { name1, name2 }``.
        """
        for child in node.children:
            if child.type in (
                "function_declaration",
                "class_declaration",
                "interface_declaration",
                "type_alias_declaration",
            ):
                name_node = child.child_by_field_name("name")
                if name_node is not None:
                    result.exports.append(name_node.text.decode())
            elif child.type in ("lexical_declaration", "variable_declaration"):
                for sub in child.children:
                    if sub.type == "variable_declarator":
                        name_node = sub.child_by_field_name("name")
                        if name_node is not None:
                            result.exports.append(name_node.text.decode())
            elif child.type == "export_clause":
                # export { name1, name2 }
                for spec in child.children:
                    if spec.type == "export_specifier":
                        name_node = spec.child_by_field_name("name")
                        if name_node is not None:
                            result.exports.append(name_node.text.decode())

    def _maybe_extract_module_exports(
        self, node: Node, source: str, result: ParseResult
    ) -> None:
        """Handle ``module.exports = X``, ``module.exports = { A, B }``,
        and ``exports.name = fn`` / ``module.exports.name = fn``."""
        for child in node.children:
            if child.type != "assignment_expression":
                continue
            left = child.child_by_field_name("left")
            right = child.child_by_field_name("right")
            if left is None or right is None:
                continue

            left_text = left.text.decode()

            if left_text in ("module.exports", "exports"):
                if right.type == "identifier":
                    result.exports.append(right.text.decode())
                elif right.type == "object":
                    # module.exports = { Foo, Bar, baz: something }
                    for prop in right.children:
                        if prop.type == "shorthand_property_identifier":
                            result.exports.append(prop.text.decode())
                        elif prop.type == "pair":
                            key_node = prop.child_by_field_name("key")
                            if key_node is not None:
                                result.exports.append(key_node.text.decode())
                continue

            # exports.X = fn / module.exports.X = fn
            if left.type != "member_expression":
                continue
            obj_node = left.child_by_field_name("object")
            prop_node = left.child_by_field_name("property")
            if obj_node is None or prop_node is None:
                continue
            obj_text = obj_node.text.decode()
            if obj_text not in ("exports", "module.exports"):
                continue

            sym_name = prop_node.text.decode()
            result.exports.append(sym_name)

            func_node = self._unwrap_to_function(right)
            if func_node is not None:
                start_line = child.start_point[0] + 1
                end_line = child.end_point[0] + 1
                content = child.text.decode()
                signature = self._build_function_signature(func_node, sym_name)
                result.symbols.append(
                    SymbolInfo(
                        name=sym_name,
                        kind="function",
                        start_line=start_line,
                        end_line=end_line,
                        content=content,
                        signature=signature,
                    )
                )
                self._extract_function_types(func_node, sym_name, result)

    def _extract_function_declaration(
        self, node: Node, source: str, result: ParseResult
    ) -> None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return

        name = name_node.text.decode()
        start_line = node.start_point[0] + 1
        end_line = node.end_point[0] + 1
        content = node.text.decode()
        signature = self._build_function_signature(node, name)

        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="function",
                start_line=start_line,
                end_line=end_line,
                content=content,
                signature=signature,
            )
        )

        self._extract_function_types(node, name, result)

    def _extract_method(self, node: Node, source: str, result: ParseResult) -> None:
        """Extract a method_definition inside a class body."""
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return

        name = name_node.text.decode()
        start_line = node.start_point[0] + 1
        end_line = node.end_point[0] + 1
        content = node.text.decode()

        class_name = self._find_parent_class_name(node)

        signature = self._build_function_signature(node, name)

        decorators, decorator_args = self._extract_decorators(node)

        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="method",
                start_line=start_line,
                end_line=end_line,
                content=content,
                signature=signature,
                class_name=class_name,
                decorators=decorators,
                decorator_args=decorator_args,
            )
        )

        self._extract_function_types(node, name, result)

    def _extract_variable_declaration(
        self, node: Node, source: str, result: ParseResult
    ) -> None:
        """Handle arrow functions, function expressions, and require() calls."""
        for child in node.children:
            if child.type != "variable_declarator":
                continue

            name_node = child.child_by_field_name("name")
            value_node = child.child_by_field_name("value")
            if name_node is None or value_node is None:
                continue

            var_name = name_node.text.decode()

            if value_node.type in ("arrow_function", "function_expression"):
                self._extract_assigned_function(child, var_name, value_node, result)
            elif value_node.type == "call_expression":
                self._maybe_extract_require(child, var_name, value_node, result)

            self._extract_variable_type_annotation(child, result)

    def _extract_assigned_function(
        self,
        declarator_node: Node,
        name: str,
        func_node: Node,
        result: ParseResult,
    ) -> None:
        """Extract an arrow function or function expression assigned to a variable."""
        outer = declarator_node.parent
        if outer is None:
            outer = declarator_node

        start_line = outer.start_point[0] + 1
        end_line = outer.end_point[0] + 1
        content = outer.text.decode()
        signature = self._build_function_signature(func_node, name)

        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="function",
                start_line=start_line,
                end_line=end_line,
                content=content,
                signature=signature,
            )
        )

        self._extract_function_types(func_node, name, result)

    def _maybe_extract_require(
        self,
        declarator_node: Node,
        var_name: str,
        call_node: Node,
        result: ParseResult,
    ) -> None:
        """If the call is ``require('./foo')``, emit an ImportInfo."""
        func_node = call_node.child_by_field_name("function")
        if func_node is None or func_node.text.decode() != "require":
            return

        args = call_node.child_by_field_name("arguments")
        if args is None:
            return

        module_str = ""
        for arg_child in args.children:
            if arg_child.type == "string":
                module_str = self._string_value(arg_child)
                break

        if not module_str:
            return

        result.imports.append(
            ImportInfo(
                module=module_str,
                names=[var_name],
                is_relative=module_str.startswith("."),
            )
        )

    def _extract_class(self, node: Node, source: str, result: ParseResult) -> None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return

        name = name_node.text.decode()
        start_line = node.start_point[0] + 1
        end_line = node.end_point[0] + 1
        content = node.text.decode()

        decorators, decorator_args = self._extract_decorators(node)
        di_fields = self._extract_di_fields(node)

        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="class",
                start_line=start_line,
                end_line=end_line,
                content=content,
                decorators=decorators,
                decorator_args=decorator_args,
                di_fields=di_fields,
            )
        )

        for child in node.children:
            if child.type == "class_heritage":
                self._extract_class_heritage(name, child, result)

    def _extract_class_heritage(
        self, class_name: str, heritage_node: Node, result: ParseResult
    ) -> None:
        for child in heritage_node.children:
            if child.type == "extends_clause":
                for sub in child.children:
                    if sub.type in ("identifier", "type_identifier"):
                        result.heritage.append((class_name, "extends", sub.text.decode()))
                    elif sub.type == "generic_type":
                        name_node = sub.child_by_field_name("name")
                        if name_node is not None:
                            result.heritage.append((class_name, "extends", name_node.text.decode()))
            elif child.type == "implements_clause":
                for sub in child.children:
                    if sub.type in ("identifier", "type_identifier"):
                        result.heritage.append((class_name, "implements", sub.text.decode()))
                    elif sub.type == "generic_type":
                        name_node = sub.child_by_field_name("name")
                        if name_node is not None:
                            result.heritage.append((class_name, "implements", name_node.text.decode()))

    def _extract_di_fields(self, class_node: Node) -> dict[str, str]:
        """Map injected/declared class fields to their declared types.

        Captures two NestJS / TypeScript dependency-injection shapes:

        * **Constructor parameter properties** — ``constructor(private readonly
          prismaService: PrismaService)`` declares ``this.prismaService`` of type
          ``PrismaService``.  Only parameters carrying an ``accessibility_modifier``
          (``private`` / ``public`` / ``protected``) or ``readonly`` become fields;
          a plain ``constructor(foo: number)`` parameter does **not**.
        * **Typed field declarations** — ``private readonly cache: CacheManager``
          (a ``public_field_definition``) declares ``this.cache`` of type
          ``CacheManager``.

        Returns ``{field_name: TypeName}``.  Builtin types (``string``, ``number``,
        ...) are skipped since they never resolve to a CLASS node.
        """
        di_fields: dict[str, str] = {}

        body = class_node.child_by_field_name("body")
        if body is None:
            for child in class_node.children:
                if child.type == "class_body":
                    body = child
                    break
        if body is None:
            return di_fields

        for member in body.children:
            if member.type == "public_field_definition":
                self._collect_field_definition(member, di_fields)
            elif member.type == "method_definition":
                name_node = member.child_by_field_name("name")
                if name_node is not None and name_node.text.decode() == "constructor":
                    self._collect_constructor_di_fields(member, di_fields)

        return di_fields

    def _collect_field_definition(
        self, member: Node, di_fields: dict[str, str]
    ) -> None:
        """Record a ``private x: XService`` style typed field declaration."""
        field_name = ""
        type_name = ""
        for child in member.children:
            if child.type == "property_identifier":
                field_name = child.text.decode()
            elif child.type == "type_annotation":
                type_name = self._type_annotation_name(child)
        if field_name and type_name and type_name.lower() not in _BUILTIN_TYPES:
            di_fields[field_name] = type_name

    def _collect_constructor_di_fields(
        self, constructor_node: Node, di_fields: dict[str, str]
    ) -> None:
        """Record constructor parameter-properties as injected fields.

        Only parameters with an ``accessibility_modifier`` or ``readonly`` keyword
        become instance fields in TypeScript; bare parameters do not.
        """
        params = constructor_node.child_by_field_name("parameters")
        if params is None:
            for child in constructor_node.children:
                if child.type == "formal_parameters":
                    params = child
                    break
        if params is None:
            return

        for param in params.children:
            if param.type not in ("required_parameter", "optional_parameter"):
                continue

            is_property = any(
                c.type in ("accessibility_modifier", "readonly")
                for c in param.children
            )
            if not is_property:
                continue

            param_name = ""
            type_name = ""
            for sub in param.children:
                if sub.type == "identifier" and not param_name:
                    param_name = sub.text.decode()
                elif sub.type == "type_annotation":
                    type_name = self._type_annotation_name(sub)
            if param_name and type_name and type_name.lower() not in _BUILTIN_TYPES:
                di_fields[param_name] = type_name

    def _extract_interface(self, node: Node, source: str, result: ParseResult) -> None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return

        name = name_node.text.decode()
        start_line = node.start_point[0] + 1
        end_line = node.end_point[0] + 1
        content = node.text.decode()

        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="interface",
                start_line=start_line,
                end_line=end_line,
                content=content,
            )
        )

        for child in node.children:
            if child.type == "extends_type_clause":
                for sub in child.children:
                    if sub.type in ("identifier", "type_identifier"):
                        result.heritage.append((name, "extends", sub.text.decode()))

    def _extract_type_alias(self, node: Node, source: str, result: ParseResult) -> None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return

        name = name_node.text.decode()
        start_line = node.start_point[0] + 1
        end_line = node.end_point[0] + 1
        content = node.text.decode()

        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="type_alias",
                start_line=start_line,
                end_line=end_line,
                content=content,
            )
        )

    def _extract_import(self, node: Node, source: str, result: ParseResult) -> None:
        """Handle ES module import statements."""
        module_str = ""
        names: list[str] = []
        alias = ""

        source_node = node.child_by_field_name("source")
        if source_node is not None:
            module_str = self._string_value(source_node)
        else:
            # Fallback: look for a string child after 'from'.
            for child in node.children:
                if child.type == "string":
                    module_str = self._string_value(child)
                    break

        if not module_str:
            return

        import_clause = None
        for child in node.children:
            if child.type == "import_clause":
                import_clause = child
                break

        if import_clause is not None:
            for clause_child in import_clause.children:
                if clause_child.type == "named_imports":
                    # import { A, B } from '...'
                    for spec in clause_child.children:
                        if spec.type == "import_specifier":
                            name_node = spec.child_by_field_name("name")
                            if name_node is not None:
                                names.append(name_node.text.decode())
                elif clause_child.type == "namespace_import":
                    # import * as utils from '...'
                    for ns_child in clause_child.children:
                        if ns_child.type == "identifier":
                            alias = ns_child.text.decode()
                            names.append(alias)
                            break
                elif clause_child.type == "identifier":
                    # import Foo from '...'  (default import)
                    names.append(clause_child.text.decode())

        result.imports.append(
            ImportInfo(
                module=module_str,
                names=names,
                is_relative=module_str.startswith("."),
                alias=alias,
            )
        )

    def _extract_call(self, node: Node, source: str, result: ParseResult) -> None:
        func_node = node.child_by_field_name("function")
        if func_node is None:
            return

        line = node.start_point[0] + 1
        arguments = self._extract_identifier_arguments(node)

        if func_node.type == "member_expression":
            obj_node = func_node.child_by_field_name("object")
            prop_node = func_node.child_by_field_name("property")
            if prop_node is not None:
                receiver = obj_node.text.decode() if obj_node else ""
                result.calls.append(
                    CallInfo(
                        name=prop_node.text.decode(),
                        line=line,
                        receiver=receiver,
                        arguments=arguments,
                    )
                )
        elif func_node.type == "identifier":
            name = func_node.text.decode()
            # Skip require() since it's handled as an import.
            if name != "require":
                result.calls.append(CallInfo(name=name, line=line, arguments=arguments))

    def _extract_new_expression(
        self, node: Node, source: str, result: ParseResult
    ) -> None:
        """Handle ``new ClassName(args)`` — emit a CallInfo targeting the class."""
        constructor_node = node.child_by_field_name("constructor")
        if constructor_node is None:
            return

        line = node.start_point[0] + 1
        arguments = self._extract_identifier_arguments(node)

        if constructor_node.type == "identifier":
            result.calls.append(
                CallInfo(
                    name=constructor_node.text.decode(),
                    line=line,
                    arguments=arguments,
                )
            )
        elif constructor_node.type == "member_expression":
            obj_node = constructor_node.child_by_field_name("object")
            prop_node = constructor_node.child_by_field_name("property")
            if prop_node is not None:
                receiver = obj_node.text.decode() if obj_node else ""
                result.calls.append(
                    CallInfo(
                        name=prop_node.text.decode(),
                        line=line,
                        receiver=receiver,
                        arguments=arguments,
                    )
                )

    @staticmethod
    def _extract_identifier_arguments(call_node: Node) -> list[str]:
        """Extract bare identifier arguments from a call_expression node."""
        args_node = call_node.child_by_field_name("arguments")
        if args_node is None:
            return []

        identifiers: list[str] = []
        for child in args_node.children:
            if child.type == "identifier":
                identifiers.append(child.text.decode())
        return identifiers

    def _extract_function_types(
        self, func_node: Node, func_name: str, result: ParseResult
    ) -> None:
        """Extract parameter types and return type from a function-like node."""
        params = func_node.child_by_field_name("parameters")
        if params is None:
            # Some nodes use "formal_parameters" via children iteration.
            for child in func_node.children:
                if child.type == "formal_parameters":
                    params = child
                    break

        if params is not None:
            for param in params.children:
                if param.type in ("required_parameter", "optional_parameter"):
                    param_name_node = param.child_by_field_name("name")
                    if param_name_node is None:
                        # Fallback: first identifier child.
                        for sub in param.children:
                            if sub.type == "identifier":
                                param_name_node = sub
                                break
                    if param_name_node is None:
                        continue

                    param_name = param_name_node.text.decode()

                    for sub in param.children:
                        if sub.type == "type_annotation":
                            type_name = self._type_annotation_name(sub)
                            if type_name and type_name.lower() not in _BUILTIN_TYPES:
                                result.type_refs.append(
                                    TypeRef(
                                        name=type_name,
                                        kind="param",
                                        line=sub.start_point[0] + 1,
                                        param_name=param_name,
                                    )
                                )

        # Return type: type_annotation directly on the function node (not inside params).
        for child in func_node.children:
            if child.type == "type_annotation":
                type_name = self._type_annotation_name(child)
                if type_name and type_name.lower() not in _BUILTIN_TYPES:
                    result.type_refs.append(
                        TypeRef(
                            name=type_name,
                            kind="return",
                            line=child.start_point[0] + 1,
                        )
                    )

    def _extract_variable_type_annotation(
        self, declarator_node: Node, result: ParseResult
    ) -> None:
        """Extract type from ``const x: Config = ...``."""
        for child in declarator_node.children:
            if child.type == "type_annotation":
                type_name = self._type_annotation_name(child)
                if type_name and type_name.lower() not in _BUILTIN_TYPES:
                    result.type_refs.append(
                        TypeRef(
                            name=type_name,
                            kind="variable",
                            line=child.start_point[0] + 1,
                        )
                    )

    @staticmethod
    def _type_annotation_name(annotation_node: Node) -> str:
        """Return the simple type name from a ``type_annotation`` node.

        Handles ``type_identifier``, ``predefined_type``, and ``identifier``
        children.  For compound types (unions, generics, etc.) returns the
        text of the first recognisable child.
        """
        for child in annotation_node.children:
            if child.type in ("type_identifier", "predefined_type", "identifier"):
                return child.text.decode()
        return ""

    @staticmethod
    def _string_value(string_node: Node) -> str:
        """Extract the raw string value from a tree-sitter ``string`` node.

        String nodes look like: string -> [quote, string_fragment, quote].
        """
        for child in string_node.children:
            if child.type == "string_fragment":
                return child.text.decode()
        # Fallback: strip outer quotes from the whole text.
        text = string_node.text.decode()
        if len(text) >= 2 and text[0] in ("'", '"', "`") and text[-1] in ("'", '"', "`"):
            return text[1:-1]
        return text

    @classmethod
    def _extract_decorators(cls, node: Node) -> tuple[list[str], list[str]]:
        """Collect decorator names and their string-literal args preceding *node*.

        Tree-sitter TS places ``decorator`` nodes in two positions depending on context:

        * As **preceding siblings** of a ``method_definition`` (inside ``class_body``) or
          of an *exported* ``class_declaration`` (inside ``export_statement``).
        * As **direct children** of a *non-exported* ``class_declaration``.

        We collect from both: the node's own children, plus the preceding-sibling chain
        (skipping modifier keywords such as ``export``/``abstract`` that can sit between
        the decorators and the declaration), stopping at the first non-decorator,
        non-keyword sibling.

        ``@Processor('MANAGE_SALES')`` -> name ``"Processor"``, arg ``"MANAGE_SALES"``;
        ``@Get('/orders')`` -> name ``"Get"``, arg ``"/orders"``;
        ``@Injectable()`` / ``@Get()`` -> name only, no args.

        Returns ``(decorators, decorator_args)`` in source order.
        """
        _MODIFIER_KEYWORDS = {"export", "default", "abstract", "declare", "static"}  # noqa: N806 — local constant set
        decorator_nodes: list[Node] = []

        # Preceding-sibling decorators (methods, exported classes), collected nearest-first.
        sib = node.prev_sibling
        while sib is not None:
            if sib.type == "decorator":
                decorator_nodes.append(sib)
            elif sib.type not in _MODIFIER_KEYWORDS:
                # A real preceding statement ends the run; bare modifier keywords are skipped.
                break
            sib = sib.prev_sibling
        decorator_nodes.reverse()  # restore source order

        # Direct-child decorators (non-exported decorated classes), already in source order.
        decorator_nodes.extend(c for c in node.children if c.type == "decorator")
        names: list[str] = []
        args: list[str] = []
        for dec in decorator_nodes:
            name = cls._decorator_name(dec)
            if name:
                names.append(name)
            args.extend(cls._decorator_args(dec))
        return names, args

    @staticmethod
    def _decorator_name(decorator_node: Node) -> str:
        """Name of a decorator: ``@Get`` -> ``Get``, ``@Get('/x')`` -> ``Get``,
        ``@app.Get()`` -> ``app.Get``."""
        for child in decorator_node.children:
            if child.type in ("identifier", "member_expression"):
                return child.text.decode()
            if child.type == "call_expression":
                func = child.child_by_field_name("function")
                if func is not None:
                    return func.text.decode()
        return ""

    @classmethod
    def _decorator_args(cls, decorator_node: Node) -> list[str]:
        """Positional string-literal arguments of a decorator call.

        ``@Processor('MANAGE_SALES')`` -> ``["MANAGE_SALES"]``.  Template strings with
        substitutions and non-string args are ignored — only static literals wire a
        runtime signal to a handler deterministically.
        """
        args: list[str] = []
        for child in decorator_node.children:
            if child.type != "call_expression":
                continue
            arg_list = child.child_by_field_name("arguments")
            if arg_list is None:
                continue
            for arg in arg_list.children:
                if arg.type == "string":
                    value = cls._string_value(arg)
                    if value:
                        args.append(value)
        return args

    @staticmethod
    def _build_function_signature(node: Node, name: str) -> str:
        """Build a human-readable signature line for a function-like node.

        Includes the parameter list and return type (if present).
        """
        params_text = ""
        return_type = ""

        for child in node.children:
            if child.type == "formal_parameters":
                params_text = child.text.decode()
            elif child.type == "type_annotation":
                return_type = child.text.decode()

        sig = f"{name}{params_text}"
        if return_type:
            sig += return_type
        return sig

    @staticmethod
    def _unwrap_to_function(node: Node) -> Node | None:
        """Return the underlying function node, unwrapping wrapper calls.

        Handles direct ``arrow_function`` / ``function_expression`` as well as
        wrapper patterns like ``asyncHandler(async (req, res) => { ... })``.
        """
        if node.type in ("arrow_function", "function_expression"):
            return node
        if node.type == "call_expression":
            args = node.child_by_field_name("arguments")
            if args is not None:
                for arg in args.children:
                    if arg.type in ("arrow_function", "function_expression"):
                        return arg
        return None

    @staticmethod
    def _find_parent_class_name(node: Node) -> str:
        """Walk up the tree to find the enclosing class name."""
        current = node.parent
        while current is not None:
            if current.type in ("class_declaration", "class_expression"):
                name_node = current.child_by_field_name("name")
                if name_node is not None:
                    return name_node.text.decode()
            current = current.parent
        return ""
