"""FastAPI application factory for the Horus Web UI.

Creates a configured FastAPI app that wraps the StorageBackend,
serves API routes, and optionally mounts the frontend SPA.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from httpx import ReadError
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.routing import Route

from horus_source import __version__
from horus_source.core.memory.writer import MemoryWriter
from horus_source.core.storage.factory import create_backend
from horus_source.mcp.server import create_streamable_http_app
from horus_source.runtime import HorusRuntime
from horus_source.web.routes.analysis import router as analysis_router
from horus_source.web.routes.cypher import router as cypher_router
from horus_source.web.routes.diff import router as diff_router
from horus_source.web.routes.events import router as events_router
from horus_source.web.routes.files import router as files_router
from horus_source.web.routes.graph import router as graph_router
from horus_source.web.routes.host import router as host_router
from horus_source.web.routes.memory import router as memory_router
from horus_source.web.routes.processes import router as processes_router
from horus_source.web.routes.search import router as search_router

logger = logging.getLogger(__name__)


FRONTEND_DIR = Path(__file__).resolve().parent / "frontend" / "dist"


def create_app(
    db_path: Path,
    repo_path: Path | None = None,
    watch: bool = False,
    dev: bool = False,
    runtime: HorusRuntime | None = None,
    mount_mcp: bool = False,
    host_url: str | None = None,
    mcp_url: str | None = None,
    mount_frontend: bool = True,
    strict_host: bool = True,
) -> FastAPI:
    """Build and return a fully configured FastAPI application.

    Args:
        db_path: Path to the KuzuDB database directory.
        repo_path: Root of the repository (for file serving and reindex).
        watch: When True, enables SSE event streaming and reindex support.
        dev: When True, skips static file serving (use Vite dev server instead).

    Returns:
        A ready-to-run FastAPI instance.
    """
    if runtime is None:
        storage = create_backend()
        storage.initialize(db_path, read_only=True)
        runtime = HorusRuntime(
            storage=storage,
            repo_path=repo_path,
            watch=watch,
            host_url=host_url,
            mcp_url=mcp_url,
            owns_storage=True,
        )
    else:
        runtime.repo_path = repo_path if repo_path is not None else runtime.repo_path
        runtime.watch = watch
        runtime.host_url = host_url or runtime.host_url
        runtime.mcp_url = mcp_url or runtime.mcp_url
        if runtime.event_listeners is None and watch:
            runtime.event_listeners = []

    session_manager = None
    streamable_http_app = None
    if mount_mcp:
        session_manager, streamable_http_app = create_streamable_http_app()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # Start the single serialized memory writer once the loop is running, so
        # the host's RW memory store is mutated only through one drained queue.
        memory_writer: MemoryWriter | None = None
        if runtime.memory_store is not None:
            memory_writer = MemoryWriter(runtime.memory_store)
            memory_writer.start()
            app.state.memory_writer = memory_writer
        try:
            if session_manager is not None:
                async with session_manager.run():
                    yield
            else:
                yield
        finally:
            if memory_writer is not None:
                await memory_writer.aclose()
            if runtime.owns_storage:
                runtime.storage.close()
                if runtime.memory_store is not None:
                    runtime.memory_store.close()
                logger.info("Storage backend closed")

    app = FastAPI(
        title="Horus Web UI",
        description="Graph-powered code intelligence engine",
        version=__version__,
        lifespan=lifespan,
    )

    app.state.runtime = runtime
    app.state.storage = runtime.storage
    app.state.memory_store = runtime.memory_store
    app.state.memory_writer = None  # set in lifespan when a memory store is owned
    app.state.repo_path = runtime.repo_path
    app.state.event_listeners = runtime.event_listeners
    app.state.watch = runtime.watch
    app.state.host_url = runtime.host_url
    app.state.mcp_url = runtime.mcp_url
    app.state.mode = "host" if mount_mcp else "standalone"

    # Host-header validation (DNS-rebinding defense). A browser page on an
    # attacker domain that resolves to 127.0.0.1 sends its OWN domain as the Host
    # header; rejecting non-loopback Host values stops it from driving the API or
    # the mounted /mcp transport. Skipped when the operator explicitly binds a
    # public interface (strict_host=False) — they have opted into LAN exposure.
    if strict_host:
        app.add_middleware(
            TrustedHostMiddleware,
            allowed_hosts=["localhost", "127.0.0.1", "[::1]", "testserver"],
        )

    # CORS is only relevant for the Vite dev server (localhost:5173 -> :8420); the
    # shipped UI is same-origin. No credentials are used (the API has no cookie/
    # auth), so allow_credentials stays off — a malicious localhost:* page cannot
    # make credentialed calls.
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"https?://localhost(:\d+)?",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Accept"],
    )

    app.include_router(graph_router, prefix="/api")
    app.include_router(host_router, prefix="/api")
    app.include_router(search_router, prefix="/api")
    app.include_router(analysis_router, prefix="/api")
    app.include_router(files_router, prefix="/api")
    app.include_router(cypher_router, prefix="/api")
    app.include_router(diff_router, prefix="/api")
    app.include_router(processes_router, prefix="/api")
    app.include_router(events_router, prefix="/api")
    # Memory index routes (contract C) are mounted ONLY when the host owns the RW
    # memory store; otherwise they are absent and the TS client falls back to Jaccard.
    if runtime.memory_store is not None:
        app.include_router(memory_router, prefix="/api")

    if streamable_http_app is not None:
        app.router.routes.append(Route("/mcp", endpoint=streamable_http_app))

    if mount_frontend and not dev and FRONTEND_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
        logger.info("Serving frontend from %s", FRONTEND_DIR)
    elif mount_frontend and dev:
        logger.info("Dev mode: skipping static file mount (use Vite on :5173)")
    elif mount_frontend and not dev:
        # Source / dev-install case: the frontend has not been built, so there
        # is no dist/ to serve. Instead of letting "/" fall through to a bare
        # 404, serve a friendly page that explains the API is up and how to
        # build the explorer UI.
        logger.info("Frontend not built at %s; serving fallback landing page", FRONTEND_DIR)

        @app.get("/", include_in_schema=False)
        def _frontend_not_built() -> Response:
            return Response(content=_FRONTEND_FALLBACK_HTML, media_type="text/html")

    return app


_FRONTEND_FALLBACK_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Horus — UI not built</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 40rem;
         margin: 4rem auto; padding: 0 1.5rem; line-height: 1.6; color: #1a1a1a; }
  code { background: #f0f0f0; padding: 0.1rem 0.35rem; border-radius: 4px; }
  a { color: #2563eb; }
  .hint { color: #555; }
</style>
</head>
<body>
<h1>Horus API is running</h1>
<p>The web explorer UI has not been built yet, so there is nothing to serve here.</p>
<p>The backend is fully available. Try:</p>
<ul>
  <li><a href="/api/health">/api/health</a> — codebase health score</li>
  <li><a href="/api/overview">/api/overview</a> — graph overview stats</li>
</ul>
<p class="hint">To enable the explorer UI, run
  <code>npm run build</code> in <code>web/frontend</code>, then restart the server.</p>
</body>
</html>
"""


