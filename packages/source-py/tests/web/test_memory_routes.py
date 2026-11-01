"""Tests for the memory index routes (contract C) on the host serving surface.

Drives the routes end-to-end through ``create_app``'s real lifespan (which starts
the serialized writer) using an in-process ASGI transport. Embedding is stubbed
with deterministic one-hot vectors so no model is loaded.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import httpx
import pytest

from horus_source.core.memory import vector_store as vs
from horus_source.core.memory.vector_store import MemoryVectorStore
from horus_source.core.storage.base import EMBEDDING_DIMENSIONS
from horus_source.runtime import HorusRuntime
from horus_source.web.app import create_app


def _unit(i: int) -> list[float]:
    v = [0.0] * EMBEDDING_DIMENSIONS
    v[i] = 1.0
    return v


@pytest.fixture
def stub_embeddings(monkeypatch: pytest.MonkeyPatch):
    registry: dict[str, int] = {}

    def _doc(text: str, model_name: str = "stub") -> list[float] | None:
        return _unit(registry[text]) if text in registry else None

    def _query(query: str) -> list[float] | None:
        return _unit(registry[query]) if query in registry else None

    monkeypatch.setattr(vs, "embed_text_document", _doc)
    monkeypatch.setattr(vs, "embed_query", _query)
    return registry


def _app_with_memory(tmp_path: Path):
    store = MemoryVectorStore()
    store.initialize(MemoryVectorStore.db_path_for_repo(tmp_path))
    runtime = HorusRuntime(
        storage=MagicMock(),
        repo_path=tmp_path,
        owns_storage=False,  # don't let lifespan close our mock/store; test owns cleanup
        memory_store=store,
    )
    app = create_app(db_path=tmp_path / "kuzu", runtime=runtime)
    return app, store


def _app_without_memory(tmp_path: Path):
    runtime = HorusRuntime(storage=MagicMock(), repo_path=tmp_path, owns_storage=False)
    # mount_frontend=False: with a locally built frontend dist, StaticFiles at "/"
    # answers the unmatched POST with 405 instead of 404 — this test is about the
    # memory ROUTER being absent, so keep it deterministic either way. (The TS
    # client treats any non-2xx as "unavailable" and falls back — both are fine
    # in production.)
    return create_app(db_path=tmp_path / "kuzu", runtime=runtime, mount_frontend=False)


async def test_upsert_search_remove_roundtrip(tmp_path: Path, stub_embeddings) -> None:
    stub_embeddings["claim about auth"] = 0
    stub_embeddings["claim about billing"] = 1
    stub_embeddings["how does auth work"] = 0

    app, store = _app_with_memory(tmp_path)
    try:
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as ac:
                r = await ac.post(
                    "/api/memory/upsert",
                    json={"memoryId": "mem_auth", "claim": "claim about auth", "repo": "acme/app"},
                )
                assert r.status_code == 202
                assert r.json() == {"ok": True}

                r = await ac.post(
                    "/api/memory/upsert",
                    json={
                        "memoryId": "mem_bill",
                        "claim": "claim about billing",
                        "repo": "acme/app",
                        "scope": "private",  # accepted but not mirrored
                    },
                )
                assert r.status_code == 202

                # Drain the serialized writer so the read is deterministic.
                await app.state.memory_writer.join()

                r = await ac.post(
                    "/api/memory/search",
                    json={"query": "how does auth work", "repo": "acme/app", "limit": 5},
                )
                assert r.status_code == 200
                results = r.json()["results"]
                assert results[0]["memoryId"] == "mem_auth"
                assert results[0]["score"] == pytest.approx(1.0)
                assert {x["memoryId"] for x in results} == {"mem_auth", "mem_bill"}

                # Remove and confirm it disappears.
                r = await ac.post("/api/memory/remove", json={"memoryId": "mem_auth"})
                assert r.status_code == 202
                await app.state.memory_writer.join()

                r = await ac.post(
                    "/api/memory/search",
                    json={"query": "how does auth work", "repo": "acme/app", "limit": 5},
                )
                assert {x["memoryId"] for x in r.json()["results"]} == {"mem_bill"}
    finally:
        store.close()


async def test_search_is_repo_isolated(tmp_path: Path, stub_embeddings) -> None:
    stub_embeddings["shared claim"] = 0
    stub_embeddings["q"] = 0

    app, store = _app_with_memory(tmp_path)
    try:
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as ac:
                await ac.post(
                    "/api/memory/upsert",
                    json={"memoryId": "mem_a", "claim": "shared claim", "repo": "repo/a"},
                )
                await ac.post(
                    "/api/memory/upsert",
                    json={"memoryId": "mem_b", "claim": "shared claim", "repo": "repo/b"},
                )
                await app.state.memory_writer.join()

                r = await ac.post(
                    "/api/memory/search", json={"query": "q", "repo": "repo/a", "limit": 10}
                )
                assert [x["memoryId"] for x in r.json()["results"]] == ["mem_a"]
    finally:
        store.close()


async def test_routes_absent_without_memory_store(tmp_path: Path) -> None:
    app = _app_without_memory(tmp_path)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as ac:
            # Router not mounted on RO/standalone surfaces => 404 so TS falls back.
            r = await ac.post(
                "/api/memory/search", json={"query": "x", "repo": "acme/app", "limit": 5}
            )
            assert r.status_code == 404
