"""Analysis API routes — impact, dead code, coupling, communities, health, reindex."""

from __future__ import annotations

import asyncio
import logging
import threading
from collections import defaultdict

from fastapi import APIRouter, HTTPException, Query, Request

from horus_source.core.graph.model import RelType
from horus_source.core.ingestion.pipeline import run_pipeline
from horus_source.mcp.resources import get_dead_code_symbols
from horus_source.web.routes.graph import _serialize_node

logger = logging.getLogger(__name__)

router = APIRouter(tags=["analysis"])

# Guards against concurrent reindex runs launched via POST /reindex.
_reindex_lock = threading.Lock()


@router.get("/impact/{node_id:path}")
def get_impact(
    node_id: str,
    request: Request,
    depth: int = Query(default=3, ge=1, le=5),
    include_tests: bool = Query(default=False),
) -> dict:
    """Analyse the blast radius of a node by traversing callers up to *depth* hops.

    Product-only by default: test/docs/example callers neither appear nor extend
    the traversal (a broad symbol's blast radius was dominated by test files).
    ``include_tests=true`` restores the full graph walk.
    """
    storage = request.app.state.storage

    node = storage.get_node(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail=f"Node not found: {node_id}")

    # Blast radius always follows inheritance edges too: a base type's change
    # affects its subclasses/implementors (incoming EXTENDS/IMPLEMENTS), which
    # then expand transitively through CALLS in the same walk (B3.4).
    affected_with_depth = storage.traverse_with_depth(
        node_id,
        depth,
        direction="callers",
        product_only=not include_tests,
        rel_types=(
            RelType.CALLS.value,
            RelType.EXTENDS.value,
            RelType.IMPLEMENTS.value,
        ),
    )

    depths: dict[str, list[dict]] = defaultdict(list)
    for affected_node, hop in affected_with_depth:
        depths[str(hop)].append(_serialize_node(affected_node))

    return {
        "target": _serialize_node(node),
        "affected": len(affected_with_depth),
        "depths": dict(depths),
    }


@router.get("/dead-code")
def get_dead_code(request: Request) -> dict:
    """List all symbols flagged as dead code, grouped by file."""
    storage = request.app.state.storage

    try:
        rows = get_dead_code_symbols(storage)
    except Exception as exc:
        logger.error("Dead code query failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Dead code query failed") from exc

    if not rows:
        return {"total": 0, "byFile": {}}

    by_file: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        _, name, file_path, start_line, node_type = row
        by_file[file_path].append({
            "name": name,
            "type": str(node_type),
            "line": start_line,
        })

    return {"total": len(rows), "byFile": dict(by_file)}


@router.get("/coupling")
def get_coupling(request: Request) -> dict:
    """Return temporal coupling pairs between files."""
    storage = request.app.state.storage

    try:
        rows = storage.get_coupling_pairs()
    except Exception as exc:
        logger.error("Coupling query failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Coupling query failed") from exc

    pairs = []
    for row in rows or []:
        _, file_a, _, file_b, strength, co_changes = row
        pairs.append({
            "fileA": file_a,
            "fileB": file_b,
            "strength": strength,
            "coChanges": co_changes,
        })

    return {"pairs": pairs}


@router.get("/communities")
def get_communities(request: Request) -> dict:
    """Return community clusters with their member nodes."""
    storage = request.app.state.storage

    try:
        rows = storage.get_communities_with_members()
    except Exception as exc:
        logger.error("Communities query failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Communities query failed") from exc

    if not rows:
        return {"communities": []}

    communities = []
    for row in rows:
        cid, cname, cohesion_val, member_ids = row
        communities.append({
            "id": cid,
            "name": cname,
            "memberCount": len(member_ids) if member_ids else 0,
            "cohesion": round(cohesion_val, 4) if cohesion_val is not None else None,
            "members": member_ids or [],
        })

    return {"communities": communities}


