"""Memory vector index routes — contract C on the host's serving surface (M2).

Exposes the three ``MemoryVectorIndex`` operations the TS engine seam calls:

- ``POST /api/memory/upsert`` — ``memory_index_upsert(memory_id, claim, repo, scope?)``
- ``POST /api/memory/search`` — ``memory_index_search(query, repo, k)``
- ``POST /api/memory/remove`` — ``memory_index_remove(memory_id)``

This router is mounted ONLY by the RW host (when it owns a memory store). On any
other surface it is absent, so the TS client sees a 404 and falls back to lexical
recall. Upsert/remove are enqueued through the single serialized writer and return
``202`` immediately — vector indexing must never block the caller's ``memory add``.
``scope`` is accepted for forward-compat but NOT mirrored: tenancy/visibility stay
authoritative in the TS/Postgres record to avoid drift.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from horus_source.core.memory.writer import MemoryWriter

logger = logging.getLogger(__name__)

router = APIRouter(tags=["memory"])


class MemoryUpsertRequest(BaseModel):
    memoryId: str = Field(min_length=1)  # noqa: N815 — JSON wire key from the TS client
    claim: str = Field(min_length=1)
    repo: str = Field(min_length=1)
    scope: str | None = None


class MemorySearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    repo: str = Field(min_length=1)
    limit: int = Field(default=10, ge=1, le=200)


class MemoryRemoveRequest(BaseModel):
    memoryId: str = Field(min_length=1)  # noqa: N815 — JSON wire key from the TS client


def _writer(request: Request) -> MemoryWriter:
    writer = getattr(request.app.state, "memory_writer", None)
    if writer is None:
        # The host owns no memory index (RO/standalone surface) — signal absent so
        # the TS client degrades to Jaccard rather than treating it as a hard error.
        raise HTTPException(status_code=503, detail="memory index unavailable")
    return writer


@router.post("/memory/upsert", status_code=202)
def memory_upsert(body: MemoryUpsertRequest, request: Request) -> dict:
    """Queue a claim (re)index through the serialized writer. Best-effort, non-blocking."""
    _writer(request).enqueue_upsert(body.memoryId, body.claim, body.repo)
    return {"ok": True}


@router.post("/memory/search")
async def memory_search(body: MemorySearchRequest, request: Request) -> dict:
    """Return the nearest claims to *query* within *repo* as ``{memoryId, score}``."""
    hits = await _writer(request).search(body.query, body.repo, body.limit)
    return {"results": [{"memoryId": h.memory_id, "score": h.score} for h in hits]}


@router.post("/memory/remove", status_code=202)
def memory_remove(body: MemoryRemoveRequest, request: Request) -> dict:
    """Queue a claim deletion through the serialized writer. Idempotent, non-blocking."""
    _writer(request).enqueue_remove(body.memoryId)
    return {"ok": True}
