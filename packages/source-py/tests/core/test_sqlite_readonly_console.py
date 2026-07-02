"""The SQL console (execute_raw) must be read-only at the connection level.

Regression for the audit finding: the console ran on the host's read-WRITE
connection, so the route's keyword-blocklist regex was the ONLY thing stopping
a write. execute_raw now runs on a dedicated `mode=ro` connection, so a query
that slips past the guard still cannot mutate the store — SQLite rejects it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from horus_source.core.graph.model import GraphNode, NodeLabel
from horus_source.core.storage.sqlite_backend import SqliteBackend


@pytest.fixture()
def rw_backend(tmp_path: Path):
    """A read-WRITE backend (host mode) with one node, mirroring the live host."""
    b = SqliteBackend()
    b.initialize(tmp_path / "horus.db")
    b.add_nodes(
        [GraphNode(id="function:src/a.py:foo", label=NodeLabel.FUNCTION, name="foo", file_path="src/a.py")]
    )
    yield b
    b.close()


def test_select_through_console_works(rw_backend: SqliteBackend) -> None:
    rows = rw_backend.execute_raw("SELECT id, name FROM nodes")
    assert ["function:src/a.py:foo", "foo"] in rows


@pytest.mark.parametrize(
    "write_query",
    [
        "DELETE FROM nodes",
        "UPDATE nodes SET name = 'x'",
        "DROP TABLE nodes",
        "INSERT INTO nodes (id, label, name) VALUES ('x', 'function', 'x')",
    ],
)
def test_writes_through_console_are_rejected_at_the_connection(
    rw_backend: SqliteBackend, write_query: str
) -> None:
    # execute_raw uses a mode=ro connection, so the write raises regardless of the
    # route guard (which would also reject these — this proves defense in depth).
    with pytest.raises(Exception) as exc:
        rw_backend.execute_raw(write_query)
    assert "readonly" in str(exc.value).lower() or "read-only" in str(exc.value).lower()

    # And the store is untouched — the node is still there.
    rows = rw_backend.execute_raw("SELECT id FROM nodes")
    assert ["function:src/a.py:foo"] in rows


def test_host_write_path_still_works_after_console_use(rw_backend: SqliteBackend) -> None:
    """The read-only console connection must not interfere with legitimate writes
    on the main connection (reindex/watch)."""
    rw_backend.execute_raw("SELECT 1")  # opens the RO console connection
    rw_backend.add_nodes(
        [GraphNode(id="function:src/b.py:bar", label=NodeLabel.FUNCTION, name="bar", file_path="src/b.py")]
    )
    assert rw_backend.get_node("function:src/b.py:bar") is not None


def test_readonly_opened_backend_reuses_main_connection(tmp_path: Path) -> None:
    """When the backend itself is opened read-only, execute_raw reuses it."""
    dbp = tmp_path / "horus.db"
    writer = SqliteBackend()
    writer.initialize(dbp)
    writer.add_nodes(
        [GraphNode(id="function:src/a.py:foo", label=NodeLabel.FUNCTION, name="foo", file_path="src/a.py")]
    )
    writer.close()

    reader = SqliteBackend()
    reader.initialize(dbp, read_only=True)
    try:
        rows = reader.execute_raw("SELECT id FROM nodes")
        assert ["function:src/a.py:foo"] in rows
        with pytest.raises(Exception):
            reader.execute_raw("DELETE FROM nodes")
    finally:
        reader.close()


def test_console_ro_enforced_when_path_has_uri_delimiters(tmp_path: Path) -> None:
    """A repo path containing URI delimiters (`?`, `#`) must not defeat the
    mode=ro console connection. Regression for the unescaped ``file:{path}?mode=ro``
    URI, where SQLite would truncate the filename at `?` and never see `mode=ro`.
    """
    weird = tmp_path / "repo?x#y"
    weird.mkdir()
    dbp = weird / "horus.db"

    b = SqliteBackend()
    b.initialize(dbp)  # read-WRITE host
    b.add_nodes(
        [GraphNode(id="function:src/a.py:foo", label=NodeLabel.FUNCTION, name="foo", file_path="src/a.py")]
    )
    try:
        # The console opens a SEPARATE mode=ro connection to this exact file:
        # a correct read proves it opened the right DB, and the rejected write
        # proves the read-only flag survived the escaping.
        assert ["function:src/a.py:foo"] in b.execute_raw("SELECT id FROM nodes")
        with pytest.raises(Exception) as exc:
            b.execute_raw("DELETE FROM nodes")
        assert "readonly" in str(exc.value).lower() or "read-only" in str(exc.value).lower()
        assert ["function:src/a.py:foo"] in b.execute_raw("SELECT id FROM nodes")
    finally:
        b.close()


def test_readonly_initialize_enforced_when_path_has_uri_delimiters(tmp_path: Path) -> None:
    """Same escaping fix for the ``initialize(read_only=True)`` open path."""
    weird = tmp_path / "repo?x#y"
    weird.mkdir()
    dbp = weird / "horus.db"

    writer = SqliteBackend()
    writer.initialize(dbp)
    writer.add_nodes(
        [GraphNode(id="function:src/a.py:foo", label=NodeLabel.FUNCTION, name="foo", file_path="src/a.py")]
    )
    writer.close()

    reader = SqliteBackend()
    reader.initialize(dbp, read_only=True)  # RO open via the escaped URI
    try:
        assert ["function:src/a.py:foo"] in reader.execute_raw("SELECT id FROM nodes")
        with pytest.raises(Exception):
            reader.execute_raw("DELETE FROM nodes")
    finally:
        reader.close()
