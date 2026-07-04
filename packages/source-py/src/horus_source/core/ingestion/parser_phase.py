"""Phase 3: Code parsing for Horus.

Takes file entries from the walker, parses each one with the appropriate
tree-sitter parser, and adds symbol nodes (Function, Class, Method, Interface,
TypeAlias, Enum) to the knowledge graph with DEFINES relationships from File
to Symbol.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import (
    GraphNode,
    GraphRelationship,
    NodeLabel,
    RelType,
    generate_id,
)
from horus_source.core.ingestion.walker import FileEntry
from horus_source.core.parsers.base import LanguageParser, ParseResult
from horus_source.core.parsers.go_lang import GoParser
from horus_source.core.parsers.java_lang import JavaParser
from horus_source.core.parsers.python_lang import PythonParser
from horus_source.core.parsers.rust_lang import RustParser
from horus_source.core.parsers.typescript import TypeScriptParser

logger = logging.getLogger(__name__)

_KIND_TO_LABEL: dict[str, NodeLabel] = {
    "function": NodeLabel.FUNCTION,
    "class": NodeLabel.CLASS,
    "method": NodeLabel.METHOD,
    "interface": NodeLabel.INTERFACE,
    "type_alias": NodeLabel.TYPE_ALIAS,
    "enum": NodeLabel.ENUM,
}


_PARSER_FACTORIES: dict[str, Callable[[], LanguageParser]] = {
    "python": PythonParser,
    "typescript": lambda: TypeScriptParser(dialect="typescript"),
    "tsx": lambda: TypeScriptParser(dialect="tsx"),
    "javascript": lambda: TypeScriptParser(dialect="javascript"),
    "go": GoParser,
    "java": JavaParser,
    "rust": RustParser,
}

@dataclass
class FileParseData:
    """Parse results for a single file, kept for later phases."""

    file_path: str
    language: str
    parse_result: ParseResult

_PARSER_CACHE: dict[str, LanguageParser] = {}
_PARSER_CACHE_LOCK = threading.Lock()

def get_parser(language: str) -> LanguageParser:
    """Return the appropriate tree-sitter parser for *language*.

    Parser instances are cached per language to avoid repeated instantiation
    of tree-sitter ``Parser`` objects.

    Args:
        language: One of ``"python"``, ``"typescript"``, or ``"javascript"``.

    Returns:
        A :class:`LanguageParser` instance ready to parse source code.

    Raises:
        ValueError: If *language* is not supported.
    """
    cached = _PARSER_CACHE.get(language)
    if cached is not None:
        return cached
    with _PARSER_CACHE_LOCK:
        cached = _PARSER_CACHE.get(language)
        if cached is not None:
            return cached

        factory = _PARSER_FACTORIES.get(language)
        if factory is None:
            raise ValueError(
                f"Unsupported language {language!r}. "
                f"Expected one of: python, typescript, tsx, javascript"
            )

        parser = factory()
        _PARSER_CACHE[language] = parser
        return parser

# Skip DEEP parsing of pathologically large files (generated GraphQL/SDK clients,
# minified bundles, vendored blobs). Their syntax trees dominate memory — a single
# multi-MB generated file can balloon the in-memory parse set into many GB and OOM
# the indexer — while adding little investigation value (the file node is still kept
# by the structure phase; only symbol/relationship extraction is skipped). Hand-
# written source is virtually always far below this. Override via env.
_MAX_PARSE_BYTES = int(os.environ.get("HORUS_SOURCE_MAX_PARSE_BYTES") or 1_500_000)


def parse_file(file_path: str, content: str, language: str) -> FileParseData:
    """Parse a single file and return structured parse data.

    If parsing fails for any reason the returned :class:`FileParseData` will
    contain an empty :class:`ParseResult` so that downstream phases can
    safely skip it.

    Args:
        file_path: Relative path to the file (used for identification).
        content: Raw source code of the file.
        language: Language identifier (``"python"``, ``"typescript"``, etc.).

    Returns:
        A :class:`FileParseData` carrying the parse result.
    """
    if len(content) > _MAX_PARSE_BYTES:
        logger.info(
            "Skipping deep parse of %s: %d bytes exceeds limit %d "
            "(likely generated/vendored; override with HORUS_SOURCE_MAX_PARSE_BYTES)",
            file_path,
            len(content),
            _MAX_PARSE_BYTES,
        )
        return FileParseData(file_path=file_path, language=language, parse_result=ParseResult())

    try:
        parser = get_parser(language)
        result = parser.parse(content, file_path)
    except Exception:
        logger.warning("Failed to parse %s (%s), skipping", file_path, language, exc_info=True)
        result = ParseResult()

    return FileParseData(file_path=file_path, language=language, parse_result=result)

def process_parsing(
    files: list[FileEntry],
    graph: KnowledgeGraph,
    max_workers: int = 8,
) -> list[FileParseData]:
    """Parse every file and populate the knowledge graph with symbol nodes.

    Parsing is done in parallel using a thread pool (tree-sitter releases
    the GIL during C parsing).  Graph mutation remains sequential since
    :class:`KnowledgeGraph` is not thread-safe.

    For each symbol discovered during parsing a graph node is created with
    the appropriate label (Function, Class, Method, etc.) and a DEFINES
    relationship is added from the owning File node to the new symbol node.

    Args:
        files: File entries produced by the walker phase.
        graph: The knowledge graph to populate.  File nodes are expected to
            already exist (created by the structure phase).
        max_workers: Maximum number of threads for parallel parsing.

    Returns:
        A list of :class:`FileParseData` objects that carry the full parse
        results (imports, calls, heritage, type_refs) for use by later phases.
    """
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        all_parse_data = list(
            executor.map(
                lambda f: parse_file(f.path, f.content, f.language),
                files,
            )
        )

    for file_entry, parse_data in zip(files, all_parse_data):
        file_id = generate_id(NodeLabel.FILE, file_entry.path)
        exported_names: set[str] = set(parse_data.parse_result.exports)

        class_bases: dict[str, list[str]] = {}
        for cls_name, kind, parent_name in parse_data.parse_result.heritage:
            if kind == "extends":
                class_bases.setdefault(cls_name, []).append(parent_name)

        # name -> (label, node_id, symbol) for this file's real symbols; used to
        # resolve EXPORTS_ALIAS edges (public name -> implementation) below.
        symbols_by_name: dict[str, tuple[NodeLabel, str, Any]] = {}

        for symbol in parse_data.parse_result.symbols:
            label = _KIND_TO_LABEL.get(symbol.kind)
            if label is None:
                logger.warning(
                    "Unknown symbol kind %r for %s in %s, skipping",
                    symbol.kind,
                    symbol.name,
                    file_entry.path,
                )
                continue

            symbol_name = (
                f"{symbol.class_name}.{symbol.name}"
                if symbol.kind == "method" and symbol.class_name
                else symbol.name
            )

            symbol_id = generate_id(label, file_entry.path, symbol_name)

            props: dict[str, Any] = {}
            if symbol.decorators:
                props["decorators"] = symbol.decorators
            if symbol.decorator_args:
                props["decorator_args"] = symbol.decorator_args
            if symbol.kind == "class" and symbol.di_fields:
                props["di_fields"] = symbol.di_fields
            if symbol.kind == "class" and symbol.name in class_bases:
                props["bases"] = class_bases[symbol.name]
            if symbol.synthesized_name:
                props["synthesized_name"] = True

            is_exported = symbol.name in exported_names

            graph.add_node(
                GraphNode(
                    id=symbol_id,
                    label=label,
                    name=symbol.name,
                    file_path=file_entry.path,
                    start_line=symbol.start_line,
                    end_line=symbol.end_line,
                    content=symbol.content,
                    signature=symbol.signature,
                    class_name=symbol.class_name,
                    language=file_entry.language,
                    is_exported=is_exported,
                    properties=props,
                )
            )

            rel_id = f"defines:{file_id}->{symbol_id}"
            graph.add_relationship(
                GraphRelationship(
                    id=rel_id,
                    type=RelType.DEFINES,
                    source=file_id,
                    target=symbol_id,
                )
            )

            # First writer wins; prefer a non-method top-level symbol as the
            # canonical target for a public name (bare `name`, not `Class.method`).
            if symbol.name not in symbols_by_name or label != NodeLabel.METHOD:
                symbols_by_name[symbol.name] = (label, symbol_id, symbol)

        _emit_export_aliases(parse_data, file_entry, file_id, symbols_by_name, graph)

    return all_parse_data


def _emit_export_aliases(
    parse_data: FileParseData,
    file_entry: FileEntry,
    file_id: str,
    symbols_by_name: dict[str, tuple[NodeLabel, str, Any]],
    graph: KnowledgeGraph,
) -> None:
    """Create ``EXPORTS_ALIAS`` edges (public name -> implementation).

    ``export { BaseComponent as Component }`` and
    ``module.exports = { sign: signImpl }`` bind a PUBLIC export name to a
    differently-named implementation symbol. For each such pair we point an
    ``EXPORTS_ALIAS`` edge at the implementation node; when no node already
    carries the public name we synthesize a lightweight, searchable stub node
    (flagged ``synthesized_name``) so a search on the public alias lands and the
    resolver can follow the edge to product code. Aliases whose implementation
    is not defined in this file (cross-file re-exports) are skipped.
    """
    for public_name, impl_name in parse_data.parse_result.export_aliases:
        impl = symbols_by_name.get(impl_name)
        if impl is None:
            continue
        impl_label, impl_id, impl_symbol = impl

        existing = symbols_by_name.get(public_name)
        if existing is not None:
            public_id = existing[1]
        else:
            public_id = generate_id(impl_label, file_entry.path, public_name)
            graph.add_node(
                GraphNode(
                    id=public_id,
                    label=impl_label,
                    name=public_name,
                    file_path=file_entry.path,
                    start_line=impl_symbol.start_line,
                    end_line=impl_symbol.end_line,
                    content=impl_symbol.content,
                    signature=impl_symbol.signature,
                    language=file_entry.language,
                    is_exported=True,
                    properties={"synthesized_name": True, "alias_of": impl_name},
                )
            )
            graph.add_relationship(
                GraphRelationship(
                    id=f"defines:{file_id}->{public_id}",
                    type=RelType.DEFINES,
                    source=file_id,
                    target=public_id,
                )
            )

        if public_id == impl_id:
            continue
        graph.add_relationship(
            GraphRelationship(
                id=f"exports_alias:{public_id}->{impl_id}",
                type=RelType.EXPORTS_ALIAS,
                source=public_id,
                target=impl_id,
            )
        )
