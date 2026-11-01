"""Tests for MemoryVectorStore — the dedicated memory claim vector index (M2).

Embedding is stubbed with deterministic unit vectors (patched at the
vector_store namespace) so these tests exercise the sqlite-vec storage / search /
scheme-refresh / isolation logic against a real database without loading the
fastembed model.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from horus_source.core.embeddings.embedder import EMBEDDING_SCHEME_VERSION
from horus_source.core.memory import vector_store as vs
from horus_source.core.memory.vector_store import (
    MemoryClaim,
    MemoryVectorStore,
    claim_hash,
)
from horus_source.core.storage.base import EMBEDDING_DIMENSIONS


def _unit(i: int) -> list[float]:
    """A 384-dim one-hot vector with 1.0 at index *i*."""
    v = [0.0] * EMBEDDING_DIMENSIONS
    v[i] = 1.0
    return v


@pytest.fixture
def stub_embeddings(monkeypatch: pytest.MonkeyPatch):
    """Map known claim/query strings to deterministic one-hot vectors.

    Returns the (mutable) text->index registry so tests can register their own
    vectors; index 0 => _unit(0), etc.
    """
    registry: dict[str, int] = {}

    def _doc(text: str, model_name: str = "stub") -> list[float] | None:
        if text not in registry:
            return None
        return _unit(registry[text])

    def _query(query: str) -> list[float] | None:
        if query not in registry:
            return None
        return _unit(registry[query])

    monkeypatch.setattr(vs, "embed_text_document", _doc)
    monkeypatch.setattr(vs, "embed_query", _query)
    return registry


@pytest.fixture
def store(tmp_path: Path) -> MemoryVectorStore:
    s = MemoryVectorStore()
    s.initialize(MemoryVectorStore.db_path_for_repo(tmp_path))
    yield s
    s.close()


def test_db_path_for_repo_is_dedicated_file(tmp_path: Path) -> None:
    p = MemoryVectorStore.db_path_for_repo(tmp_path)
    assert p == tmp_path / ".horus" / "source" / "memory.db"
    # NOT the code graph store.
    assert p != tmp_path / ".horus" / "source" / "horus.db"


def test_upsert_and_search_returns_nearest(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["claim about auth"] = 0
    stub_embeddings["claim about billing"] = 1
    stub_embeddings["how does auth work"] = 0  # query aligned with the auth claim

    assert store.upsert("mem_auth", "claim about auth", "acme/app")
    assert store.upsert("mem_bill", "claim about billing", "acme/app")

    hits = store.search("how does auth work", "acme/app", limit=5)
    assert hits
    assert hits[0].memory_id == "mem_auth"
    assert hits[0].score == pytest.approx(1.0)
    # billing claim is orthogonal => ~0 similarity
    assert {h.memory_id for h in hits} == {"mem_auth", "mem_bill"}


def test_search_repo_filtered(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["shared claim"] = 0
    stub_embeddings["q"] = 0

    store.upsert("mem_a", "shared claim", "repo/a")
    store.upsert("mem_b", "shared claim", "repo/b")

    hits = store.search("q", "repo/a", limit=10)
    assert [h.memory_id for h in hits] == ["mem_a"]


def test_upsert_skips_when_embedding_unavailable(store: MemoryVectorStore, stub_embeddings) -> None:
    # "unknown" is not registered => stub returns None => best-effort skip.
    assert store.upsert("mem_x", "unknown", "acme/app") is False
    assert store.count() == 0


def test_remove_deletes_vector_and_meta(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["c"] = 3
    store.upsert("mem_c", "c", "acme/app")
    assert store.count() == 1
    assert store.get_meta("mem_c") is not None

    store.remove("mem_c")
    assert store.count() == 0
    assert store.get_meta("mem_c") is None
    # idempotent
    store.remove("mem_c")


def test_upsert_is_idempotent_replace(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["v1"] = 0
    stub_embeddings["v2"] = 1
    store.upsert("mem_1", "v1", "acme/app")
    store.upsert("mem_1", "v2", "acme/app")  # same id, new claim

    assert store.count() == 1
    meta = store.get_meta("mem_1")
    assert meta is not None
    assert meta["claim_hash"] == claim_hash("v2")


def test_get_meta_mirrors_only_repo_hash_scheme_model(
    store: MemoryVectorStore, stub_embeddings
) -> None:
    stub_embeddings["claim"] = 2
    store.upsert("mem_m", "claim", "acme/app")

    meta = store.get_meta("mem_m")
    assert meta == {
        "memory_id": "mem_m",
        "repo": "acme/app",
        "claim_hash": claim_hash("claim"),
        "scheme_version": EMBEDDING_SCHEME_VERSION,
        "model": store_default_model(),
    }


def store_default_model() -> str:
    from horus_source.core.embeddings.embedder import _DEFAULT_MODEL

    return _DEFAULT_MODEL


def test_upsert_many_counts_indexed(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["a"] = 0
    stub_embeddings["b"] = 1
    # "missing" not registered => not indexed
    claims = [
        MemoryClaim("m_a", "a", "acme/app"),
        MemoryClaim("m_b", "b", "acme/app"),
        MemoryClaim("m_c", "missing", "acme/app"),
    ]
    assert store.upsert_many(claims) == 2
    assert store.count() == 2


def test_search_empty_inputs(store: MemoryVectorStore, stub_embeddings) -> None:
    assert store.search("", "acme/app") == []
    assert store.search("q", "") == []
    stub_embeddings["q"] = 0
    assert store.search("q", "acme/app", limit=0) == []


def test_stale_memory_ids_on_scheme_drift(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["claim"] = 0
    store.upsert("mem_old", "claim", "acme/app")
    # nothing stale yet
    assert store.stale_memory_ids() == []

    # Simulate a future scheme bump by writing an older scheme directly.
    with store._lock:
        store._conn.execute(
            "UPDATE mem_meta SET scheme_version = ? WHERE memory_id = 'mem_old'",
            (EMBEDDING_SCHEME_VERSION - 1,),
        )
        store._conn.commit()
    assert store.stale_memory_ids() == ["mem_old"]


def test_ensure_current_memory_embeddings_reembeds_stale(
    store: MemoryVectorStore, stub_embeddings
) -> None:
    stub_embeddings["claim text"] = 0
    store.upsert("mem_r", "claim text", "acme/app")

    # Force the stored vector to an old scheme.
    with store._lock:
        store._conn.execute(
            "UPDATE mem_meta SET scheme_version = ? WHERE memory_id = 'mem_r'",
            (EMBEDDING_SCHEME_VERSION - 1,),
        )
        store._conn.commit()
    assert store.stale_memory_ids() == ["mem_r"]

    # Caller supplies the authoritative claim text (TS side is source of truth).
    refreshed = store.ensure_current_memory_embeddings({"mem_r": "claim text"})
    assert refreshed == 1
    assert store.stale_memory_ids() == []
    meta = store.get_meta("mem_r")
    assert meta is not None
    assert meta["scheme_version"] == EMBEDDING_SCHEME_VERSION


def test_ensure_current_skips_unresolvable_claims(
    store: MemoryVectorStore, stub_embeddings
) -> None:
    stub_embeddings["claim text"] = 0
    store.upsert("mem_r", "claim text", "acme/app")
    with store._lock:
        store._conn.execute(
            "UPDATE mem_meta SET scheme_version = ? WHERE memory_id = 'mem_r'",
            (EMBEDDING_SCHEME_VERSION - 1,),
        )
        store._conn.commit()
    # No claim text supplied for the stale id => left untouched (best-effort).
    refreshed = store.ensure_current_memory_embeddings({})
    assert refreshed == 0
    assert store.stale_memory_ids() == ["mem_r"]


def test_python_cosine_fallback(store: MemoryVectorStore, stub_embeddings) -> None:
    stub_embeddings["auth claim"] = 0
    stub_embeddings["billing claim"] = 1
    store.upsert("mem_a", "auth claim", "acme/app")
    store.upsert("mem_b", "billing claim", "acme/app")

    hits = store._search_python(_unit(0), "acme/app", limit=5)
    assert hits[0].memory_id == "mem_a"
    assert hits[0].score == pytest.approx(1.0)


def test_read_only_rejects_writes(tmp_path: Path, stub_embeddings) -> None:
    db = MemoryVectorStore.db_path_for_repo(tmp_path)
    rw = MemoryVectorStore()
    rw.initialize(db)
    stub_embeddings["c"] = 0
    rw.upsert("mem_c", "c", "acme/app")
    rw.close()

    ro = MemoryVectorStore()
    ro.initialize(db, read_only=True)
    try:
        with pytest.raises(RuntimeError):
            ro.upsert("mem_d", "c", "acme/app")
        with pytest.raises(RuntimeError):
            ro.remove("mem_c")
        # reads still work
        assert ro.count() == 1
    finally:
        ro.close()


def test_isolation_survives_code_graph_bulk_load(tmp_path: Path, stub_embeddings) -> None:
    """Memory vectors live in their own store and survive a code-graph bulk_load.

    bulk_load wipes the entire code store (nodes, edges, and code vectors); the
    dedicated memory store must be wholly unaffected (the core decoupling
    guarantee of M2).
    """
    from horus_source.core.graph.graph import KnowledgeGraph
    from horus_source.core.storage.sqlite_backend import SqliteBackend

    repo = tmp_path
    # Memory store in .horus/source/memory.db
    mem = MemoryVectorStore()
    mem.initialize(MemoryVectorStore.db_path_for_repo(repo))
    stub_embeddings["durable claim"] = 0
    stub_embeddings["find it"] = 0
    mem.upsert("mem_keep", "durable claim", "acme/app")
    assert mem.count() == 1

    # Code graph in .horus/source/horus.db — re-analyze wipes it.
    code = SqliteBackend()
    code.initialize(repo / ".horus" / "source" / "horus.db")
    code.bulk_load(KnowledgeGraph())
    code.close()

    # Memory survived: still searchable.
    assert mem.count() == 1
    hits = mem.search("find it", "acme/app", limit=5)
    assert hits and hits[0].memory_id == "mem_keep"
    mem.close()
