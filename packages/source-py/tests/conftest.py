from __future__ import annotations

from pathlib import Path

import pytest

from horus_source.core.embeddings import cache as _embed_cache
from horus_source.core.storage.kuzu_backend import KuzuBackend
from horus_source.core.storage.sqlite_backend import SqliteBackend


@pytest.fixture(autouse=True)
def _disable_embedding_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Off by default so embedder tests exercise the model path, not stale cache hits.

    The embedding cache (HOR-358) is a process-wide singleton keyed by content hash;
    left on it would let one test's vectors satisfy another's identical text and would
    persist to the developer's real ~/.horus cache. Tests that want the cache opt back
    in with their own temp path. See tests/core/test_embedding_cache.py.
    """
    monkeypatch.setenv("HORUS_EMBED_CACHE", "0")
    _embed_cache._reset_shared_cache()
    yield
    _embed_cache._reset_shared_cache()


@pytest.fixture()
def kuzu_backend(tmp_path: Path) -> KuzuBackend:
    """Provide an initialised KuzuBackend in a temporary directory."""
    db_path = tmp_path / "test_db"
    b = KuzuBackend()
    b.initialize(db_path)
    yield b
    b.close()


@pytest.fixture()
def sqlite_backend(tmp_path: Path) -> SqliteBackend:
    """Provide the canonical SQLite backend in a temporary directory."""
    b = SqliteBackend()
    b.initialize(tmp_path / "horus.db")
    yield b
    b.close()


@pytest.fixture(params=["kuzu", "sqlite"])
def backend(request: pytest.FixtureRequest, tmp_path: Path):
    """A StorageBackend parametrized over every concrete implementation.

    Any test that depends on this fixture runs once per backend, so the shared
    StorageBackend-protocol suite (tests/core/test_storage_protocol.py) is the
    cheapest possible parity proof: kùzu and SQLite must agree on the seam
    (HOR-392). Test modules that need backend-specific behaviour (raw Cypher,
    corrupt-DB recovery, etc.) define their own local ``backend`` fixture, which
    shadows this one.
    """
    if request.param == "kuzu":
        b = KuzuBackend()
        b.initialize(tmp_path / "kuzu_db")
    else:
        b = SqliteBackend()
        b.initialize(tmp_path / "horus.db")
    yield b
    b.close()
