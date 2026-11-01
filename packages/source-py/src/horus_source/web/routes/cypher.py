"""Query console route — read-only SQL against the storage backend.

Since the kùzu→SQLite migration (HOR-392) the default backend is SQLite, so this
console executes read-only SQL. The endpoint path (``/cypher``) is retained for
backwards compatibility with existing clients. Exposing an arbitrary read-only
SQL console is a flagged PRODUCT DECISION (the spike's recommended option).
"""

from __future__ import annotations

import logging
import re
import time

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from horus_source.core.cypher_guard import is_read_only_sql

logger = logging.getLogger(__name__)

router = APIRouter(tags=["cypher"])


class CypherRequest(BaseModel):
    """Body for the POST /cypher endpoint."""

    query: str = Field(min_length=1, max_length=10000)


def _extract_return_columns(query: str) -> list[str]:
    """Best-effort extraction of column names from a SQL SELECT list.

    Handles aliases (``AS name``), dotted columns (``n.name``), and function
    calls (``count(*)``). Returns ``[]`` for queries it cannot parse (e.g. CTEs
    or ``SELECT *``), in which case callers fall back to positional columns.
    """
    match = re.search(
        r"\bSELECT\b\s+(.*?)\s+\bFROM\b", query, re.IGNORECASE | re.DOTALL
    )
    if not match:
        return []

    select_expr = match.group(1).strip()
    if "*" in select_expr or "(" in select_expr and "," not in select_expr:
        # too ambiguous to name reliably — let the client use positional columns
        pass

    columns = []
    depth = 0
    current = ""
    # Split on top-level commas only (so function args don't break columns).
    for ch in select_expr:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            columns.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip():
        columns.append(current.strip())

    resolved = []
    for part in columns:
        alias_match = re.search(r"\bAS\s+(\w+)\s*$", part, re.IGNORECASE)
        resolved.append(alias_match.group(1) if alias_match else part)
    return resolved


@router.post("/cypher")
def execute_cypher(body: CypherRequest, request: Request) -> dict:
    """Execute a read-only SQL query and return structured results."""
    storage = request.app.state.storage

    if not is_read_only_sql(body.query):
        raise HTTPException(
            status_code=400,
            detail=(
                "Only read-only SQL is allowed. The query must be a single "
                "SELECT/WITH statement; writes and DDL (INSERT, UPDATE, DELETE, "
                "DROP, CREATE, ALTER, PRAGMA, ...) are not permitted."
            ),
        )

    columns = _extract_return_columns(body.query)

    start = time.perf_counter()
    try:
        rows = storage.execute_raw(body.query)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Query failed: {exc}") from exc
    duration_ms = round((time.perf_counter() - start) * 1000, 2)

    if rows is None:
        rows = []

    serialized_rows = [[_serialize_value(v) for v in row] for row in rows]

    return {
        "columns": columns,
        "rows": serialized_rows,
        "rowCount": len(serialized_rows),
        "durationMs": duration_ms,
    }


def _serialize_value(value: object) -> object:
    """Convert non-JSON-serializable values to strings."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_serialize_value(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _serialize_value(v) for k, v in value.items()}
    return str(value)
