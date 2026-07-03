"""Rust parser using tree-sitter (HOR-SOURCE).

Extracts symbols (functions, impl methods, structs, enums, traits), imports (``use``),
calls, and heritage (``impl Trait for Type``) from Rust source via tree-sitter-rust,
into the shared ``ParseResult`` IR.

Mapping (same node taxonomy as the Python/TS/Go/Java parsers):
  * ``fn f(...)``                    → kind ``function`` (free function)
  * ``fn m(...)`` inside ``impl T``  → kind ``method``; ``class_name`` = target type ``T``
  * trait method signatures          → kind ``method``; ``class_name`` = the trait
  * ``struct S`` / ``enum E``         → kind ``class`` / ``enum`` (the class-equivalents)
  * ``trait T``                      → kind ``interface``
  * ``impl Trait for Type``          → ``heritage`` (Type implements Trait — explicit, clean)
  * ``use a::b::{c, d}``             → ``ImportInfo`` (one per leaf path)
  * ``f()`` / ``x.m()`` / ``T::m()`` → ``CallInfo``

Rust visibility is explicit: a ``pub`` item carries a ``visibility_modifier`` child, so
such items are recorded in ``exports``.

Snags handled: ``async fn`` and attribute/derive macros (``#[tokio::main]``, ``#[derive(..)]``)
wrap/annotate items but the underlying ``function_item`` / ``struct_item`` is still the
node we key on, so they parse cleanly. Macro-generated code and the full ``use`` re-export
graph are out of scope for v1 (cross-module call resolution is a follow-up).
"""

from __future__ import annotations

import re

import tree_sitter_rust as tsrust
from tree_sitter import Language, Node, Parser

from horus_source.core.parsers.base import (
    CallInfo,
    ImportInfo,
    LanguageParser,
    ParseResult,
    SymbolInfo,
)

RUST_LANGUAGE = Language(tsrust.language())


def _is_pub(node: Node) -> bool:
    return any(c.type == "visibility_modifier" for c in node.children)


