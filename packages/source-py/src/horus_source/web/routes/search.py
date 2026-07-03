"""Search API route — hybrid search across the knowledge graph."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from horus_source.core.embeddings.embedder import embed_query
from horus_source.core.search.hybrid import hybrid_search

logger = logging.getLogger(__name__)

router = APIRouter(tags=["search"])


class SearchRequest(BaseModel):
    """Body for the POST /search endpoint."""

    query: str = Field(min_length=1, max_length=1000)
    limit: int = Field(default=20, ge=1, le=200)


class ContentSearchRequest(BaseModel):
    """Body for the POST /content-search endpoint."""

    tokens: list[str] = Field(min_length=1, max_length=50)
    limit: int = Field(default=20, ge=1, le=500)
    # When true, return per-token distinct FILE paths instead of node content:
    # {"matches": {token: [file_path, ...]}} with `limit` as a PER-TOKEN budget.
    # Backs the engine's external-system detection — content payloads would be
    # wasteful and a shared OR-limit lets common tokens crowd out rare ones.
    filesOnly: bool = False  # noqa: N815 — JSON wire key from the TS client


@router.post("/search")
def search(body: SearchRequest, request: Request) -> dict:
    """Run hybrid search (FTS + optional vector) and return results."""
    storage = request.app.state.storage

    query_embedding = embed_query(body.query)
    if query_embedding is None:
        logger.warning("Embedding failed for query %r; falling back to FTS-only", body.query)

    try:
        results = hybrid_search(
            body.query,
            storage,
            query_embedding=query_embedding,
            limit=body.limit,
        )
    except Exception as exc:
        logger.error("Search failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Search failed") from exc

    return {
        "results": [
            {
                "nodeId": r.node_id,
                "score": r.score,
                "name": r.node_name,
                "filePath": r.file_path,
                "label": r.label,
                "snippet": r.snippet,
            }
            for r in results
        ]
    }


@router.post("/content-search")
def content_search(body: ContentSearchRequest, request: Request) -> dict:
    """Return nodes whose full content contains ANY of the given tokens.

    Backs the CLI stitcher: results carry the **full** untruncated content, not a
    snippet, so the caller can stitch evidence without a follow-up fetch.
    """
    storage = request.app.state.storage
    if body.filesOnly:
        try:
            matches = storage.files_containing(body.tokens, body.limit)
        except Exception as exc:
            logger.error("Content search (filesOnly) failed: %s", exc, exc_info=True)
            raise HTTPException(status_code=500, detail="Content search failed") from exc
        return {"matches": matches}

    try:
        rows = storage.content_contains_any(body.tokens, body.limit)
    except Exception as exc:
        logger.error("Content search failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Content search failed") from exc

    return {
        "results": [
            {
                "nodeId": r.get("id", ""),
                "name": r.get("name", ""),
                "filePath": r.get("file_path", ""),
                "content": r.get("content", ""),
            }
            for r in rows
        ]
    }


@router.get("/symbols/exact")
def symbols_exact(
    request: Request,
    name: str = Query(..., min_length=1, max_length=500),
    limit: int = Query(default=10, ge=1, le=200),
) -> dict:
    """Exact-name symbol lookup (excludes file nodes) with line ranges.

    Wraps :meth:`StorageBackend.exact_name_search`, drops file-label hits, and
    hydrates ``startLine``/``endLine`` so this also serves batch line-hydration.
    """
    storage = request.app.state.storage
    try:
        hits = storage.exact_name_search(name, limit)
    except Exception as exc:
        logger.error("Exact symbol search failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Exact symbol search failed") from exc

    results: list[dict] = []
    for hit in hits:
        if hit.label == "file":
            continue
        node = storage.get_node(hit.node_id)
        results.append(
            {
                "nodeId": hit.node_id,
                "name": hit.node_name,
                "filePath": hit.file_path,
                "label": hit.label,
                "startLine": node.start_line if node else 0,
                "endLine": node.end_line if node else 0,
            }
        )
    return {"results": results}


@router.get("/symbols")
def symbols_by_label(
    request: Request,
    labels: str = Query(..., min_length=1, max_length=500),
    limit: int = Query(default=1000, ge=1, le=10000),
) -> dict:
    """Return symbol nodes for the given comma-separated lowercase labels.

    Backs the CLI's source-graph extraction (``extractSourceGraph``).
    """
    storage = request.app.state.storage
    label_list = [lab.strip() for lab in labels.split(",") if lab.strip()]
    if not label_list:
        return {"symbols": []}
    try:
        rows = storage.symbols_by_label(label_list, limit)
    except Exception as exc:
        logger.error("Symbols-by-label query failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Symbols query failed") from exc

    return {
        "symbols": [
            {
                "id": r.get("id", ""),
                "label": r.get("label", ""),
                "name": r.get("name", ""),
                "filePath": r.get("file_path", ""),
                "startLine": r.get("start_line", 0),
                "endLine": r.get("end_line", 0),
                "className": r.get("class_name", ""),
                "isEntryPoint": r.get("is_entry_point", False),
                "isExported": r.get("is_exported", False),
                "signature": r.get("signature", ""),
            }
            for r in rows
        ]
    }