def create_ui_proxy_app(api_base_url: str, *, dev: bool = False) -> FastAPI:
    """Create a UI-only app that proxies API requests to an existing backend."""
    app = FastAPI(title="Horus UI Proxy", description="UI proxy for a shared Horus backend")

    async def _proxy_request(request: Request, path: str = "") -> Response:
        upstream = f"{api_base_url}/api/{path}".rstrip("/")
        body = await request.body()
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() not in {"host", "content-length", "connection"}
        }

        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=300.0)) as client:
            if request.url.path == "/api/events":
                upstream_request = client.build_request(
                    request.method,
                    upstream,
                    params=request.query_params,
                    headers=headers,
                    content=body if body else None,
                )
                upstream_stream = await client.send(upstream_request, stream=True)

                async def _iter_bytes():
                    try:
                        async for chunk in upstream_stream.aiter_bytes():
                            yield chunk
                    except ReadError:
                        logger.debug("Managed host SSE stream closed", exc_info=True)
                    finally:
                        await upstream_stream.aclose()

                return StreamingResponse(
                    _iter_bytes(),
                    status_code=upstream_stream.status_code,
                    headers={
                        key: value
                        for key, value in upstream_stream.headers.items()
                        if key.lower() not in {"content-length", "connection"}
                    },
                    media_type=upstream_stream.headers.get("content-type"),
                )

            response = await client.request(
                request.method,
                upstream,
                params=request.query_params,
                headers=headers,
                content=body if body else None,
            )
            return Response(
                content=response.content,
                status_code=response.status_code,
                headers={
                    key: value
                    for key, value in response.headers.items()
                    if key.lower() not in {"content-length", "connection"}
                },
                media_type=response.headers.get("content-type"),
            )

    app.add_api_route("/api", _proxy_request, methods=["GET", "POST", "OPTIONS"])
    app.add_api_route("/api/{path:path}", _proxy_request, methods=["GET", "POST", "OPTIONS"])

    if not dev and FRONTEND_DIR.is_dir():
        app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
    elif dev:
        logger.info("Dev mode: skipping static file mount (use Vite on :5173)")

    return app