class RustParser(LanguageParser):
    """Parse Rust source files via tree-sitter."""

    def __init__(self) -> None:
        self._parser = Parser(RUST_LANGUAGE)

    def parse(self, content: str, file_path: str) -> ParseResult:
        tree = self._parser.parse(content.encode("utf-8"))
        result = ParseResult()
        self._walk(tree.root_node, result)
        return result

    def _walk(self, node: Node, result: ParseResult) -> None:
        ntype = node.type
        if ntype in ("function_item", "function_signature_item"):
            self._extract_function(node, result)
        elif ntype == "struct_item":
            self._extract_named(node, "class", result)
        elif ntype == "enum_item":
            self._extract_named(node, "enum", result)
        elif ntype == "trait_item":
            self._extract_named(node, "interface", result)
        elif ntype == "impl_item":
            self._extract_impl_heritage(node, result)
        elif ntype == "use_declaration":
            self._extract_use(node, result)
        elif ntype == "call_expression":
            self._extract_call(node, result)
        elif ntype == "macro_invocation":
            self._extract_macro_calls(node, result)

        for child in node.children:
            self._walk(child, result)

    # -- ownership ------------------------------------------------------------

    def _enclosing_type(self, node: Node) -> str:
        """Walk up to the nearest ``impl``/``trait`` and return its type name, or ``""``.

        For ``impl T`` / ``impl Trait for T`` the owner is ``T`` (the ``type`` field);
        for a trait method signature the owner is the trait's name.
        """
        parent = node.parent
        while parent is not None:
            if parent.type == "impl_item":
                type_node = parent.child_by_field_name("type")
                return self._type_name(type_node) if type_node is not None else ""
            if parent.type == "trait_item":
                name_node = parent.child_by_field_name("name")
                return name_node.text.decode() if name_node is not None else ""
            parent = parent.parent
        return ""

    @staticmethod
    def _in_trait_impl(node: Node) -> bool:
        """True when *node* is a method inside ``impl Trait for Type``.

        Trait impls are Rust's dynamic-dispatch surface: `From::from`, `PartialEq::eq`,
        `Display::fmt` etc. are invoked by the language (operators, conversions, vtables),
        not by in-repo named calls — the same reason Python dunders and overrides are
        exempt from dead-code detection.
        """
        parent = node.parent
        while parent is not None:
            if parent.type == "impl_item":
                return parent.child_by_field_name("trait") is not None
            parent = parent.parent
        return False

    @staticmethod
    def _in_cfg_test_mod(node: Node) -> bool:
        """True when *node* lives inside a ``#[cfg(test)] mod`` (inline unit tests).

        tree-sitter-rust parses outer attributes as PRECEDING SIBLINGS of the item
        they decorate, so each ancestor ``mod_item``'s attribute stack is checked.
        """
        parent = node.parent
        while parent is not None:
            if parent.type == "mod_item":
                sib = parent.prev_named_sibling
                while sib is not None and sib.type == "attribute_item":
                    text = sib.text.decode()
                    if "cfg" in text and "test" in text:
                        return True
                    sib = sib.prev_named_sibling
            parent = parent.parent
        return False

    def _type_name(self, node: Node) -> str:
        """Bare type name from a (possibly generic / scoped) type node."""
        if node.type == "generic_type":
            inner = node.child_by_field_name("type")
            if inner is not None:
                node = inner
        text = node.text.decode()
        text = text.split("<", 1)[0]  # Vec<T> → Vec
        return text.rsplit("::", 1)[-1]  # a::b::C → C

    # -- declarations ---------------------------------------------------------

    def _signature(self, node: Node, name: str) -> str:
        text = node.text.decode()
        head = text.split("{", 1)[0].split("\n", 1)[0]
        return " ".join(head.split()).strip().rstrip(";")

    def _extract_function(self, node: Node, result: ParseResult) -> None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return
        name = name_node.text.decode()
        owner = self._enclosing_type(node)
        result.symbols.append(
            SymbolInfo(
                name=name,
                kind="method" if owner else "function",
                start_line=node.start_point[0] + 1,
                end_line=node.end_point[0] + 1,
                content=node.text.decode(),
                signature=self._signature(node, name),
                class_name=owner,
                # Markers dead-code detection exempts on (clap dogfood): inline unit
                # tests (`#[cfg(test)] mod` — runner-invoked) and trait-impl methods
                # (`impl Trait for T` — language-invoked via operators/conversions).
                decorators=(
                    (["cfg(test)"] if self._in_cfg_test_mod(node) else [])
                    + (["trait_impl"] if self._in_trait_impl(node) else [])
                ),
            )
        )
        if _is_pub(node):
            result.exports.append(name)

    def _extract_named(self, node: Node, kind: str, result: ParseResult) -> None:
        name_node = node.child_by_field_name("name")
        if name_node is None:
            return
        name = name_node.text.decode()
        result.symbols.append(
            SymbolInfo(
                name=name,
                kind=kind,
                start_line=node.start_point[0] + 1,
                end_line=node.end_point[0] + 1,
                content=node.text.decode(),
                signature=self._signature(node, name),
            )
        )
        if _is_pub(node):
            result.exports.append(name)

    def _extract_impl_heritage(self, node: Node, result: ParseResult) -> None:
        """``impl Trait for Type`` → (Type, implements, Trait). Plain ``impl Type`` → nothing."""
        trait_node = node.child_by_field_name("trait")
        type_node = node.child_by_field_name("type")
        if trait_node is not None and type_node is not None:
            result.heritage.append(
                (self._type_name(type_node), "implements", self._type_name(trait_node))
            )

    # -- imports --------------------------------------------------------------

    def _extract_use(self, node: Node, result: ParseResult) -> None:
        """Flatten a ``use`` tree into one ImportInfo per leaf path.

        ``use a::b::C;``            → a::b::C
        ``use a::b::{C, D};``       → a::b::C, a::b::D
        ``use a::b::C as X;``       → a::b::C (alias X)
        """
        arg = node.child_by_field_name("argument")
        if arg is None:
            # Fallback: parse the raw text.
            raw = node.text.decode().strip().removeprefix("use").strip().rstrip(";").strip()
            if raw:
                result.imports.append(ImportInfo(module=raw, names=[raw.rsplit("::", 1)[-1]]))
            return
        for module, alias in self._flatten_use(arg, ""):
            last = module.rsplit("::", 1)[-1]
            result.imports.append(ImportInfo(module=module, names=[last], alias=alias))

    def _flatten_use(self, node: Node, prefix: str) -> list[tuple[str, str]]:
        """Return ``(full_path, alias)`` leaves under a use argument node."""
        t = node.type
        if t == "scoped_use_list":
            path_node = node.child_by_field_name("path")
            base = self._join(prefix, path_node.text.decode() if path_node else "")
            out: list[tuple[str, str]] = []
            lst = node.child_by_field_name("list")
            if lst is not None:
                for child in lst.children:
                    if child.type in ("identifier", "scoped_identifier", "use_as_clause", "scoped_use_list", "self"):
                        out.extend(self._flatten_use(child, base))
            return out
        if t == "use_as_clause":
            path_node = node.child_by_field_name("path")
            alias_node = node.child_by_field_name("alias")
            full = self._join(prefix, path_node.text.decode() if path_node else "")
            return [(full, alias_node.text.decode() if alias_node is not None else "")]
        if t in ("scoped_identifier", "identifier"):
            return [(self._join(prefix, node.text.decode()), "")]
        if t == "self":
            return [(prefix, "")] if prefix else []
        if t == "use_wildcard":
            return [(self._join(prefix, "*"), "")]
        return []

    def _join(self, prefix: str, seg: str) -> str:
        seg = seg.strip()
        if not prefix:
            return seg
        return f"{prefix}::{seg}" if seg else prefix

    # -- calls ----------------------------------------------------------------

    @staticmethod
    def _identifier_arguments(call_node: Node) -> list[str]:
        """Bare identifier arguments — unit structs / fn refs passed by name
        (`deserializer.deserialize_str(CowStrVisitor)`). Resolution links them at
        reduced confidence, so passing a visitor by value counts as usage
        (dogfood cycle-3: serde's *Visitor unit structs were flagged dead)."""
        args = call_node.child_by_field_name("arguments")
        if args is None:
            return []
        return [c.text.decode() for c in args.children if c.type == "identifier"]

    # Call-ish tokens inside a macro body: `receiver.method(` or `function(`.
    _MACRO_CALL_RE = re.compile(r"(?:([A-Za-z_][A-Za-z0-9_]*)\s*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(")

    def _extract_macro_calls(self, node: Node, result: ParseResult) -> None:
        """Mine call-shaped tokens out of a macro body (dogfood cycle-3).

        tree-sitter parses macro arguments as raw token trees, NOT expressions —
        so every call wrapped in `tri!(...)`, `assert!(...)`, `vec![...]` etc. was
        invisible (serde: `tri!(seq_visitor.end())` produced nothing, and the
        called methods read as dead). A conservative regex over the token text
        recovers `name(` / `recv.name(` shapes; resolution confidence-guards the
        rest, exactly as it does for regular unresolved names.
        """
        token_tree = next((c for c in node.children if c.type == "token_tree"), None)
        if token_tree is None:
            return
        text = token_tree.text.decode()
        line = node.start_point[0] + 1
        seen: set[tuple[str, str]] = set()
        for m in self._MACRO_CALL_RE.finditer(text):
            receiver, name = m.group(1) or "", m.group(2)
            if name in ("if", "for", "while", "match", "loop", "unsafe", "return"):
                continue
            key = (receiver, name)
            if key in seen:
                continue
            seen.add(key)
            result.calls.append(CallInfo(name=name, line=line, receiver=receiver))

    def _extract_call(self, node: Node, result: ParseResult) -> None:
        func = node.child_by_field_name("function")
        if func is None:
            return
        line = node.start_point[0] + 1
        if func.type == "field_expression":
            value = func.child_by_field_name("value")
            field = func.child_by_field_name("field")
            if field is not None:
                result.calls.append(
                    CallInfo(
                        name=field.text.decode(),
                        line=line,
                        receiver=value.text.decode() if value is not None else "",
                        arguments=self._identifier_arguments(node),
                    )
                )
        elif func.type == "scoped_identifier":
            # Type::method — receiver is the path before the final segment.
            name_node = func.child_by_field_name("name")
            path_node = func.child_by_field_name("path")
            if name_node is not None:
                result.calls.append(
                    CallInfo(
                        name=name_node.text.decode(),
                        line=line,
                        receiver=path_node.text.decode() if path_node is not None else "",
                    )
                )
        elif func.type == "identifier":
            result.calls.append(
                CallInfo(
                    name=func.text.decode(),
                    line=line,
                    arguments=self._identifier_arguments(node),
                )
            )
