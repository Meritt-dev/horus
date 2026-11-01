"""Shared synthesis of export-alias stub nodes.

A public export name that aliases a differently-named implementation
(``export { BaseComponent as Component }``, ``module.exports = { sign: signImpl }``,
or the cross-module ``export { X as Y } from './mod'``) needs a *searchable*
node carrying the public name so a search on the alias lands and the engine
resolver can follow an ``EXPORTS_ALIAS`` edge to the real implementation.

Both the same-file path (``parser_phase._emit_export_aliases``) and the
cross-module path (``reexports.process_reexport_aliases``) synthesize the exact
same stub shape, so the synthesis lives here as a single implementation. This
module deliberately depends only on the graph model to stay free of the
``parser_phase``/``imports`` import cycle.
"""

from __future__ import annotations

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import (
    GraphNode,
    GraphRelationship,
    NodeLabel,
    RelType,
    generate_id,
)


def synthesize_alias_stub(
    graph: KnowledgeGraph,
    *,
    label: NodeLabel,
    public_name: str,
    file_path: str,
    file_id: str,
    start_line: int,
    end_line: int,
    content: str,
    signature: str,
    language: str,
    impl_id: str,
    impl_name: str,
) -> str:
    """Create a searchable alias stub node plus its DEFINES and EXPORTS_ALIAS edges.

    The stub is named ``public_name`` and lives in ``file_path`` (the re-exporting
    file — its ``start_line``/``end_line`` must point at the export statement, NOT
    the implementation's lines). It is flagged ``synthesized_name=True`` and carries
    ``alias_of=impl_name`` so the engine's ``redirectExportAlias``/``resolveSeedSymbol``
    can promote the real implementation (``impl_id``) to the head of a search.

    Idempotent: a pre-existing node with the derived id is left untouched. The
    ``EXPORTS_ALIAS`` edge is (re-)asserted unless the stub id equals ``impl_id``.
    Returns the stub node id.
    """
    public_id = generate_id(label, file_path, public_name)
    if graph.get_node(public_id) is None:
        graph.add_node(
            GraphNode(
                id=public_id,
                label=label,
                name=public_name,
                file_path=file_path,
                start_line=start_line,
                end_line=end_line,
                content=content,
                signature=signature,
                language=language,
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

    if public_id != impl_id:
        graph.add_relationship(
            GraphRelationship(
                id=f"exports_alias:{public_id}->{impl_id}",
                type=RelType.EXPORTS_ALIAS,
                source=public_id,
                target=impl_id,
            )
        )

    return public_id
