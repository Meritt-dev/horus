"""Tests for the storage backend factory + legacy-store pruning (HOR-392)."""

from __future__ import annotations

from pathlib import Path

import pytest

from horus_source.core.storage import factory
from horus_source.core.storage.base import StorageBackend
from horus_source.core.storage.sqlite_backend import SqliteBackend


def test_default_backend_is_sqlite(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HORUS_SOURCE_STORAGE_BACKEND", raising=False)
    assert factory.backend_name() == factory.SQLITE
    assert isinstance(factory.create_backend(), SqliteBackend)


def test_env_selects_kuzu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HORUS_SOURCE_STORAGE_BACKEND", "kuzu")
    assert factory.backend_name() == factory.KUZU
    backend = factory.create_backend()
    assert isinstance(backend, StorageBackend)
    assert type(backend).__name__ == "KuzuBackend"


def test_unknown_env_falls_back_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HORUS_SOURCE_STORAGE_BACKEND", "neo4j")
    assert factory.backend_name() == factory.SQLITE


def test_store_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("HORUS_SOURCE_STORAGE_BACKEND", raising=False)
    assert factory.store_path(tmp_path) == tmp_path / "horus.db"
    assert factory.store_path(tmp_path, "kuzu") == tmp_path / "kuzu"


def test_store_exists(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("HORUS_SOURCE_STORAGE_BACKEND", raising=False)
    assert factory.store_exists(tmp_path) is False
    (tmp_path / "horus.db").write_text("", encoding="utf-8")
    assert factory.store_exists(tmp_path) is True


def test_prune_legacy_kuzu_store(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("HORUS_SOURCE_STORAGE_BACKEND", raising=False)
    # A legacy kuzu store (single file + sidecar) plus the new sqlite store.
    (tmp_path / "kuzu").write_text("legacy", encoding="utf-8")
    (tmp_path / "kuzu.wal").write_text("", encoding="utf-8")
    (tmp_path / "horus.db").write_text("", encoding="utf-8")

    assert factory.prune_legacy_kuzu_store(tmp_path) is True
    assert not (tmp_path / "kuzu").exists()
    assert not (tmp_path / "kuzu.wal").exists()
    # The active sqlite store is untouched.
    assert (tmp_path / "horus.db").exists()
    # Idempotent: nothing left to prune.
    assert factory.prune_legacy_kuzu_store(tmp_path) is False


def test_prune_noop_when_backend_is_kuzu(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("HORUS_SOURCE_STORAGE_BACKEND", "kuzu")
    (tmp_path / "kuzu").write_text("legacy", encoding="utf-8")
    assert factory.prune_legacy_kuzu_store(tmp_path) is False
    assert (tmp_path / "kuzu").exists()
