"""Host metadata route for shared Horus host discovery."""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(tags=["host"])


@router.get("/host")
def get_host_info(request: Request) -> dict:
    """Return metadata about the currently running Horus host.

    ``indexing`` is True while a fresh index or interrupted re-embed is still
    running in the background. The host binds its port and answers this route
    immediately, so callers treat the host as reachable and surface "indexing
    in progress" rather than waiting on a slow startup (HOR-425).

    ``structuralReady`` / ``embeddingsPending`` refine that signal for the
    symbol-only degraded-mode contract (B1.4): the structural index (symbols +
    edges — search / explain / blast-radius) is persisted and searchable the
    moment ``structuralReady`` flips True, even while ``indexing`` is still True
    because embeddings are warming in the background. ``embeddingsPending`` is
    True in exactly that window, so a client can tell "usable now, semantic
    search warming" from "nothing yet". Search degrades to FTS-only until the
    vectors land.
    """
    runtime = getattr(request.app.state, "runtime", None)
    indexing = bool(getattr(runtime, "indexing", False)) if runtime is not None else False
    structural_ready = (
        bool(getattr(runtime, "structural_ready", False)) if runtime is not None else False
    )
    # Embeddings are still pending exactly while the structural index is ready but the
    # background indexing pass (which computes vectors) has not finished.
    embeddings_pending = structural_ready and indexing
    return {
        "repoPath": str(request.app.state.repo_path) if request.app.state.repo_path else None,
        "hostUrl": getattr(request.app.state, "host_url", None),
        "mcpUrl": getattr(request.app.state, "mcp_url", None),
        "watch": getattr(request.app.state, "watch", False),
        "mode": getattr(request.app.state, "mode", "standalone"),
        "indexing": indexing,
        "structuralReady": structural_ready,
        "embeddingsPending": embeddings_pending,
    }
