"""Graceful failure when the sqlite-vec (vec0) extension is unavailable (HOR-392).

The SQLite storage backend depends on the ``sqlite-vec`` extension for vector
search. That package ships no musl/Alpine (``musllinux``) wheel and no source
distribution, so on Alpine-based images it can neither be installed nor loaded.
These tests simulate both failure modes — a missing import and a load that
raises — and assert that :meth:`SqliteBackend.initialize` surfaces a single,
actionable :class:`SqliteVecUnavailableError` instead of a cryptic
``ImportError`` / ``OperationalError``.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from horus_source.core.storage import sqlite_backend
from horus_source.core.storage.sqlite_backend import (
    SqliteBackend,
    SqliteVecUnavailableError,
)


def _assert_actionable(message: str) -> None:
    """The error must name the real cause and both supported fixes."""
    assert "sqlite-vec" in message
    # Names the cause: no musl/Alpine wheel.
    assert "musl" in message and "Alpine" in message
    # Fix 1: use a glibc Python.
    assert "glibc" in message
    # Fix 2: the kuzu escape hatch via the env flag.
    assert "HORUS_SOURCE_STORAGE_BACKEND=kuzu" in message


def test_initialize_raises_clear_error_when_import_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Simulate Alpine: `import sqlite_vec` failed, so the module attr is None."""
    monkeypatch.setattr(sqlite_backend, "sqlite_vec", None)
    monkeypatch.setattr(
        sqlite_backend,
        "_SQLITE_VEC_IMPORT_ERROR",
        ModuleNotFoundError("No module named 'sqlite_vec'"),
    )

    backend = SqliteBackend()
    with pytest.raises(SqliteVecUnavailableError) as excinfo:
        backend.initialize(tmp_path / "horus.db")

    _assert_actionable(str(excinfo.value))
    # The original import failure is preserved as the cause for debugging…
    assert isinstance(excinfo.value.__cause__, ModuleNotFoundError)
    # …but the raised type is our actionable error, not a raw ImportError.
    assert not isinstance(excinfo.value, ImportError)


def test_initialize_raises_clear_error_when_extension_load_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """sqlite_vec imported but its bundled vec0 extension refuses to load."""
    if sqlite_backend.sqlite_vec is None:
        pytest.skip("sqlite_vec is not importable in this environment")

    def _boom(_conn: sqlite3.Connection) -> None:
        raise sqlite3.OperationalError("cannot load extension: vec0")

    monkeypatch.setattr(sqlite_backend.sqlite_vec, "load", _boom)

    backend = SqliteBackend()
    with pytest.raises(SqliteVecUnavailableError) as excinfo:
        backend.initialize(tmp_path / "horus.db")

    _assert_actionable(str(excinfo.value))
    # The raw OperationalError is chained, not surfaced directly.
    assert isinstance(excinfo.value.__cause__, sqlite3.OperationalError)
    assert not isinstance(excinfo.value, sqlite3.OperationalError)


def test_failure_does_not_silently_fall_back_to_kuzu(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The backend must fail loudly — never auto-swap to kùzu and hide the gap."""
    monkeypatch.setattr(sqlite_backend, "sqlite_vec", None)
    monkeypatch.setattr(
        sqlite_backend,
        "_SQLITE_VEC_IMPORT_ERROR",
        ModuleNotFoundError("No module named 'sqlite_vec'"),
    )

    backend = SqliteBackend()
    with pytest.raises(SqliteVecUnavailableError):
        backend.initialize(tmp_path / "horus.db")
    # No usable connection was left open behind a swallowed error.
    assert backend._conn is None