@router.get("/health")
def get_health(request: Request) -> dict:
    """Compute a composite codebase health score from multiple dimensions."""
    storage = request.app.state.storage

    breakdown: dict[str, float] = {}

    # Dead code score (25%): 100 - (dead / total * 100)
    try:
        total_symbols_raw, dead_count = storage.count_symbols_and_dead()
        total_symbols = int(total_symbols_raw or 1)
        breakdown["deadCode"] = round(max(0.0, 100.0 - (dead_count / max(total_symbols, 1) * 100)), 1)
    except Exception:
        logger.warning("Health: dead code query failed", exc_info=True)
        breakdown["deadCode"] = 100.0

    # Coupling score (20%): 100 - (high_coupling / total_coupling * 200)
    try:
        strengths = storage.get_coupling_strengths()
        if strengths:
            total_coupling = len(strengths)
            high_coupling = sum(1 for s in strengths if s and s > 0.7)
            breakdown["coupling"] = round(
                max(0.0, 100.0 - (high_coupling / max(total_coupling, 1) * 200)), 1
            )
        else:
            breakdown["coupling"] = 100.0
    except Exception:
        logger.warning("Health: coupling query failed", exc_info=True)
        breakdown["coupling"] = 100.0

    # Modularity score (20%): community count as proxy
    try:
        comm_count = storage.count_communities()
        # Heuristic: 3-15 communities is ideal; fewer or too many is worse
        if comm_count == 0:
            breakdown["modularity"] = 20.0
        elif comm_count <= 15:
            breakdown["modularity"] = min(100.0, round(comm_count / 15.0 * 100, 1))
        else:
            breakdown["modularity"] = round(max(50.0, 100.0 - (comm_count - 15) * 2), 1)
    except Exception:
        logger.warning("Health: modularity query failed", exc_info=True)
        breakdown["modularity"] = 50.0

    # Confidence score (20%): avg(confidence) * 100 across CALLS edges
    try:
        avg_conf = storage.avg_calls_confidence()
        if avg_conf is None:
            avg_conf = 0.8
        breakdown["confidence"] = round(min(100.0, avg_conf * 100), 1)
    except Exception:
        logger.warning("Health: confidence query failed", exc_info=True)
        breakdown["confidence"] = 80.0

    # Coverage score (15%): symbols_in_processes / callable_symbols * 100
    try:
        callable_count_raw, in_process = storage.count_callables_in_processes()
        callable_count = callable_count_raw or 1
        breakdown["coverage"] = round(
            min(100.0, in_process / max(callable_count, 1) * 100), 1
        )
    except Exception:
        logger.warning("Health: coverage query failed", exc_info=True)
        breakdown["coverage"] = 0.0

    weights = {
        "deadCode": 0.25,
        "coupling": 0.20,
        "modularity": 0.20,
        "confidence": 0.20,
        "coverage": 0.15,
    }
    score = round(sum(breakdown[k] * weights[k] for k in weights), 1)

    return {"score": score, "breakdown": breakdown}


@router.post("/reindex")
async def trigger_reindex(request: Request) -> dict:
    """Trigger a reindex in a background thread.

    Only available when the app is started in watch mode (storage is read-write).

    Accepts an optional JSON body with a ``structural_only`` (alias
    ``defer_embeddings``) boolean. When set, the reindex rebuilds the structural
    graph — including inheritance edges — WITHOUT re-embedding (D6). This lets the
    `horus update`-triggered background reindex complete inheritance edges cheaply
    without paying the embedding cost.
    """
    repo_path = request.app.state.repo_path
    if repo_path is None:
        raise HTTPException(status_code=400, detail="No repo_path configured")

    if not request.app.state.watch:
        raise HTTPException(status_code=400, detail="Reindex only available in watch mode")

    # Body is optional — a bare POST keeps the full (re-embedding) reindex.
    structural_only = False
    try:
        body = await request.json()
    except Exception:
        body = None
    if isinstance(body, dict):
        structural_only = bool(body.get("structural_only") or body.get("defer_embeddings"))

    event_listeners = request.app.state.event_listeners
    loop = asyncio.get_running_loop()

    def _broadcast(event: dict) -> None:
        """Put an event into every connected client's queue (thread-safe)."""
        if not event_listeners:
            return
        for q in list(event_listeners):
            try:
                loop.call_soon_threadsafe(q.put_nowait, event)
            except Exception:
                pass

    if not _reindex_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Reindex already in progress")

    def _run_reindex() -> None:
        success = False
        try:
            _broadcast({"type": "reindex_start", "data": {}})
            storage = request.app.state.storage
            run_pipeline(repo_path, storage=storage, embeddings=not structural_only)
            logger.info(
                "Reindex completed for %s (structural_only=%s)",
                repo_path,
                structural_only,
            )
            success = True
        except Exception:
            logger.error("Reindex failed", exc_info=True)
        finally:
            _reindex_lock.release()
            _broadcast({"type": "reindex_complete" if success else "reindex_failed", "data": {}})

    thread = threading.Thread(target=_run_reindex, daemon=True)
    thread.start()

    return {"status": "started"}
