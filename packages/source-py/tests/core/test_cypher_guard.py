"""Tests for the read-only SQL console guard (HOR-392 stage 2)."""

from __future__ import annotations

import pytest

from horus_source.core.cypher_guard import is_read_only_sql, sanitize_sql


@pytest.mark.parametrize(
    "query",
    [
        "SELECT * FROM nodes",
        "select id from nodes where label = 'function'",
        "WITH x AS (SELECT id FROM nodes) SELECT * FROM x",
        "  SELECT count(*) FROM edges  ",
        "SELECT name FROM nodes;",  # single trailing semicolon allowed
        "SELECT name FROM nodes -- DROP TABLE nodes",  # write keyword only in comment
    ],
)
def test_accepts_read_only(query: str) -> None:
    assert is_read_only_sql(query) is True


@pytest.mark.parametrize(
    "query",
    [
        "",
        "   ",
        "INSERT INTO nodes VALUES (1)",
        "UPDATE nodes SET name = 'x'",
        "DELETE FROM nodes",
        "DROP TABLE nodes",
        "CREATE TABLE evil (x)",
        "ALTER TABLE nodes ADD COLUMN x",
        "PRAGMA journal_mode=WAL",
        "ATTACH DATABASE 'x' AS y",
        "SELECT 1; DROP TABLE nodes",  # second statement
        "SELECT 1; SELECT 2",  # multiple statements
        "MATCH (n) RETURN n",  # cypher, not SQL SELECT/WITH
        "/* harmless */ CREATE TABLE evil (x)",  # write keyword outside comment
        "SELECT load_extension('evil.so')",  # code loading disguised as a SELECT
    ],
)
def test_rejects_writes_and_non_select(query: str) -> None:
    assert is_read_only_sql(query) is False


def test_sanitize_sql_strips_comments() -> None:
    assert "DROP" not in sanitize_sql("SELECT 1 -- DROP")
    assert "DROP" not in sanitize_sql("SELECT 1 /* DROP */ FROM nodes")
