"""Graph API routes — full graph, node detail, overview stats."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from horus_source.core.graph.model import GraphNode, GraphRelationship

logger = logging.getLogger(__name__)

router = APIRouter(tags=["graph"])


def _serialize_node(node: GraphNode) -> dict:
    """Convert a GraphNode to a camelCase dict for the frontend."""
    return {
        "id": node.id,
        "label": node.label.value,
        "name": node.name,
        "filePath": node.file_path,
        "startLine": node.start_line,
        "endLine": node.end_line,
        "signature": node.signature,
        "language": node.language,
        "className": node.class_name,
        "isDead": node.is_dead,
        "isEntryPoint": node.is_entry_point,
        "isExported": node.is_exported,
        # B2: the impl a public export-alias stub redirects to (e.g. preact `Component` →
        # `BaseComponent`). Emitted so the engine's resolver can follow it (Symbol.aliasOf).
        "aliasOf": node.properties.get("alias_of"),
    }


def _serialize_edge(rel: GraphRelationship) -> dict:
    """Convert a GraphRelationship to a camelCase dict for the frontend."""
    return {
        "id": rel.id,
        "type": rel.type.value,
        "source": rel.source,
        "target": rel.target,
        "confidence": rel.properties.get("confidence", 1.0),
        "strength": rel.properties.get("strength"),
        "stepNumber": rel.properties.get("step_number"),
    }


@router.get("/graph")
def get_graph(request: Request) -> dict:
    """Load the full knowledge graph and serialize all nodes and edges."""
    storage = request.app.state.storage
    try:
        graph = storage.load_graph()
    except Exception as exc:
        logger.error("Failed to load graph: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to load graph") from exc

    nodes = [_serialize_node(n) for n in graph.iter_nodes()]
    edges = [_serialize_edge(r) for r in graph.iter_relationships()]

    return {"nodes": nodes, "edges": edges, "total": len(nodes)}


@router.get("/node/{node_id:path}")
def get_node(node_id: str, request: Request) -> dict:
    """Get a single node with its callers, callees, type refs, and process memberships."""
    if len(node_id) > 500:
        raise HTTPException(status_code=400, detail="Node ID too long")

    storage = request.app.state.storage

    node = storage.get_node(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail="Node not found")

    callers = [
        {"node": _serialize_node(n), "confidence": conf}
        for n, conf in storage.get_callers_with_confidence(node_id)
    ]

    callees = [
        {"node": _serialize_node(n), "confidence": conf}
        for n, conf in storage.get_callees_with_confidence(node_id)
    ]

    type_refs = [_serialize_node(n) for n in storage.get_type_refs(node_id)]

    process_memberships = storage.get_process_memberships([node_id])

    # File-level context for the symbol's file (best-effort — never fail the detail
    # view because a secondary lookup errored).
    imports: list[str] = []
    coupled_with: list[dict] = []
    if node.file_path:
        try:
            imports = storage.get_file_imports(node.file_path)
        except Exception:
            logger.debug("get_file_imports failed for %s", node.file_path, exc_info=True)
        try:
            coupled_with = [
                {"file": other, "strength": strength, "coChanges": co_changes}
                for other, strength, co_changes in storage.get_file_coupling(node.file_path)
            ]
        except Exception:
            logger.debug("get_file_coupling failed for %s", node.file_path, exc_info=True)

    # Communities the node belongs to, with both id and name.
    communities: list[dict] = []
    try:
        communities = [
            {"id": cid, "name": cname}
            for cid, cname, _cohesion, members in storage.get_communities_with_members()
            if node_id in (members or [])
        ]
    except Exception:
        logger.debug("get_communities_with_members failed", exc_info=True)

    node_payload = _serialize_node(node)
    node_payload["content"] = node.content

    return {
        "node": node_payload,
        "callers": callers,
        "callees": callees,
        "typeRefs": type_refs,
        "processMemberships": process_memberships,
        "imports": imports,
        "coupledWith": coupled_with,
        "communities": communities,
    }


class NodeLinesRequest(BaseModel):
    """Body for POST /nodes/lines — batch id -> line-range hydration."""

    ids: list[str] = Field(default_factory=list, max_length=1000)


@router.post("/nodes/lines")
def get_nodes_lines(body: NodeLinesRequest, request: Request) -> dict:
    """Resolve a batch of node IDs to their line ranges (CLI line hydration).

    Returns ``{"lines": {id: {"filePath", "startLine", "endLine"}}}`` for every ID
    that resolves to a node; unknown IDs are simply omitted.
    """
    storage = request.app.state.storage
    lines: dict[str, dict] = {}
    for node_id in body.ids:
        if not node_id or len(node_id) > 500:
            continue
        node = storage.get_node(node_id)
        if node is None:
            continue
        lines[node_id] = {
            "filePath": node.file_path,
            "startLine": node.start_line,
            "endLine": node.end_line,
        }
    return {"lines": lines}


@router.get("/overview")
def get_overview(request: Request) -> dict:
    """Return aggregate counts of nodes by label, edges by type, and totals."""
    storage = request.app.state.storage

    nodes_by_label: dict[str, int] = {}
    total_nodes = 0
    try:
        nodes_by_label = storage.count_nodes_by_label()
        total_nodes = sum(nodes_by_label.values())
    except Exception:
        logger.warning("Failed to query node counts", exc_info=True)

    edges_by_type: dict[str, int] = {}
    total_edges = 0
    try:
        edges_by_type = storage.count_edges_by_type()
        total_edges = sum(edges_by_type.values())
    except Exception:
        logger.warning("Failed to query edge counts", exc_info=True)

    return {
        "nodesByLabel": nodes_by_label,
        "edgesByType": edges_by_type,
        "totalNodes": total_nodes,
        "totalEdges": total_edges,
    }
