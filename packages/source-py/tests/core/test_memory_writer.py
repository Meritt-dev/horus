"""Tests for MemoryWriter — the single serialized async owner of the memory store.

Embedding is stubbed with deterministic one-hot vectors so these tests exercise
the enqueue/drain/serialization logic against a real kùzu store without loading
the fastembed model.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from horus_source.core.memory import vector_store as vs
from horus_source.core.memory.vector_store import MemoryVectorStore
from horus_source.core.memory.writer import MemoryWriter
from horus_source.core.storage.base import EMBEDDING_DIMENSIONS


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


@pytest.fixture
def store(tmp_path: Path) -> MemoryVectorStore:
    s = MemoryVectorStore()
    s.initialize(MemoryVectorStore.db_path_for_repo(tmp_path))
    yield s
    s.close()


async def test_upsert_search_roundtrip(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["claim about auth"] = 0
    stub_embeddings["claim about billing"] = 1
    stub_embeddings["how does auth work"] = 0

    writer = MemoryWriter(store)
    writer.start()
    try:
        writer.enqueue_upsert("mem_auth", "claim about auth", "acme/app")
        writer.enqueue_upsert("mem_bill", "claim about billing", "acme/app")
        await writer.join()  # drain the serialized writer before reading

        hits = await writer.search("how does auth work", "acme/app", limit=5)
        assert hits
        assert hits[0].memory_id == "mem_auth"
        assert hits[0].score == pytest.approx(1.0)
        assert {h.memory_id for h in hits} == {"mem_auth", "mem_bill"}
    finally:
        await writer.aclose()


async def test_search_repo_isolation(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["shared claim"] = 0
    stub_embeddings["q"] = 0

    writer = MemoryWriter(store)
    writer.start()
    try:
        writer.enqueue_upsert("mem_a", "shared claim", "repo/a")
        writer.enqueue_upsert("mem_b", "shared claim", "repo/b")
        await writer.join()

        hits_a = await writer.search("q", "repo/a", limit=10)
        assert [h.memory_id for h in hits_a] == ["mem_a"]
        hits_b = await writer.search("q", "repo/b", limit=10)
        assert [h.memory_id for h in hits_b] == ["mem_b"]
    finally:
        await writer.aclose()


async def test_remove_drops_claim(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["c"] = 0
    stub_embeddings["q"] = 0

    writer = MemoryWriter(store)
    writer.start()
    try:
        writer.enqueue_upsert("mem_c", "c", "acme/app")
        await writer.join()
        assert store.count() == 1

        writer.enqueue_remove("mem_c")
        await writer.join()
        assert store.count() == 0
        assert await writer.search("q", "acme/app", limit=5) == []
    finally:
        await writer.aclose()


async def test_enqueue_after_close_is_dropped(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["late"] = 0
    writer = MemoryWriter(store)
    writer.start()
    await writer.aclose()

    # Best-effort: enqueue after close is silently ignored, never raises.
    writer.enqueue_upsert("mem_late", "late", "acme/app")
    assert store.count() == 0


async def test_bad_op_does_not_kill_consumer(
    store: MemoryVectorStore, stub_embeddings, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_embeddings["good"] = 0

    calls = {"n": 0}
    real_upsert = store.upsert

    def _flaky(memory_id, claim, repo, *, model=vs._DEFAULT_MODEL):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        return real_upsert(memory_id, claim, repo, model=model)

    monkeypatch.setattr(store, "upsert", _flaky)

    writer = MemoryWriter(store)
    writer.start()
    try:
        writer.enqueue_upsert("mem_bad", "good", "acme/app")  # raises in consumer
        writer.enqueue_upsert("mem_ok", "good", "acme/app")  # must still be drained
        await writer.join()
        assert store.count() == 1
        assert store.get_meta("mem_ok") is not None
    finally:
        await writer.aclose()
