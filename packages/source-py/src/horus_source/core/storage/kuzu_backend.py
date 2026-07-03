"""KuzuDB storage backend for Horus.

Implements the :class:`StorageBackend` protocol using KuzuDB, an embedded
graph database that speaks Cypher. Each :class:`NodeLabel` maps to a
separate node table, and a single ``CodeRelation`` relationship table group
covers all source-to-target combinations.
"""

from __future__ import annotations

import csv
import hashlib
import json
import logging
import os
import re
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

import kuzu

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import GraphNode, GraphRelationship, NodeLabel, RelType
from horus_source.core.storage.base import NodeEmbedding, SearchResult

logger = logging.getLogger(__name__)

# KùzuDB defaults its buffer pool to ~80% of system RAM. On a cold index build
# (running alongside the embedding model) that can overcommit and get the process
# OOM-killed (SIGKILL / exit 137). Cap it to a sane, overridable bound.
_DEFAULT_KUZU_BUFFER_POOL_MB = 2048


def _kuzu_buffer_pool_bytes() -> int:
    """Bounded KùzuDB buffer-pool size in bytes.

    Override with HORUS_SOURCE_KUZU_BUFFER_POOL_MB (megabytes). Defaults to 2 GiB,
    which is ample for indexing while leaving headroom for the embedding model.
    """
    raw = os.environ.get("HORUS_SOURCE_KUZU_BUFFER_POOL_MB")
    try:
        mb = int(raw) if raw else _DEFAULT_KUZU_BUFFER_POOL_MB
    except ValueError:
        mb = _DEFAULT_KUZU_BUFFER_POOL_MB
    return max(mb, 128) * 1024 * 1024


# Substrings KùzuDB emits when a database file is structurally unusable (truncated,
# overwritten, version-incompatible, or otherwise corrupt). Matched case-insensitively.
# A corrupt DB must be detected on open and recreated rather than crashing the host
# (which otherwise loops on the contended port). See HOR-409.
_CORRUPT_DB_SIGNATURES: tuple[str, ...] = (
    "not a valid kuzu database file",
    "is not a valid kuzu database",
    "unable to open database",
    "corrupt",
    "checksum",
    "malformed",
)


def _is_corrupt_db_error(message: str) -> bool:
    """Return True when *message* looks like a structural corruption (not lock contention)."""
    lowered = message.lower()
    if "lock" in lowered:
        return False
    return any(sig in lowered for sig in _CORRUPT_DB_SIGNATURES)


def _destroy_db_files(path: Path) -> None:
    """Delete a KùzuDB database at *path* plus its sidecar files (.wal / .tmp / .shadow).

    KùzuDB 0.11 stores the database as a single file with sibling write-ahead and
    temp files; older/other layouts use a directory. Remove whichever exists so a
    fresh database can be created in its place.
    """
    import shutil

    targets = [
        path,
        path.with_name(path.name + ".wal"),
        path.with_name(path.name + ".tmp"),
        path.with_name(path.name + ".shadow"),
        Path(str(path) + ".lock"),
    ]
    for target in targets:
        try:
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            elif target.exists():
                target.unlink()
        except OSError:
            logger.debug("Failed to remove corrupt-db artifact %s", target, exc_info=True)


_NODE_TABLE_NAMES: list[str] = [label.name.title().replace("_", "") for label in NodeLabel]

_LABEL_TO_TABLE: dict[str, str] = {
    label.value: label.name.title().replace("_", "") for label in NodeLabel
}

_LABEL_MAP: dict[str, NodeLabel] = {label.value: label for label in NodeLabel}

_REL_TYPE_MAP: dict[str, RelType] = {rt.value: rt for rt in RelType}

_SEARCHABLE_TABLES: list[str] = [
    t for t in _NODE_TABLE_NAMES
    if t not in ("Folder", "Community", "Process")
]

_NODE_PROPERTIES = (
    "id STRING, "
    "name STRING, "
    "file_path STRING, "
    "start_line INT64, "
    "end_line INT64, "
    "content STRING, "
    "signature STRING, "
    "language STRING, "
    "class_name STRING, "
    "is_dead BOOL, "
    "is_entry_point BOOL, "
    "is_exported BOOL, "
    "cohesion DOUBLE, "
    "properties_json STRING, "
    "PRIMARY KEY (id)"
)

_DEDICATED_PROPS = frozenset({"cohesion"})

_REL_PROPERTIES = (
    "rel_type STRING, "
    "confidence DOUBLE, "
    "role STRING, "
    "step_number INT64, "
    "strength DOUBLE, "
    "co_changes INT64, "
    "symbols STRING"
)

def _serialize_extra_props(props: dict[str, Any] | None) -> str:
    if not props:
        return ""
    extra = {k: v for k, v in props.items() if k not in _DEDICATED_PROPS}
    return json.dumps(extra) if extra else ""


def _decorator_args_from_json(props_json: str) -> list[str]:
    """Pull the ``decorator_args`` list out of a node's serialized ``properties_json``.

    Returns ``[]`` for empty/malformed JSON or when the key is absent, so callers can
    safely confirm exact decorator-argument membership without trusting a raw substring
    match against the JSON blob.
    """
    if not props_json:
        return []
    try:
        data = json.loads(props_json)
    except (ValueError, TypeError):
        return []
    args = data.get("decorator_args") if isinstance(data, dict) else None
    if not isinstance(args, list):
        return []
    return [a for a in args if isinstance(a, str)]


def escape_cypher(value: str) -> str:
    """Escape a string for safe inclusion in a Cypher literal."""
    value = value.replace("\x00", "")
    value = value.replace("/*", "")
    value = value.replace("*/", "")
    value = value.replace("//", "")
    value = value.replace(";", "")
    value = value.replace("\\", "\\\\")
    value = value.replace("'", "\\'")
    return value


# A code-shaped identifier: an UPPER token (>=4 chars) of [A-Z0-9_] containing a digit or
# underscore — error codes / log keys like E_FOO_BAR or ERR4624 — but NOT plain words such as
# URL/API/JSON. Deliberately format-agnostic (no assumption about how codes are declared).
_CODE_TOKEN_RE = re.compile(r"\b(?=[A-Z0-9_]*[0-9_])[A-Z][A-Z0-9_]{3,}\b")


def _colocated_code_tokens(content: str, token: str, window: int = 200) -> list[str]:
    """Code-shaped identifiers near ``token`` in ``content``, nearest first (format-agnostic).

    Many codebases define a display code next to a logical key — ``E_KEY: { code: 'ERR4624' }``,
    ``E_KEY: 'ERR4624'``, or ``{ code: 'ERR4624', key: 'E_KEY' }``. Rather than assume any one
    layout (and lock consumers into a logging convention), return the code-shaped tokens within
    a small window of the display code, nearest first, so the caller can try resolving each to a
    raise site. No co-located token → empty list (the caller falls back to the direct match).
    """
    idx = content.find(token)
    if idx < 0:
        return []
    start = max(0, idx - window)
    end = min(len(content), idx + len(token) + window)
    tok_pos = idx - start
    out: list[tuple[int, str]] = []
    seen: set[str] = set()
    for m in _CODE_TOKEN_RE.finditer(content[start:end]):
        ident = m.group(0)
        if ident == token or ident in seen:
            continue
        seen.add(ident)
        out.append((abs(m.start() - tok_pos), ident))
    out.sort(key=lambda t: t[0])
    return [ident for _, ident in out]


def _table_for_id(node_id: str) -> str | None:
    """Extract the table name from a node ID by mapping its label prefix."""
    prefix = node_id.split(":", 1)[0]
    return _LABEL_TO_TABLE.get(prefix)

_EMBEDDING_PROPERTIES = "node_id STRING, vec FLOAT[384], PRIMARY KEY(node_id)"

