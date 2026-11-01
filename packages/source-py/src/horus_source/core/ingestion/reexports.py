"""Cross-module re-export resolution for Horus.

Handles ``export { X as Y } from './mod'`` — a re-export that renames an
implementation defined in ANOTHER module. The parser records these as
:class:`~horus_source.core.parsers.base.ReexportAlias` entries (carrying the
module specifier and the re-export line) rather than same-file
``export_aliases``, because resolving the impl requires cross-file lookup.

This phase runs AFTER import resolution (so the file index is populated) and
symbol parsing (so implementation nodes exist). For each re-export alias it:

1. resolves the module specifier to a target File node (reusing the JS/TS import
   resolver, which understands ``/index.{ts,js,tsx,jsx}`` fallbacks);
2. finds the implementation symbol ``X`` in that target file, preferring a
   non-method top-level symbol; and
3. synthesizes a searchable stub named ``Y`` in the RE-EXPORTING file, flagged
   ``synthesized_name`` + ``alias_of=X``, with a ``DEFINES`` edge from the file
   and an ``EXPORTS_ALIAS`` edge to the resolved impl.

The engine's ``redirectExportAlias``/``resolveSeedSymbol`` already consume that
stub shape, so a search on ``Y`` (e.g. preact's ``Component``) resolves to the
real implementation (``BaseComponent``) instead of a ``.d.ts`` declaration.

Only a single alias hop is resolved here; deeper barrel chains
(``./a`` re-exports ``X`` from ``./b``) rely on the engine's one extra hop.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import NodeLabel, generate_id
from horus_source.core.ingestion.alias_stub import synthesize_alias_stub
from horus_source.core.ingestion.imports import resolve_import_path
from horus_source.core.ingestion.symbol_lookup import build_name_index
from horus_source.core.parsers.base import ImportInfo

if TYPE_CHECKING:
    from horus_source.core.ingestion.parser_phase import FileParseData

# Searchable symbol labels an impl may carry (mirrors the shared name index used
# by calls/heritage/type resolution). File/Folder/Community/Process are structural.
_SYMBOL_LABELS: tuple[NodeLabel, ...] = (
    NodeLabel.FUNCTION,
    NodeLabel.CLASS,
    NodeLabel.METHOD,
    NodeLabel.INTERFACE,
    NodeLabel.TYPE_ALIAS,
    NodeLabel.ENUM,
)


def process_reexport_aliases(
    parse_data: list[FileParseData],
    graph: KnowledgeGraph,
    file_index: dict[str, str],
) -> None:
    """Resolve cross-module re-export-with-rename aliases and synthesize stubs.

    For each ``export { X as Y } from './mod'`` recorded on a file, resolve
    ``./mod`` to a File node, locate the ``X`` implementation there, and
    synthesize the ``Y`` alias stub (+ DEFINES + EXPORTS_ALIAS edges) in the
    re-exporting file. Unresolvable modules (external packages) and missing
    impls are skipped.
    """
    name_index = build_name_index(graph, _SYMBOL_LABELS)

    for fpd in parse_data:
        aliases = fpd.parse_result.reexport_aliases
        if not aliases:
            continue

        file_path = fpd.file_path
        file_id = generate_id(NodeLabel.FILE, file_path)

        for ra in aliases:
            target_file_id = resolve_import_path(
                file_path,
                ImportInfo(
                    module=ra.module,
                    names=[ra.impl_name],
                    is_relative=ra.module.startswith("."),
                ),
                file_index,
                source_roots=set(),
            )
            if target_file_id is None:
                continue

            target_file = graph.get_node(target_file_id)
            if target_file is None:
                continue
            target_path = target_file.file_path

            impl = _find_impl_node(graph, name_index, ra.impl_name, target_path)
            if impl is None:
                continue

            synthesize_alias_stub(
                graph,
                label=impl.label,
                public_name=ra.public_name,
                file_path=file_path,
                file_id=file_id,
                # Honest lines: the re-export statement in THIS file, never the
                # impl's lines (which belong to the target module).
                start_line=ra.line,
                end_line=ra.line,
                content=impl.signature or impl.name,
                signature=impl.signature,
                language=fpd.language,
                impl_id=impl.id,
                impl_name=ra.impl_name,
            )


def _find_impl_node(
    graph: KnowledgeGraph,
    name_index: dict[str, list[str]],
    impl_name: str,
    target_path: str,
):
    """Return the impl node named ``impl_name`` in ``target_path``.

    Prefers a non-method top-level symbol (mirrors ``parser_phase``'s canonical
    target selection) so ``export { Foo as Bar }`` binds to the ``Foo`` class,
    not a ``Foo`` method on some other class in the same file.
    """
    fallback = None
    for node_id in name_index.get(impl_name, []):
        node = graph.get_node(node_id)
        if node is None or node.file_path != target_path:
            continue
        if node.label != NodeLabel.METHOD:
            return node
        if fallback is None:
            fallback = node
    return fallback
