"""Shared query safety utilities for the read-only query console.

Originally guarded raw Cypher; since the kùzu→SQLite migration (HOR-392) the
default backend is SQLite, so the console now accepts read-only SQL. The Cypher
helpers are retained for the deprecation window in which ``KuzuBackend`` is still
selectable behind a flag.

PRODUCT DECISION (flagged for sign-off): exposing an arbitrary read-only SQL
console is the spike's RECOMMENDED option over dropping the feature entirely.
"""

from __future__ import annotations

import re

_COMMENT_PATTERN = re.compile(r'//.*?$|/\*.*?\*/', re.MULTILINE | re.DOTALL)

WRITE_KEYWORDS = re.compile(
    r"\b(DELETE|DROP|CREATE|SET|REMOVE|MERGE|DETACH|INSTALL|LOAD|COPY)\b",
    re.IGNORECASE,
)


def sanitize_cypher(query: str) -> str:
    """Strip comments from a Cypher query before safety checking."""
    return _COMMENT_PATTERN.sub('', query)


# --- SQL console guard (read-only) ----------------------------------------

# SQL comments: ``-- ...`` to end of line and ``/* ... */`` blocks.
_SQL_COMMENT_PATTERN = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)

# Any keyword that could mutate data, schema, settings, or load code. Matched
# case-insensitively against the comment-stripped query.
SQL_WRITE_KEYWORDS = re.compile(
    r"\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|TRUNCATE|ATTACH|DETACH|"
    r"PRAGMA|VACUUM|REINDEX|MERGE|GRANT|REVOKE|SET|load_extension)\b",
    re.IGNORECASE,
)


def sanitize_sql(query: str) -> str:
    """Strip SQL comments from a query before safety checking."""
    return _SQL_COMMENT_PATTERN.sub(" ", query)


def is_read_only_sql(query: str) -> bool:
    """Return ``True`` only for a single read-only ``SELECT``/``WITH`` statement.

    Rejects write/DDL keywords, multiple statements (anything past a non-trailing
    ``;``), and queries that do not begin with ``SELECT`` or a ``WITH`` CTE.
    """
    cleaned = sanitize_sql(query).strip()
    if not cleaned:
        return False
    # Collapse a single trailing semicolon, then reject any remaining one
    # (which would indicate a second, possibly mutating, statement).
    body = cleaned.rstrip().rstrip(";").strip()
    if ";" in body:
        return False
    if SQL_WRITE_KEYWORDS.search(cleaned):
        return False
    first = body.lstrip("(").lstrip().split(None, 1)
    return bool(first) and first[0].upper() in ("SELECT", "WITH")