class KuzuBackend:
    """StorageBackend implementation backed by KuzuDB.

    Usage::

        backend = KuzuBackend()
        backend.initialize(Path("/tmp/horus_db"))
        backend.bulk_load(graph)
        node = backend.get_node("function:src/app.py:main")
        backend.close()
    """

    def __init__(self) -> None:
        self._db: kuzu.Database | None = None
        self._conn: kuzu.Connection | None = None
        self._lock = threading.Lock()
        self._embeddings_clean: bool = False
        # Set when initialize(recover_corrupt=True) had to delete a corrupt database
        # and recreate an empty one. Callers use this to trigger a full re-index, since
        # the recovered database contains no graph data.
        self.recreated_due_to_corruption: bool = False

    def _require_conn(self) -> kuzu.Connection:
        if self._conn is None:
            raise RuntimeError("KuzuBackend.initialize() must be called before use")
        return self._conn

    def initialize(
        self,
        path: Path,
        *,
        read_only: bool = False,
        max_retries: int = 0,
        retry_delay: float = 0.3,
        recover_corrupt: bool = False,
    ) -> None:
        """Open or create the KuzuDB database at *path*.

        In read-only mode, schema creation is skipped (database must already exist).
        Retries on lock contention errors with exponential backoff.

        When *recover_corrupt* is set (RW only), a database that fails to open because
        it is structurally corrupt is deleted and recreated empty instead of raising —
        the host stays up rather than crashing into the contended-port loop (HOR-409).
        ``recreated_due_to_corruption`` is then set so callers can trigger a re-index.
        """
        for attempt in range(max_retries + 1):
            try:
                self._db = kuzu.Database(
                    str(path),
                    read_only=read_only,
                    buffer_pool_size=_kuzu_buffer_pool_bytes(),
                )
                self._conn = kuzu.Connection(self._db)
                if not read_only:
                    self._create_schema()
                return
            except RuntimeError as e:
                if "lock" in str(e).lower() and attempt < max_retries:
                    logger.debug(
                        "Lock contention on attempt %d/%d, retrying in %.1fs",
                        attempt + 1, max_retries, retry_delay * (2 ** attempt),
                    )
                    self.close()
                    time.sleep(retry_delay * (2 ** attempt))
                    continue
                if recover_corrupt and not read_only and _is_corrupt_db_error(str(e)):
                    logger.warning(
                        "KùzuDB at %s is corrupt (%s) — deleting and recreating an empty "
                        "database so the host can recover (HOR-409). The graph will be re-indexed.",
                        path, e,
                    )
                    self.close()
                    _destroy_db_files(Path(path))
                    self._db = kuzu.Database(
                        str(path),
                        read_only=False,
                        buffer_pool_size=_kuzu_buffer_pool_bytes(),
                    )
                    self._conn = kuzu.Connection(self._db)
                    self._create_schema()
                    self.recreated_due_to_corruption = True
                    return
                raise

    def close(self) -> None:
        """Release the connection and database handles, freeing KuzuDB file locks."""
        if self._conn is not None:
            try:
                del self._conn
            except Exception:
                pass
            self._conn = None
        if self._db is not None:
            try:
                del self._db
            except Exception:
                pass
            self._db = None

    def add_nodes(self, nodes: list[GraphNode]) -> None:
        for node in nodes:
            self._insert_node(node)

    def add_relationships(self, rels: list[GraphRelationship]) -> None:
        for rel in rels:
            self._insert_relationship(rel)

    def remove_nodes_by_file(self, file_path: str) -> int:
        """Delete all nodes with the given file_path across every table. Returns count removed."""
        conn = self._require_conn()
        total = 0
        for table in _NODE_TABLE_NAMES:
            try:
                count_result = conn.execute(
                    f"MATCH (n:{table}) WHERE n.file_path = $fp RETURN count(n)",
                    parameters={"fp": file_path},
                )
                if count_result.has_next():
                    total += int(count_result.get_next()[0] or 0)
                conn.execute(
                    f"MATCH (n:{table}) WHERE n.file_path = $fp DETACH DELETE n",
                    parameters={"fp": file_path},
                )
            except Exception:
                logger.debug("Failed to remove nodes from table %s", table, exc_info=True)
        return total

    def get_inbound_cross_file_edges(
        self, file_path: str, exclude_source_files: set[str] | None = None,
    ) -> list[GraphRelationship]:
        """Return inbound edges where target is in *file_path* and source is not.

        Edges whose source file is in *exclude_source_files* are skipped.
        """
        conn = self._require_conn()
        exclude = exclude_source_files or set()
        edges: list[GraphRelationship] = []
        try:
            with self._lock:
                result = conn.execute(
                    "MATCH (caller)-[r:CodeRelation]->(n) "
                    "WHERE n.file_path = $fp AND caller.file_path <> $fp "
                    "RETURN caller.id, caller.file_path, n.id, "
                    "r.rel_type, r.confidence, r.role, "
                    "r.step_number, r.strength, r.co_changes, r.symbols",
                    parameters={"fp": file_path},
                )
            while result.has_next():
                row = result.get_next()
                src_file: str = row[1] or ""
                if src_file in exclude:
                    continue
                src_id: str = row[0] or ""
                tgt_id: str = row[2] or ""
                rel_type_str: str = row[3] or ""
                rel_type = _REL_TYPE_MAP.get(rel_type_str)
                if rel_type is None:
                    continue
                props: dict[str, Any] = {}
                if row[4] is not None:
                    props["confidence"] = float(row[4])
                if row[5] is not None and row[5] != "":
                    props["role"] = str(row[5])
                if row[6] is not None and row[6] != 0:
                    props["step_number"] = int(row[6])
                if row[7] is not None and row[7] != 0.0:
                    props["strength"] = float(row[7])
                if row[8] is not None and row[8] != 0:
                    props["co_changes"] = int(row[8])
                if row[9] is not None and row[9] != "":
                    props["symbols"] = str(row[9])
                rel_id = f"{rel_type_str}:{src_id}->{tgt_id}"
                edges.append(GraphRelationship(
                    id=rel_id, type=rel_type,
                    source=src_id, target=tgt_id,
                    properties=props,
                ))
        except Exception:
            logger.warning(
                "Failed to query inbound cross-file edges for %s",
                file_path, exc_info=True,
            )
        return edges

    def get_node(self, node_id: str) -> GraphNode | None:
        """Return a single node by ID, or ``None`` if not found."""
        conn = self._require_conn()
        table = _table_for_id(node_id)
        if table is None:
            return None

        query = f"MATCH (n:{table}) WHERE n.id = $nid RETURN n.*"
        try:
            with self._lock:
                result = conn.execute(query, parameters={"nid": node_id})
            if result.has_next():
                row = result.get_next()
                return self._row_to_node(row, node_id)
        except Exception:
            logger.warning("get_node failed for %s", node_id, exc_info=True)
        return None

    def get_callers(self, node_id: str) -> list[GraphNode]:
        """Return nodes that CALL the node identified by *node_id*."""
        self._require_conn()
        table = _table_for_id(node_id)
        if table is None:
            return []

        query = (
            f"MATCH (caller)-[r:CodeRelation]->(callee:{table}) "
            f"WHERE callee.id = $nid AND r.rel_type = 'calls' "
            f"RETURN caller.*"
        )
        return self._query_nodes(query, parameters={"nid": node_id})

    def get_callees(self, node_id: str) -> list[GraphNode]:
        """Return nodes called by the node identified by *node_id*."""
        self._require_conn()
        table = _table_for_id(node_id)
        if table is None:
            return []

        query = (
            f"MATCH (caller:{table})-[r:CodeRelation]->(callee) "
            f"WHERE caller.id = $nid AND r.rel_type = 'calls' "
            f"RETURN callee.*"
        )
        return self._query_nodes(query, parameters={"nid": node_id})

    def get_type_refs(self, node_id: str) -> list[GraphNode]:
        """Return nodes referenced via USES_TYPE from *node_id*."""
        self._require_conn()
        table = _table_for_id(node_id)
        if table is None:
            return []

        query = (
            f"MATCH (src:{table})-[r:CodeRelation]->(tgt) "
            f"WHERE src.id = $nid AND r.rel_type = 'uses_type' "
            f"RETURN tgt.*"
        )
        return self._query_nodes(query, parameters={"nid": node_id})

    def get_callers_with_confidence(self, node_id: str) -> list[tuple[GraphNode, float]]:
        """Return ``(node, confidence)`` for all callers of *node_id*."""
        self._require_conn()
        table = _table_for_id(node_id)
        if table is None:
            return []
        query = (
            f"MATCH (caller)-[r:CodeRelation]->(callee:{table}) "
            f"WHERE callee.id = $nid AND r.rel_type = 'calls' "
            f"RETURN caller.*, r.confidence"
        )
        return self._query_nodes_with_confidence(query, parameters={"nid": node_id})

    def get_callees_with_confidence(self, node_id: str) -> list[tuple[GraphNode, float]]:
        """Return ``(node, confidence)`` for all callees of *node_id*."""
        self._require_conn()
        table = _table_for_id(node_id)
        if table is None:
            return []
        query = (
            f"MATCH (caller:{table})-[r:CodeRelation]->(callee) "
            f"WHERE caller.id = $nid AND r.rel_type = 'calls' "
            f"RETURN callee.*, r.confidence"
        )
        return self._query_nodes_with_confidence(query, parameters={"nid": node_id})

    _MAX_BFS_DEPTH = 10

    def traverse(self, start_id: str, depth: int, direction: str = "callers") -> list[GraphNode]:
        """BFS traversal through CALLS edges — flat result list (no depth info)."""
        return [node for node, _ in self.traverse_with_depth(start_id, depth, direction)]

    def traverse_with_depth(
        self, start_id: str, depth: int, direction: str = "callers"
    ) -> list[tuple[GraphNode, int]]:
        """BFS traversal returning ``(node, hop_depth)`` pairs.

        ``hop_depth`` is 1-based: direct callers/callees are depth 1.

        Args:
            direction: ``"callers"`` follows incoming CALLS (blast radius),
                       ``"callees"`` follows outgoing CALLS (dependencies).
        """
        self._require_conn()
        depth = min(depth, self._MAX_BFS_DEPTH)
        if _table_for_id(start_id) is None:
            return []

        visited: set[str] = set()
        result_list: list[tuple[GraphNode, int]] = []
        queue: deque[tuple[str, int]] = deque([(start_id, 0)])

        while queue:
            current_id, current_depth = queue.popleft()
            if current_id in visited:
                continue
            visited.add(current_id)

            if current_id != start_id:
                node = self.get_node(current_id)
                if node is not None:
                    result_list.append((node, current_depth))

            if current_depth < depth:
                neighbors = (
                    self.get_callers(current_id)
                    if direction == "callers"
                    else self.get_callees(current_id)
                )
                for neighbor in neighbors:
                    if neighbor.id not in visited:
                        queue.append((neighbor.id, current_depth + 1))

        return result_list

    def get_process_memberships(self, node_ids: list[str]) -> dict[str, str]:
        """Return ``{node_id: process_name}`` for nodes in any Process.

        Uses parameterized IN clause to safely query all node IDs at once.
        """
        conn = self._require_conn()
        if not node_ids:
            return {}

        mapping: dict[str, str] = {}
        try:
            with self._lock:
                result = conn.execute(
                    "MATCH (n)-[r:CodeRelation]->(p:Process) "
                    "WHERE n.id IN $ids AND r.rel_type = 'step_in_process' "
                    "RETURN n.id, p.name",
                    parameters={"ids": node_ids},
                )
            while result.has_next():
                row = result.get_next()
                nid, pname = row[0], row[1]
                if nid and pname and nid not in mapping:
                    mapping[nid] = pname
        except Exception:
            logger.warning("get_process_memberships failed", exc_info=True)
        return mapping

    def execute_raw(self, query: str) -> list[list[Any]]:
        """Execute a raw Cypher query and return all result rows."""
        conn = self._require_conn()
        with self._lock:
            result = conn.execute(query)
        rows: list[list[Any]] = []
        while result.has_next():
            rows.append(result.get_next())
        return rows

    # ------------------------------------------------------------------ analytics
    # Typed analytics queries (HOR-392 stage 2). These move the raw analytic Cypher
    # out of the web routes / MCP tools and behind the StorageBackend seam. Several
    # also fix a latent bug in the old call-site Cypher, which matched relationships
    # by a non-existent label (``-[:MEMBER_OF]-``, ``-[:COUPLED_WITH]-``) instead of
    # the actual ``CodeRelation`` table group discriminated by a ``rel_type``
    # property — so those paths silently returned nothing on KùzuDB.

    def _exec_rows(self, query: str, params: dict[str, Any] | None = None) -> list[list[Any]]:
        conn = self._require_conn()
        rows: list[list[Any]] = []
        try:
            with self._lock:
                result = conn.execute(query, parameters=params or {})
            while result.has_next():
                rows.append(result.get_next())
        except Exception:
            logger.warning("analytics query failed: %s", query, exc_info=True)
        return rows

    def count_nodes_by_label(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for label in NodeLabel:
            table = _LABEL_TO_TABLE[label.value]
            rows = self._exec_rows(f"MATCH (n:{table}) RETURN count(n)")
            c = int(rows[0][0] or 0) if rows else 0
            if c:
                counts[label.value] = c
        return dict(sorted(counts.items(), key=lambda kv: kv[1], reverse=True))

    def count_edges_by_type(self) -> dict[str, int]:
        rows = self._exec_rows(
            "MATCH ()-[r:CodeRelation]->() RETURN r.rel_type, count(r) ORDER BY count(r) DESC"
        )
        return {(r[0] or "unknown"): int(r[1] or 0) for r in rows}

    def get_dead_code_symbols(self) -> list[tuple[str, str, str, int, str]]:
        rows = self._exec_rows(
            "MATCH (n) WHERE n.is_dead = true "
            "RETURN n.id, n.name, n.file_path, n.start_line ORDER BY n.file_path"
        )
        out: list[tuple[str, str, str, int, str]] = []
        for r in rows:
            nid = r[0] or ""
            label = nid.split(":", 1)[0]
            out.append((nid, r[1] or "", r[2] or "", int(r[3] or 0), label))
        return out

    def get_coupling_pairs(self) -> list[tuple[str, str, str, str, float, int]]:
        rows = self._exec_rows(
            "MATCH (a)-[r:CodeRelation]->(b) WHERE r.rel_type = 'coupled_with' "
            "RETURN a.name, a.file_path, b.name, b.file_path, r.strength, r.co_changes"
        )
        return [
            (r[0] or "", r[1] or "", r[2] or "", r[3] or "",
             float(r[4] or 0.0), int(r[5] or 0))
            for r in rows
        ]

    def get_coupling_strengths(self) -> list[float]:
        rows = self._exec_rows(
            "MATCH ()-[r:CodeRelation]->() WHERE r.rel_type = 'coupled_with' RETURN r.strength"
        )
        return [float(r[0] or 0.0) for r in rows]

    def get_communities_with_members(
        self,
    ) -> list[tuple[str, str, float | None, list[str]]]:
        rows = self._exec_rows(
            "MATCH (c:Community) "
            "OPTIONAL MATCH (n)-[r:CodeRelation]->(c) WHERE r.rel_type = 'member_of' "
            "RETURN c.id, c.name, c.cohesion, collect(n.id)"
        )
        out: list[tuple[str, str, float | None, list[str]]] = []
        for r in rows:
            members = [m for m in (r[3] or []) if m]
            cohesion = float(r[2]) if r[2] is not None else None
            out.append((r[0] or "", r[1] or "", cohesion, members))
        return out

    def count_communities(self) -> int:
        rows = self._exec_rows("MATCH (c:Community) RETURN count(c)")
        return int(rows[0][0] or 0) if rows else 0

    def avg_calls_confidence(self) -> float | None:
        rows = self._exec_rows(
            "MATCH ()-[r:CodeRelation]->() WHERE r.rel_type = 'calls' RETURN avg(r.confidence)"
        )
        if rows and rows[0][0] is not None:
            return float(rows[0][0])
        return None

    def count_symbols_and_dead(self) -> tuple[int, int]:
        total = 0
        dead = 0
        for table in ("Function", "Method", "Class"):
            rows = self._exec_rows(
                f"MATCH (n:{table}) WHERE n.start_line > 0 "
                f"RETURN count(n), sum(CASE WHEN n.is_dead = true THEN 1 ELSE 0 END)"
            )
            if rows:
                total += int(rows[0][0] or 0)
                dead += int(rows[0][1] or 0)
        return total, dead

    def count_embeddings(self) -> int:
        try:
            rows = self._exec_rows("MATCH (e:Embedding) RETURN count(e)")
        except Exception:
            logger.debug("count_embeddings failed", exc_info=True)
            return 0
        return int(rows[0][0] or 0) if rows else 0

    def count_callables_in_processes(self) -> tuple[int, int]:
        total = 0
        in_proc = 0
        for table in ("Function", "Method"):
            rows = self._exec_rows(
                f"MATCH (n:{table}) "
                f"OPTIONAL MATCH (n)-[r:CodeRelation]->() WHERE r.rel_type = 'step_in_process' "
                f"RETURN count(n), count(DISTINCT CASE WHEN r IS NOT NULL THEN n.id END)"
            )
            if rows:
                total += int(rows[0][0] or 0)
                in_proc += int(rows[0][1] or 0)
        return total, in_proc

    def get_file_nodes(self) -> list[tuple[str, str, str, str]]:
        rows = self._exec_rows(
            "MATCH (n:File) RETURN n.id, n.name, n.file_path, n.language"
        )
        return [(r[0] or "", r[1] or "", r[2] or "", r[3] or "") for r in rows]

    def get_symbol_counts_by_file(self) -> dict[str, int]:
        rows = self._exec_rows(
            "MATCH (n) WHERE n.file_path <> '' AND n.start_line > 0 "
            "RETURN n.file_path, count(n)"
        )
        return {r[0]: int(r[1] or 0) for r in rows if r[0]}

    def get_processes_with_steps(
        self,
    ) -> list[tuple[str, str, list[str], list[int | None]]]:
        rows = self._exec_rows(
            "MATCH (p:Process) "
            "OPTIONAL MATCH (n)-[r:CodeRelation]->(p) WHERE r.rel_type = 'step_in_process' "
            "RETURN p.id, p.name, collect(n.id), collect(r.step_number) ORDER BY p.name"
        )
        out: list[tuple[str, str, list[str], list[int | None]]] = []
        for r in rows:
            node_ids = [n for n in (r[2] or []) if n]
            step_numbers = [
                (int(s) if s is not None else None) for s in (r[3] or [])
            ][: len(node_ids)]
            out.append((r[0] or "", r[1] or "", node_ids, step_numbers))
        return out

    def get_symbols_in_file(self, file_path: str) -> list[GraphNode]:
        nodes: list[GraphNode] = []
        for table in _NODE_TABLE_NAMES:
            nodes.extend(
                self._query_nodes(
                    f"MATCH (n:{table}) WHERE n.file_path = $fp AND n.start_line > 0 "
                    f"RETURN n.*",
                    parameters={"fp": file_path},
                )
            )
        nodes.sort(key=lambda n: n.start_line)
        return nodes

    def get_file_imports(self, file_path: str) -> list[str]:
        rows = self._exec_rows(
            "MATCH (a:File)-[r:CodeRelation]->(b:File) "
            "WHERE a.file_path = $fp AND r.rel_type = 'imports' "
            "RETURN b.file_path ORDER BY b.file_path",
            {"fp": file_path},
        )
        return [r[0] for r in rows if r[0]]

    def get_file_importers(self, file_path: str) -> list[str]:
        rows = self._exec_rows(
            "MATCH (a:File)-[r:CodeRelation]->(b:File) "
            "WHERE b.file_path = $fp AND r.rel_type = 'imports' "
            "RETURN a.file_path ORDER BY a.file_path",
            {"fp": file_path},
        )
        return [r[0] for r in rows if r[0]]

    def get_file_coupling(self, file_path: str) -> list[tuple[str, float, int]]:
        rows = self._exec_rows(
            "MATCH (a:File)-[r:CodeRelation]-(b:File) "
            "WHERE a.file_path = $fp AND r.rel_type = 'coupled_with' "
            "RETURN b.file_path, r.strength, r.co_changes ORDER BY r.strength DESC",
            {"fp": file_path},
        )
        return [(r[0] or "", float(r[1] or 0.0), int(r[2] or 0)) for r in rows]

    def get_heritage(self, node_id: str) -> list[tuple[str, str, str]]:
        rows = self._exec_rows(
            "MATCH (n)-[r:CodeRelation]->(parent) "
            "WHERE n.id = $id AND r.rel_type IN ['extends', 'implements'] "
            "RETURN parent.name, parent.file_path, r.rel_type",
            {"id": node_id},
        )
        return [(r[0] or "", r[1] or "", r[2] or "") for r in rows]

    def get_node_communities(self, node_id: str) -> list[str]:
        rows = self._exec_rows(
            "MATCH (n)-[r:CodeRelation]->(c:Community) "
            "WHERE n.id = $id AND r.rel_type = 'member_of' RETURN c.name",
            {"id": node_id},
        )
        return [r[0] for r in rows if r[0]]

    def get_node_processes(self, node_id: str) -> list[str]:
        rows = self._exec_rows(
            "MATCH (n)-[r:CodeRelation]->(p:Process) "
            "WHERE n.id = $id AND r.rel_type = 'step_in_process' RETURN p.name",
            {"id": node_id},
        )
        return [r[0] for r in rows if r[0]]

    def get_community_members(
        self, name: str
    ) -> list[tuple[str, str, str, int, bool, bool]]:
        rows = self._exec_rows(
            "MATCH (n)-[r:CodeRelation]->(c:Community) "
            "WHERE c.name = $name AND r.rel_type = 'member_of' "
            "RETURN n.name, n.id, n.file_path, n.start_line, "
            "n.is_entry_point, n.is_exported ORDER BY n.file_path, n.start_line",
            {"name": name},
        )
        out: list[tuple[str, str, str, int, bool, bool]] = []
        for r in rows:
            label = (r[1] or "").split(":", 1)[0]
            out.append(
                (r[0] or "", label, r[2] or "", int(r[3] or 0), bool(r[4]), bool(r[5]))
            )
        # Deterministic order independent of the backend's ORDER BY (cross-backend
        # parity: kuzu does not reliably honor ORDER BY on this traversal).
        out.sort(key=lambda t: (t[2], t[3], t[0]))
        return out

    def get_communities_summary(self) -> list[tuple[str, float, str]]:
        rows = self._exec_rows(
            "MATCH (c:Community) RETURN c.name, c.cohesion, c.properties_json "
            "ORDER BY c.cohesion DESC"
        )
        return [
            (r[0] or "", float(r[1]) if r[1] is not None else 0.0, r[2] or "")
            for r in rows
        ]

    def get_cross_community_processes(self) -> list[tuple[str, list[str]]]:
        rows = self._exec_rows(
            "MATCH (n)-[r1:CodeRelation]->(p:Process), (n)-[r2:CodeRelation]->(c:Community) "
            "WHERE r1.rel_type = 'step_in_process' AND r2.rel_type = 'member_of' "
            "WITH p.name AS proc, collect(DISTINCT c.name) AS comms "
            "WHERE size(comms) > 1 RETURN proc, comms"
        )
        return [(r[0] or "", sorted(c for c in (r[1] or []) if c)) for r in rows]

    def get_file_community_counts(self, file_path: str) -> list[tuple[str, int]]:
        rows = self._exec_rows(
            "MATCH (n)-[r:CodeRelation]->(c:Community) "
            "WHERE n.file_path = $fp AND r.rel_type = 'member_of' "
            "RETURN c.name, count(n) ORDER BY count(n) DESC",
            {"fp": file_path},
        )
        return [(r[0] or "", int(r[1] or 0)) for r in rows]

    # ------------------------------------------------------------------ CLI read path
    # Typed, backend-agnostic endpoints backing the CLI read path (HOR-392 Option A).
    # Each mirrors the SqliteBackend implementation so results are identical behind the
    # StorageBackend seam.

    def content_contains_any(self, tokens: list[str], limit: int) -> list[dict[str, Any]]:
        """Nodes whose ``content`` contains ANY of *tokens* (case-insensitive substring).

        Returns up to *limit* dicts with the full ``id``/``name``/``file_path``/``content``,
        ordered by ``id``. Folder/community/process tables are excluded. Each searchable
        table is bounded by ``LIMIT limit`` on its own smallest ``id`` rows; merging those
        sorted slices and taking the first *limit* yields exactly the global smallest-``id``
        matches, so the result matches SQLite's single-table ``ORDER BY id LIMIT``.
        """
        limit = int(limit)
        toks = [t for t in tokens if t]
        if not toks:
            return []
        conds = " OR ".join(
            f"lower(node.content) CONTAINS lower('{escape_cypher(t)}')" for t in toks
        )
        out: dict[str, dict[str, Any]] = {}
        for table in _SEARCHABLE_TABLES:
            cypher = (
                f"MATCH (node:{table}) WHERE {conds} "
                f"RETURN node.id, node.name, node.file_path, node.content "
                f"ORDER BY node.id LIMIT {limit}"
            )
            for row in self._exec_rows(cypher):
                nid = row[0] or ""
                if nid and nid not in out:
                    out[nid] = {
                        "id": nid,
                        "name": row[1] or "",
                        "file_path": row[2] or "",
                        "content": row[3] or "",
                    }
        results = sorted(out.values(), key=lambda d: d["id"])
        return results[:limit]

    def flows_for_symbol(self, node_id: str) -> dict[str, list[dict[str, Any]]]:
        """Process flows *node_id* is a step in, with each flow's ordered, named steps."""
        proc_rows = self._exec_rows(
            "MATCH (n)-[r:CodeRelation]->(p:Process) "
            "WHERE n.id = $id AND r.rel_type = 'step_in_process' "
            "RETURN p.id, p.name ORDER BY p.name, p.id",
            {"id": node_id},
        )
        processes = [{"id": r[0] or "", "name": r[1] or ""} for r in proc_rows]
        steps: list[dict[str, Any]] = []
        if proc_rows:
            proc_ids = [r[0] for r in proc_rows]
            step_rows = self._exec_rows(
                "MATCH (s)-[r:CodeRelation]->(p:Process) "
                "WHERE p.id IN $pids AND r.rel_type = 'step_in_process' "
                "RETURN s.id, s.name, s.file_path, s.start_line, r.step_number "
                "ORDER BY r.step_number, s.id",
                {"pids": proc_ids},
            )
            seen: set[str] = set()
            for r in step_rows:
                sid = r[0] or ""
                if sid in seen:
                    continue
                seen.add(sid)
                steps.append(
                    {
                        "id": sid,
                        "name": r[1] or "",
                        "file_path": r[2] or "",
                        "start_line": int(r[3] or 0),
                        "step_number": int(r[4]) if r[4] is not None else None,
                    }
                )
        return {"processes": processes, "steps": steps}

    def symbols_by_label(self, labels: list[str], limit: int) -> list[dict[str, Any]]:
        """Symbol nodes for the given lowercase *labels*, ordered by (file, line, id)."""
        limit = int(limit)
        labs = [lab for lab in labels if lab]
        if not labs:
            return []
        out: list[dict[str, Any]] = []
        for lab in labs:
            table = _LABEL_TO_TABLE.get(lab)
            if not table:
                continue
            rows = self._exec_rows(
                f"MATCH (n:{table}) "
                f"RETURN n.id, n.name, n.file_path, n.start_line, n.end_line, "
                f"n.class_name, n.is_entry_point, n.is_exported, n.signature "
                f"ORDER BY n.file_path, n.start_line, n.id LIMIT {limit}"
            )
            for r in rows:
                out.append(
                    {
                        "id": r[0] or "",
                        "label": lab,
                        "name": r[1] or "",
                        "file_path": r[2] or "",
                        "start_line": int(r[3] or 0),
                        "end_line": int(r[4] or 0),
                        "class_name": r[5] or "",
                        "is_entry_point": bool(r[6]),
                        "is_exported": bool(r[7]),
                        "signature": r[8] or "",
                    }
                )
        out.sort(key=lambda d: (d["file_path"], d["start_line"], d["id"]))
        return out[:limit]

    def fts_search(self, query: str, limit: int) -> list[SearchResult]:
        """BM25 full-text search using KuzuDB's native FTS extension.

        Searches across all node tables using pre-built FTS indexes on
        ``name``, ``content``, and ``signature`` fields.  Results are
        ranked by BM25 relevance score.

        Returns the top *limit* results sorted by score descending.
        """
        conn = self._require_conn()
        limit = int(limit)
        escaped_q = escape_cypher(query)
        candidates: list[SearchResult] = []

        # NOTE: QUERY_FTS_INDEX is a KuzuDB stored procedure that does not support
        # parameterized $variables. String interpolation with escape_cypher() is the
        # only option here. escape_cypher strips comments, semicolons, and escapes quotes.
        for table in _SEARCHABLE_TABLES:
            idx_name = f"{table.lower()}_fts"
            cypher = (
                f"CALL QUERY_FTS_INDEX('{table}', '{idx_name}', '{escaped_q}') "
                f"RETURN node.id, node.name, node.file_path, node.content, "
                f"node.signature, score "
                f"ORDER BY score DESC LIMIT {limit}"
            )
            try:
                with self._lock:
                    result = conn.execute(cypher)
                while result.has_next():
                    row = result.get_next()
                    node_id = row[0] or ""
                    name = row[1] or ""
                    file_path = row[2] or ""
                    content = row[3] or ""
                    signature = row[4] or ""
                    bm25_score = float(row[5]) if row[5] is not None else 0.0

                    if "/tests/" in file_path or "/test_" in file_path:
                        bm25_score *= 0.5

                    label_prefix = node_id.split(":", 1)[0] if node_id else ""

                    if label_prefix in ("function", "class") and "/tests/" not in file_path:
                        bm25_score *= 1.2

                    snippet = content[:200] if content else signature[:200]

                    candidates.append(
                        SearchResult(
                            node_id=node_id,
                            score=bm25_score,
                            node_name=name,
                            file_path=file_path,
                            label=label_prefix,
                            snippet=snippet,
                        )
                    )
            except Exception:
                logger.debug("fts_search failed on table %s", table, exc_info=True)

        candidates.sort(key=lambda r: (-r.score, r.node_id))
        return candidates[:limit]

    def exact_content_search(self, token: str, limit: int) -> list[SearchResult]:
        """Nodes whose raw content contains ``token`` verbatim (HOR-329).

        An error code like ``E_FULFILLMENT_SYNC_ERROR_04`` shreds into generic FTS tokens
        (fulfillment/sync/error), so neither full-text nor vector search can pick out its
        raise site — but the intact code IS present verbatim in the raising function's
        content. This does an exact substring match and returns the most specific executable
        matches first (a focused function before the constant's large declaration file).
        """
        conn = self._require_conn()
        limit = int(limit)
        escaped = escape_cypher(token)
        ranked: list[tuple[int, int, SearchResult]] = []
        for table in _SEARCHABLE_TABLES:
            cypher = (
                f"MATCH (node:{table}) WHERE node.content CONTAINS '{escaped}' "
                f"RETURN node.id, node.name, node.file_path, node.content, node.signature "
                f"LIMIT {limit * 5}"
            )
            try:
                with self._lock:
                    result = conn.execute(cypher)
                while result.has_next():
                    row = result.get_next()
                    node_id = row[0] or ""
                    name = row[1] or ""
                    file_path = row[2] or ""
                    content = row[3] or ""
                    signature = row[4] or ""
                    label_prefix = node_id.split(":", 1)[0] if node_id else ""
                    # Prefer executable raise sites over the constant's declaration; among
                    # those, a smaller body is the more specific match. Tests rank last.
                    is_test = "/tests/" in file_path or "/test_" in file_path
                    exec_rank = 0 if label_prefix in ("function", "method") else 1
                    ranked.append(
                        (
                            exec_rank + (10 if is_test else 0),
                            len(content),
                            SearchResult(
                                node_id=node_id,
                                score=1.0,
                                node_name=name,
                                file_path=file_path,
                                label=label_prefix,
                                snippet=content[:200] if content else signature[:200],
                            ),
                        )
                    )
            except Exception:
                logger.debug("exact_content_search failed on table %s", table, exc_info=True)
        ranked.sort(key=lambda t: (t[0], t[1]))
        return [r for _, _, r in ranked][:limit]

    def colocated_codes(self, token: str, limit: int = 6) -> list[str]:
        """Logical keys co-located with a display code in a constants object (HOR-329 follow-up).

        A numeric display code (``ERR4624``) lives only inside a constants object next to its
        logical key — ``E_SYNC_PRODUCT_UPDATE_EXISTING: { code: 'ERR4624', … }`` — and never in
        the function that raises it (which references the logical key). Given the display code,
        return the enclosing logical key(s) so the caller can resolve THOSE to the raise site.
        """
        conn = self._require_conn()
        escaped = escape_cypher(token)
        out: list[str] = []
        seen: set[str] = set()
        for table in _SEARCHABLE_TABLES:
            cypher = (
                f"MATCH (node:{table}) WHERE node.content CONTAINS '{escaped}' "
                f"RETURN node.content LIMIT 5"
            )
            try:
                with self._lock:
                    result = conn.execute(cypher)
                while result.has_next():
                    content = result.get_next()[0] or ""
                    for key in _colocated_code_tokens(content, token):
                        if key not in seen:
                            seen.add(key)
                            out.append(key)
                            if len(out) >= limit:
                                return out
            except Exception:
                logger.debug("colocated_codes failed on table %s", table, exc_info=True)
        return out

    def decorator_arg_search(self, value: str, limit: int) -> list[SearchResult]:
        """Symbols whose decorator carries *value* as a string-literal argument.

        Deterministic signal->symbol seed: a runtime signal name — a BullMQ queue
        (``@Processor('MANAGE_SALES')``), an HTTP route (``@Get('/orders')``), a job name
        (``@Process('sync')``), or a message pattern (``@MessagePattern('order.created')``)
        — is wired to exactly the handler symbol it decorates.  The argument lives in the
        symbol's ``decorator_args`` (stored in ``properties_json``), so a query carrying that
        name resolves directly to the handler, not a semantic neighbour.

        Matching is exact and case-insensitive against each captured argument.  A cheap
        ``CONTAINS`` pre-filter on the JSON blob narrows candidates; membership is then
        confirmed by parsing ``decorator_args`` so a substring of an unrelated argument never
        produces a false hit.  Executable handlers (function/method) rank ahead of classes;
        tests rank last.
        """
        conn = self._require_conn()
        limit = int(limit)
        needle = value.casefold()
        escaped = escape_cypher(value)
        ranked: list[tuple[int, SearchResult]] = []
        seen: set[str] = set()
        for table in _SEARCHABLE_TABLES:
            # Case-insensitive CONTAINS pre-filter narrows candidates cheaply; exact membership
            # is confirmed in Python below, so the lowered substring match only needs to not miss.
            cypher = (
                f"MATCH (node:{table}) "
                f"WHERE lower(node.properties_json) CONTAINS lower('{escaped}') "
                f"RETURN node.id, node.name, node.file_path, node.content, "
                f"node.signature, node.properties_json "
                f"LIMIT {limit * 5}"
            )
            try:
                with self._lock:
                    result = conn.execute(cypher)
                while result.has_next():
                    row = result.get_next()
                    node_id = row[0] or ""
                    if node_id in seen:
                        continue
                    props_json = row[5] or ""
                    args = _decorator_args_from_json(props_json)
                    if not any(a.casefold() == needle for a in args):
                        continue  # CONTAINS matched a substring, not an actual arg — drop it
                    seen.add(node_id)
                    name = row[1] or ""
                    file_path = row[2] or ""
                    content = row[3] or ""
                    signature = row[4] or ""
                    label_prefix = node_id.split(":", 1)[0] if node_id else ""
                    is_test = "/tests/" in file_path or "/test_" in file_path
                    exec_rank = 0 if label_prefix in ("function", "method") else 1
                    ranked.append(
                        (
                            exec_rank + (10 if is_test else 0),
                            SearchResult(
                                node_id=node_id,
                                score=1.0,
                                node_name=name,
                                file_path=file_path,
                                label=label_prefix,
                                snippet=content[:200] if content else signature[:200],
                            ),
                        )
                    )
            except Exception:
                logger.debug("decorator_arg_search failed on table %s", table, exc_info=True)
        ranked.sort(key=lambda t: t[0])
        return [r for _, r in ranked][:limit]

    def exact_name_search(self, name: str, limit: int) -> list[SearchResult]:
        """Symbols whose ``name`` equals *name* exactly (case-insensitive).

        Deterministic seed for the "right file, wrong function" gap: when a query token IS a
        symbol's name (``manageSalesForMarket``), that symbol is the answer — not a semantic
        neighbour that merely embeds nearby.  Executable symbols (function/method) rank ahead
        of types/classes; non-test ahead of test; a shorter body (the focused definition)
        ahead of a larger one.
        """
        conn = self._require_conn()
        limit = int(limit)
        escaped = escape_cypher(name)
        ranked: list[tuple[int, int, SearchResult]] = []
        seen: set[str] = set()
        for table in _SEARCHABLE_TABLES:
            cypher = (
                f"MATCH (node:{table}) WHERE lower(node.name) = lower('{escaped}') "
                f"RETURN node.id, node.name, node.file_path, node.content, node.signature "
                f"LIMIT {limit * 5}"
            )
            try:
                with self._lock:
                    result = conn.execute(cypher)
                while result.has_next():
                    row = result.get_next()
                    node_id = row[0] or ""
                    if node_id in seen:
                        continue
                    seen.add(node_id)
                    sym_name = row[1] or ""
                    file_path = row[2] or ""
                    content = row[3] or ""
                    signature = row[4] or ""
                    label_prefix = node_id.split(":", 1)[0] if node_id else ""
                    is_test = "/tests/" in file_path or "/test_" in file_path
                    exec_rank = 0 if label_prefix in ("function", "method") else 1
                    ranked.append(
                        (
                            exec_rank + (10 if is_test else 0),
                            len(content),
                            SearchResult(
                                node_id=node_id,
                                score=1.0,
                                node_name=sym_name,
                                file_path=file_path,
                                label=label_prefix,
                                snippet=content[:200] if content else signature[:200],
                            ),
                        )
                    )
            except Exception:
                logger.debug("exact_name_search failed on table %s", table, exc_info=True)
        ranked.sort(key=lambda t: (t[0], t[1]))
        return [r for _, _, r in ranked][:limit]

    def fuzzy_search(
        self, query: str, limit: int, max_distance: int = 2
    ) -> list[SearchResult]:
        """Fuzzy name search using Levenshtein edit distance.

        Scans all node tables for symbols whose name is within
        *max_distance* edits of *query*.  Converts edit distance to a
        score (0 edits = 1.0, *max_distance* edits = 0.3).
        """
        conn = self._require_conn()
        limit = int(limit)
        max_distance = int(max_distance)
        candidates: list[SearchResult] = []

        for table in _SEARCHABLE_TABLES:
            cypher = (
                f"MATCH (n:{table}) "
                f"WHERE levenshtein(lower(n.name), $q) <= $dist "
                f"RETURN n.id, n.name, n.file_path, n.content, "
                f"levenshtein(lower(n.name), $q) AS dist "
                f"ORDER BY dist LIMIT $lim"
            )
            try:
                with self._lock:
                    result = conn.execute(
                        cypher,
                        parameters={"q": query.lower(), "dist": max_distance, "lim": limit},
                    )
                while result.has_next():
                    row = result.get_next()
                    node_id = row[0] or ""
                    name = row[1] or ""
                    file_path = row[2] or ""
                    content = row[3] or ""
                    dist = int(row[4]) if row[4] is not None else max_distance

                    score = max(0.3, 1.0 - (dist * 0.3))
                    label_prefix = node_id.split(":", 1)[0] if node_id else ""

                    candidates.append(
                        SearchResult(
                            node_id=node_id,
                            score=score,
                            node_name=name,
                            file_path=file_path,
                            label=label_prefix,
                            snippet=content[:200] if content else "",
                        )
                    )
            except Exception:
                logger.debug("fuzzy_search failed on table %s", table, exc_info=True)

        candidates.sort(key=lambda r: (-r.score, r.node_id))
        return candidates[:limit]

    def store_embeddings(self, embeddings: list[NodeEmbedding]) -> None:
        """Persist embedding vectors into the Embedding node table.

        Attempts batch CSV COPY FROM first, falls back to individual MERGE.
        """
        conn = self._require_conn()
        if not embeddings:
            return

        if self._bulk_store_embeddings_csv(embeddings):
            return

        for emb in embeddings:
            try:
                conn.execute(
                    "MERGE (e:Embedding {node_id: $nid}) SET e.vec = $vec",
                    parameters={"nid": emb.node_id, "vec": emb.embedding},
                )
            except Exception:
                logger.debug(
                    "store_embeddings failed for node %s", emb.node_id, exc_info=True
                )

    def vector_search(self, vector: list[float], limit: int) -> list[SearchResult]:
        """Find the closest nodes to *vector* using native ``array_cosine_similarity``.

        Computes cosine similarity directly in KuzuDB's Cypher engine —
        no Python-side computation or full-table load required.  Joins with
        node tables to fetch metadata in a single query.
        """
        conn = self._require_conn()
        limit = int(limit)

        try:
            with self._lock:
                result = conn.execute(
                    "MATCH (e:Embedding) "
                    "RETURN e.node_id, "
                    "array_cosine_similarity(e.vec, CAST($vec, 'FLOAT[384]')) AS sim "
                    "ORDER BY sim DESC LIMIT $lim",
                    parameters={"vec": vector, "lim": limit},
                )
        except Exception:
            # Surface, don't bury (HOR-373): a failure here (e.g. an embedding dimension/scheme
            # mismatch against the FLOAT[384] cast above) silently degrades search to keyword/FTS
            # only. Warn so it's discoverable instead of an invisible recall collapse.
            logger.warning(
                "vector_search failed — semantic search unavailable, degrading to keyword/FTS "
                "only (check embedding dimension/scheme vs the index)",
                exc_info=True,
            )
            return []

        emb_rows: list[tuple[str, float]] = []
        while result.has_next():
            row = result.get_next()
            emb_rows.append((row[0] or "", float(row[1]) if row[1] is not None else 0.0))

        if not emb_rows:
            return []

        node_cache: dict[str, GraphNode] = {}
        node_ids = [r[0] for r in emb_rows]
        ids_by_table: dict[str, list[str]] = {}
        for nid in node_ids:
            table = _table_for_id(nid)
            if table:
                ids_by_table.setdefault(table, []).append(nid)

        for table, ids in ids_by_table.items():
            try:
                q = f"MATCH (n:{table}) WHERE n.id IN $ids RETURN n.*"
                with self._lock:
                    res = conn.execute(q, parameters={"ids": ids})
                while res.has_next():
                    row = res.get_next()
                    node = self._row_to_node(row)
                    if node:
                        node_cache[node.id] = node
            except Exception:
                logger.debug("Batch node fetch failed for table %s", table, exc_info=True)

        results: list[SearchResult] = []
        for node_id, sim in emb_rows:
            node = node_cache.get(node_id)
            label_prefix = node_id.split(":", 1)[0] if node_id else ""
            results.append(
                SearchResult(
                    node_id=node_id,
                    score=sim,
                    node_name=node.name if node else "",
                    file_path=node.file_path if node else "",
                    label=label_prefix,
                    snippet=(node.content[:200] if node and node.content else ""),
                )
            )
        return results

    def get_indexed_files(self) -> dict[str, str]:
        """Return ``{file_path: sha256(content)}`` for all File nodes.

        Attempts to read pre-computed ``content_hash`` first. Falls back
        to computing the hash from content for databases that predate the
        schema addition.
        """
        conn = self._require_conn()
        mapping: dict[str, str] = {}
        try:
            with self._lock:
                result = conn.execute(
                    "MATCH (n:File) RETURN n.file_path, n.content"
                )
            while result.has_next():
                row = result.get_next()
                fp = row[0] or ""
                content = row[1] or ""
                mapping[fp] = hashlib.sha256(content.encode()).hexdigest()
        except Exception:
            logger.debug("get_indexed_files failed", exc_info=True)
        return mapping

    def get_file_index(self) -> dict[str, str]:
        """Return ``{file_path: node_id}`` for all File nodes."""
        conn = self._require_conn()
        index: dict[str, str] = {}
        try:
            with self._lock:
                result = conn.execute("MATCH (n:File) RETURN n.file_path, n.id")
            while result.has_next():
                row = result.get_next()
                index[row[0]] = row[1]
        except Exception:
            logger.debug("get_file_index failed", exc_info=True)
        return index

    def get_symbol_name_index(self) -> dict[str, list[str]]:
        """Return ``{symbol_name: [node_id, ...]}`` for callable/type symbols."""
        conn = self._require_conn()
        index: dict[str, list[str]] = {}
        tables = ["Function", "Method", "Class", "Interface", "TypeAlias"]
        for table in tables:
            try:
                with self._lock:
                    result = conn.execute(f"MATCH (n:{table}) RETURN n.name, n.id")
                while result.has_next():
                    row = result.get_next()
                    index.setdefault(row[0], []).append(row[1])
            except Exception:
                logger.debug("get_symbol_name_index failed for %s", table, exc_info=True)
        return index

    def load_graph(self) -> KnowledgeGraph:
        """Reconstruct a full :class:`KnowledgeGraph` from the database."""
        conn = self._require_conn()
        graph = KnowledgeGraph()

        for table in _NODE_TABLE_NAMES:
            try:
                with self._lock:
                    result = conn.execute(f"MATCH (n:{table}) RETURN n.*")
                while result.has_next():
                    row = result.get_next()
                    node = self._row_to_node(row)
                    if node is not None:
                        graph.add_node(node)
            except Exception:
                logger.debug("load_graph: failed to read table %s", table, exc_info=True)

        try:
            with self._lock:
                result = conn.execute(
                    "MATCH (a)-[r:CodeRelation]->(b) "
                    "RETURN a.id, b.id, r.rel_type, r.confidence, r.role, "
                    "r.step_number, r.strength, r.co_changes, r.symbols"
                )
            while result.has_next():
                row = result.get_next()
                src_id: str = row[0] or ""
                tgt_id: str = row[1] or ""
                rel_type_str: str = row[2] or ""

                rel_type = _REL_TYPE_MAP.get(rel_type_str)
                if rel_type is None:
                    continue

                rel_id = f"{rel_type_str}:{src_id}->{tgt_id}"

                props: dict[str, Any] = {}
                if row[3] is not None:
                    props["confidence"] = float(row[3])
                if row[4] is not None and row[4] != "":
                    props["role"] = str(row[4])
                if row[5] is not None and row[5] != 0:
                    props["step_number"] = int(row[5])
                if row[6] is not None and row[6] != 0.0:
                    props["strength"] = float(row[6])
                if row[7] is not None and row[7] != 0:
                    props["co_changes"] = int(row[7])
                if row[8] is not None and row[8] != "":
                    props["symbols"] = str(row[8])

                graph.add_relationship(
                    GraphRelationship(
                        id=rel_id,
                        type=rel_type,
                        source=src_id,
                        target=tgt_id,
                        properties=props,
                    )
                )
        except Exception:
            logger.error("load_graph: relationship query failed — graph incomplete", exc_info=True)
            raise

        return graph

    def delete_synthetic_nodes(self) -> None:
        """Remove all COMMUNITY and PROCESS nodes and their relationships."""
        conn = self._require_conn()
        for table in ("Community", "Process"):
            try:
                conn.execute(f"MATCH (n:{table}) DETACH DELETE n")
            except Exception:
                logger.debug(
                    "delete_synthetic_nodes: failed for %s", table, exc_info=True
                )

    def upsert_embeddings(self, embeddings: list[NodeEmbedding]) -> None:
        """Insert or update embeddings without wiping existing ones."""
        conn = self._require_conn()
        for emb in embeddings:
            try:
                conn.execute(
                    "MERGE (e:Embedding {node_id: $nid}) SET e.vec = $vec",
                    parameters={"nid": emb.node_id, "vec": emb.embedding},
                )
            except Exception:
                logger.debug(
                    "upsert_embeddings failed for %s", emb.node_id, exc_info=True
                )

    def update_dead_flags(
        self, dead_ids: set[str], alive_ids: set[str]
    ) -> None:
        """Set is_dead=True on *dead_ids* and is_dead=False on *alive_ids*."""
        conn = self._require_conn()

        def _batch_set(ids: set[str], value: bool) -> None:
            by_table: dict[str, list[str]] = {}
            for node_id in ids:
                table = _table_for_id(node_id)
                if table:
                    by_table.setdefault(table, []).append(node_id)
            for table, id_list in by_table.items():
                try:
                    conn.execute(
                        f"MATCH (n:{table}) WHERE n.id IN $ids SET n.is_dead = $val",
                        parameters={"ids": id_list, "val": value},
                    )
                except Exception:
                    logger.debug(
                        "update_dead_flags failed for table %s", table, exc_info=True
                    )

        _batch_set(dead_ids, True)
        _batch_set(alive_ids, False)

    def remove_relationships_by_type(self, rel_type: RelType) -> None:
        """Delete all relationships of a specific type."""
        conn = self._require_conn()
        try:
            conn.execute(
                "MATCH ()-[r:CodeRelation]->() WHERE r.rel_type = $rt DELETE r",
                parameters={"rt": rel_type.value},
            )
        except Exception:
            logger.debug(
                "remove_relationships_by_type failed for %s",
                rel_type.value,
                exc_info=True,
            )

    def bulk_load(self, graph: KnowledgeGraph) -> None:
        """Replace the entire store with the contents of *graph*.

        Uses CSV-based COPY FROM for bulk loading nodes and relationships,
        falling back to individual inserts if COPY FROM fails.
        """
        conn = self._require_conn()
        for table in _NODE_TABLE_NAMES:
            try:
                conn.execute(f"MATCH (n:{table}) DETACH DELETE n")
            except Exception:
                pass

        # Wipe embeddings table too — avoids redundant per-batch DELETE
        # queries inside _bulk_store_embeddings_csv later.
        try:
            conn.execute("MATCH (e:Embedding) DELETE e")
        except Exception:
            pass
        self._embeddings_clean = True

        if not self._bulk_load_nodes_csv(graph):
            self.add_nodes(list(graph.iter_nodes()))

        if not self._bulk_load_rels_csv(graph):
            self.add_relationships(list(graph.iter_relationships()))

        self.rebuild_fts_indexes()

    def rebuild_fts_indexes(self) -> None:
        """Drop and recreate FTS indexes on searchable tables only.

        Skips structural tables (Folder, Community, Process) that lack
        meaningful content/signature fields — saves ~30% of FTS rebuild time.
        """
        conn = self._require_conn()
        for table in _SEARCHABLE_TABLES:
            idx_name = f"{table.lower()}_fts"
            try:
                conn.execute(f"CALL DROP_FTS_INDEX('{table}', '{idx_name}')")
            except Exception:
                pass
            try:
                conn.execute(
                    f"CALL CREATE_FTS_INDEX('{table}', '{idx_name}', "
                    f"['name', 'content', 'signature'])"
                )
            except Exception:
                logger.debug("FTS index rebuild failed for %s", table, exc_info=True)

    def _csv_copy(self, table: str, rows: list[list[Any]]) -> None:
        """Write *rows* to a temporary CSV and COPY FROM into *table*.

        Uses PARALLEL=FALSE to avoid concurrency issues with KuzuDB's
        parallel CSV reader.  Always cleans up the temp file, even on failure.
        """
        conn = self._require_conn()
        csv_path: str | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", suffix=".csv", delete=False, newline=""
            ) as f:
                writer = csv.writer(f)
                writer.writerows(rows)
                csv_path = f.name
            conn.execute(f'COPY {table} FROM "{csv_path}" (HEADER=false, PARALLEL=false)')
        finally:
            if csv_path:
                Path(csv_path).unlink(missing_ok=True)

    def _bulk_load_nodes_csv(self, graph: KnowledgeGraph) -> bool:
        """Load all nodes via temporary CSV files + COPY FROM.

        Returns True on success, False if COPY FROM is not available.
        """
        by_table: dict[str, list[GraphNode]] = {}
        for node in graph.iter_nodes():
            table = _LABEL_TO_TABLE.get(node.label.value)
            if table:
                by_table.setdefault(table, []).append(node)

        try:
            for table, nodes in by_table.items():
                self._csv_copy(table, [
                    [node.id, node.name, node.file_path, node.start_line,
                     node.end_line, node.content, node.signature, node.language,
                     node.class_name, node.is_dead, node.is_entry_point,
                     node.is_exported, (node.properties or {}).get("cohesion"),
                     _serialize_extra_props(node.properties)]
                    for node in nodes
                ])
            return True
        except Exception:
            logger.debug("CSV bulk_load_nodes failed, falling back", exc_info=True)
            conn = self._require_conn()
            for table in by_table:
                try:
                    conn.execute(f"MATCH (n:{table}) DETACH DELETE n")
                except Exception:
                    pass
            return False

    def _bulk_load_rels_csv(self, graph: KnowledgeGraph) -> bool:
        """Load all relationships via temporary CSV files + COPY FROM.

        Returns True on success, False if COPY FROM is not available.
        """
        by_pair: dict[tuple[str, str], list[GraphRelationship]] = {}
        for rel in graph.iter_relationships():
            src_table = _table_for_id(rel.source)
            dst_table = _table_for_id(rel.target)
            if src_table and dst_table:
                by_pair.setdefault((src_table, dst_table), []).append(rel)

        try:
            for (src_table, dst_table), rels in by_pair.items():
                self._csv_copy(f"CodeRelation_{src_table}_{dst_table}", [
                    [rel.source, rel.target, rel.type.value,
                     float((rel.properties or {}).get("confidence", 1.0)),
                     str((rel.properties or {}).get("role", "")),
                     int((rel.properties or {}).get("step_number", 0)),
                     float((rel.properties or {}).get("strength", 0.0)),
                     int((rel.properties or {}).get("co_changes", 0)),
                     str((rel.properties or {}).get("symbols", ""))]
                    for rel in rels
                ])
            return True
        except Exception:
            logger.debug("CSV bulk_load_rels failed, falling back", exc_info=True)
            return False

    def _bulk_store_embeddings_csv(self, embeddings: list[NodeEmbedding]) -> bool:
        """Store embeddings via temporary CSV + COPY FROM.

        Returns True on success, False if COPY FROM is not available.
        """
        conn = self._require_conn()
        try:
            # Skip DELETE if bulk_load already wiped the table
            if not self._embeddings_clean:
                current_ids = [emb.node_id for emb in embeddings]
                for i in range(0, len(current_ids), 500):
                    batch = current_ids[i:i + 500]
                    try:
                        conn.execute(
                            "MATCH (e:Embedding) WHERE e.node_id IN $ids DETACH DELETE e",
                            parameters={"ids": batch},
                        )
                    except Exception:
                        pass

            self._csv_copy("Embedding", [
                [emb.node_id, json.dumps(emb.embedding)]
                for emb in embeddings
            ])
            self._embeddings_clean = False
            return True
        except Exception:
            logger.debug("CSV bulk_store_embeddings failed, falling back", exc_info=True)
            return False

    def _create_schema(self) -> None:
        """Create node/rel/embedding tables and the FTS extension."""
        conn = self._require_conn()

        try:
            conn.execute("INSTALL fts")
            conn.execute("LOAD EXTENSION fts")
        except Exception:
            logger.debug("FTS extension load skipped (may already be loaded)", exc_info=True)

        for table in _NODE_TABLE_NAMES:
            stmt = f"CREATE NODE TABLE IF NOT EXISTS {table}({_NODE_PROPERTIES})"
            conn.execute(stmt)
            try:
                conn.execute(f"ALTER TABLE {table} ADD properties_json STRING DEFAULT ''")
            except Exception:
                pass

        conn.execute(
            f"CREATE NODE TABLE IF NOT EXISTS Embedding({_EMBEDDING_PROPERTIES})"
        )

        from_to_pairs: list[str] = []
        for src in _NODE_TABLE_NAMES:
            for dst in _NODE_TABLE_NAMES:
                from_to_pairs.append(f"FROM {src} TO {dst}")

        pairs_clause = ", ".join(from_to_pairs)
        rel_stmt = (
            f"CREATE REL TABLE GROUP IF NOT EXISTS CodeRelation("
            f"{pairs_clause}, {_REL_PROPERTIES})"
        )
        try:
            conn.execute(rel_stmt)
        except Exception:
            logger.debug("REL TABLE GROUP creation skipped", exc_info=True)

        self._create_fts_indexes()

    def _create_fts_indexes(self) -> None:
        """Create FTS indexes for searchable node tables (idempotent)."""
        conn = self._require_conn()
        for table in _SEARCHABLE_TABLES:
            idx_name = f"{table.lower()}_fts"
            try:
                conn.execute(
                    f"CALL CREATE_FTS_INDEX('{table}', '{idx_name}', "
                    f"['name', 'content', 'signature'])"
                )
            except Exception:
                pass

    def _insert_node(self, node: GraphNode) -> None:
        conn = self._require_conn()
        table = _LABEL_TO_TABLE.get(node.label.value)
        if table is None:
            logger.warning("Unknown label %s for node %s", node.label, node.id)
            return

        query = (
            f"CREATE (:{table} {{"
            f"id: $id, name: $name, file_path: $file_path, "
            f"start_line: $start_line, end_line: $end_line, "
            f"content: $content, signature: $signature, "
            f"language: $language, class_name: $class_name, "
            f"is_dead: $is_dead, is_entry_point: $is_entry_point, "
            f"is_exported: $is_exported, cohesion: $cohesion, "
            f"properties_json: $properties_json"
            f"}})"
        )
        props = node.properties or {}
        params = {
            "id": node.id,
            "name": node.name,
            "file_path": node.file_path,
            "start_line": node.start_line,
            "end_line": node.end_line,
            "content": node.content,
            "signature": node.signature,
            "language": node.language,
            "class_name": node.class_name,
            "is_dead": node.is_dead,
            "is_entry_point": node.is_entry_point,
            "is_exported": node.is_exported,
            "cohesion": props.get("cohesion"),
            "properties_json": _serialize_extra_props(props),
        }
        try:
            conn.execute(query, parameters=params)
        except Exception:
            logger.debug("Insert node failed for %s", node.id, exc_info=True)

    def _insert_relationship(self, rel: GraphRelationship) -> None:
        conn = self._require_conn()
        src_table = _table_for_id(rel.source)
        tgt_table = _table_for_id(rel.target)
        if src_table is None or tgt_table is None:
            logger.warning(
                "Cannot resolve tables for relationship %s -> %s",
                rel.source,
                rel.target,
            )
            return

        props = rel.properties or {}

        query = (
            f"MATCH (a:{src_table}), (b:{tgt_table}) "
            f"WHERE a.id = $src AND b.id = $tgt "
            f"CREATE (a)-[:CodeRelation {{"
            f"rel_type: $rel_type, "
            f"confidence: $confidence, "
            f"role: $role, "
            f"step_number: $step_number, "
            f"strength: $strength, "
            f"co_changes: $co_changes, "
            f"symbols: $symbols"
            f"}}]->(b)"
        )
        params = {
            "src": rel.source,
            "tgt": rel.target,
            "rel_type": rel.type.value,
            "confidence": float(props.get("confidence", 1.0)),
            "role": str(props.get("role", "")),
            "step_number": int(props.get("step_number", 0)),
            "strength": float(props.get("strength", 0.0)),
            "co_changes": int(props.get("co_changes", 0)),
            "symbols": str(props.get("symbols", "")),
        }
        try:
            conn.execute(query, parameters=params)
        except Exception:
            logger.debug(
                "Insert relationship failed: %s -> %s", rel.source, rel.target, exc_info=True
            )

    def _query_nodes(
        self, query: str, parameters: dict[str, Any] | None = None
    ) -> list[GraphNode]:
        """Execute a query returning ``n.*`` columns and convert to GraphNode list."""
        conn = self._require_conn()
        nodes: list[GraphNode] = []
        try:
            with self._lock:
                result = conn.execute(query, parameters=parameters or {})
            while result.has_next():
                row = result.get_next()
                node = self._row_to_node(row)
                if node is not None:
                    nodes.append(node)
        except Exception:
            logger.warning("_query_nodes failed: %s", query, exc_info=True)
        return nodes

    def _query_nodes_with_confidence(
        self, query: str, parameters: dict[str, Any] | None = None
    ) -> list[tuple[GraphNode, float]]:
        """Execute a query returning ``n.*`` columns plus a trailing confidence column."""
        conn = self._require_conn()
        pairs: list[tuple[GraphNode, float]] = []
        try:
            with self._lock:
                result = conn.execute(query, parameters=parameters or {})
            while result.has_next():
                row = result.get_next()
                node = self._row_to_node(row[:-1])
                confidence = float(row[-1]) if row[-1] is not None else 1.0
                if node is not None:
                    pairs.append((node, confidence))
        except Exception:
            logger.warning("_query_nodes_with_confidence failed: %s", query, exc_info=True)
        return pairs

    @staticmethod
    def _row_to_node(row: list[Any], node_id: str | None = None) -> GraphNode | None:
        """Convert a result row from ``RETURN n.*`` into a GraphNode.

        Column order matches the property definition:
        0=id, 1=name, 2=file_path, 3=start_line, 4=end_line,
        5=content, 6=signature, 7=language, 8=class_name,
        9=is_dead, 10=is_entry_point, 11=is_exported, 12=cohesion,
        13=properties_json
        """
        try:
            nid = node_id or row[0]
            prefix = nid.split(":", 1)[0]
            label = _LABEL_MAP.get(prefix)
            if label is None:
                logger.warning("Unknown node label prefix %r in id %s", prefix, nid)
                return None

            props: dict[str, Any] = {}
            if len(row) > 12 and row[12] is not None:
                props["cohesion"] = float(row[12])

            if len(row) > 13 and row[13]:
                try:
                    extra = json.loads(row[13])
                    if isinstance(extra, dict):
                        props.update(extra)
                except (ValueError, TypeError):
                    pass

            return GraphNode(
                id=row[0],
                label=label,
                name=row[1] or "",
                file_path=row[2] or "",
                start_line=row[3] or 0,
                end_line=row[4] or 0,
                content=row[5] or "",
                signature=row[6] or "",
                language=row[7] or "",
                class_name=row[8] or "",
                is_dead=bool(row[9]),
                is_entry_point=bool(row[10]),
                is_exported=bool(row[11]),
                properties=props,
            )
        except (IndexError, KeyError):
            logger.debug("Failed to convert row to GraphNode: %s", row, exc_info=True)
            return None
