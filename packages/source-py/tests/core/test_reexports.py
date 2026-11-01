"""Integration tests for cross-module re-export-with-rename resolution.

Exercises ``process_reexport_aliases`` over a mini two-file graph: a module that
defines ``BaseComponent`` and a barrel that re-exports it under the public name
``Component`` (the preact `Component` gap of HOR-465).
"""

from __future__ import annotations

from pathlib import Path

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import RelType
from horus_source.core.ingestion.imports import build_file_index, process_imports
from horus_source.core.ingestion.parser_phase import process_parsing
from horus_source.core.ingestion.pipeline import reindex_files
from horus_source.core.ingestion.reexports import process_reexport_aliases
from horus_source.core.ingestion.structure import process_structure
from horus_source.core.ingestion.walker import FileEntry
from horus_source.core.storage.sqlite_backend import SqliteBackend

_COMPONENT_JS = "export function BaseComponent() {}\n"
_INDEX_JS = "export { BaseComponent as Component } from './component';\n"


def _files(index_src: str = _INDEX_JS) -> list[FileEntry]:
    return [
        FileEntry(path="src/component.js", content=_COMPONENT_JS, language="javascript"),
        FileEntry(path="src/index.js", content=index_src, language="javascript"),
    ]


def _resolve(files: list[FileEntry]) -> KnowledgeGraph:
    """Run structure -> parsing -> imports -> re-exports over a fresh graph."""
    graph = KnowledgeGraph()
    process_structure(files, graph)
    parse_data = process_parsing(files, graph)
    process_imports(parse_data, graph)
    process_reexport_aliases(parse_data, graph, build_file_index(graph))
    return graph


def _find_by_name(graph: KnowledgeGraph, name: str, file_path: str):
    for node in graph.iter_nodes():
        if node.name == name and node.file_path == file_path:
            return node
    return None


def test_cross_module_alias_stub_and_edge() -> None:
    graph = _resolve(_files())

    stub = _find_by_name(graph, "Component", "src/index.js")
    assert stub is not None, "Component alias stub was not synthesized"
    assert stub.properties.get("alias_of") == "BaseComponent"
    assert stub.properties.get("synthesized_name") is True
    assert stub.is_exported is True

    impl = _find_by_name(graph, "BaseComponent", "src/component.js")
    assert impl is not None

    edges = [
        rel
        for rel in graph.iter_relationships()
        if rel.type == RelType.EXPORTS_ALIAS
        and rel.source == stub.id
        and rel.target == impl.id
    ]
    assert len(edges) == 1, "expected one EXPORTS_ALIAS edge Component -> BaseComponent"


def test_alias_stub_line_points_at_reexport_not_impl() -> None:
    # Push the re-export onto a later line; the stub must claim THAT line, not
    # BaseComponent's line 1 in the other file.
    index_src = "// barrel\n// header\nexport { BaseComponent as Component } from './component';\n"
    graph = _resolve(_files(index_src))

    stub = _find_by_name(graph, "Component", "src/index.js")
    assert stub is not None
    assert stub.start_line == 3
    assert stub.end_line == 3


def test_external_reexport_skipped() -> None:
    files = [
        FileEntry(
            path="src/index.js",
            content="export { x as y } from 'react';\n",
            language="javascript",
        )
    ]
    graph = _resolve(files)
    # A bare specifier resolves to None — no stub, no impl to bind.
    assert _find_by_name(graph, "y", "src/index.js") is None


def test_reindex_preserves_alias(tmp_path: Path) -> None:
    # Seed a full graph (both files) into storage.
    initial = _resolve(_files())
    storage = SqliteBackend()
    storage.initialize(tmp_path / "horus.db")
    try:
        storage.bulk_load(initial)

        # Reindex ONLY the barrel; component.js is unchanged and must still resolve.
        graph = reindex_files(
            [FileEntry(path="src/index.js", content=_INDEX_JS, language="javascript")],
            tmp_path,
            storage,
        )

        stub = _find_by_name(graph, "Component", "src/index.js")
        assert stub is not None
        assert stub.properties.get("alias_of") == "BaseComponent"

        impl = _find_by_name(graph, "BaseComponent", "src/component.js")
        assert impl is not None

        edges = [
            rel
            for rel in graph.iter_relationships()
            if rel.type == RelType.EXPORTS_ALIAS
            and rel.source == stub.id
            and rel.target == impl.id
        ]
        assert len(edges) == 1

        # The stub + edge must survive the round-trip to storage.
        reloaded = storage.load_graph()
        persisted = _find_by_name(reloaded, "Component", "src/index.js")
        assert persisted is not None
        assert persisted.properties.get("alias_of") == "BaseComponent"
        assert any(
            rel.type == RelType.EXPORTS_ALIAS and rel.source == persisted.id
            for rel in reloaded.iter_relationships()
        )
    finally:
        storage.close()
