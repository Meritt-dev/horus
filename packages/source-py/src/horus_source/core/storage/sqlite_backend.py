"""SQLite storage backend for Horus.

Implements the :class:`StorageBackend` protocol on top of plain SQLite plus two
extensions: ``sqlite-vec`` (vec0 virtual table for brute-force cosine vector
search, the same algorithm KùzuDB used) and the built-in FTS5 module (BM25
full-text search). The KùzuDB schema's ten node tables collapse into a single
``nodes`` table discriminated by a ``label`` column; the relationship table
group collapses into a single ``edges`` table. Graph traversal that KùzuDB
expressed in Cypher is expressed here as SQL JOINs (single hop) and a
``WITH RECURSIVE`` CTE (multi hop), matching the BFS semantics of
:class:`~horus_source.core.storage.kuzu_backend.KuzuBackend`.

Each repository gets a single ``.horus/source/horus.db`` file opened in WAL
mode. This is the SQLite half of the kùzu→SQLite migration (HOR-392); it sits
behind the same :class:`StorageBackend` seam so callers are unaffected.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any

try:  # sqlite-vec ships no musl/Alpine (musllinux) wheel and no sdist (HOR-392).
    import sqlite_vec
except ImportError as _exc:  # pragma: no cover - exercised on musl/Alpine only
    sqlite_vec = None  # type: ignore[assignment]
    _SQLITE_VEC_IMPORT_ERROR: ImportError | None = _exc
else:
    _SQLITE_VEC_IMPORT_ERROR = None

from horus_source.core.classify import is_product
from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import GraphNode, GraphRelationship, NodeLabel, RelType
from horus_source.core.storage.base import EMBEDDING_DIMENSIONS, NodeEmbedding, SearchResult

logger = logging.getLogger(__name__)


class SqliteVecUnavailableError(RuntimeError):
    """Raised when the sqlite-vec (vec0) extension cannot be imported or loaded.

    This is almost always a platform-portability issue, not a bug: ``sqlite-vec``
    publishes no musl/Alpine (``musllinux``) wheel and no source distribution, so
    on Alpine-based images it cannot be installed or loaded at all. Carrying a
    dedicated error type lets callers (and tests) distinguish this actionable,
    platform-specific failure from a raw ``ImportError`` / ``OperationalError``.
    """


# Actionable guidance shown when sqlite-vec is missing or its extension won't load.
# Names the real cause (no musl/Alpine wheel) and the two supported fixes.
_SQLITE_VEC_UNAVAILABLE_MSG = (
    "The SQLite storage backend requires the sqlite-vec (vec0) extension for "
    "vector search, but it could not be loaded.\n"
    "Cause: the 'sqlite-vec' package publishes no musl/Alpine (musllinux) wheel "
    "and no source distribution, so it cannot be installed or loaded on "
    "Alpine Linux or any other musl-based Python build.\n"
    "Fix one of the following:\n"
    "  1. Use a glibc-based Python — e.g. a Debian/Ubuntu-based image, not Alpine "
    "(sqlite-vec ships wheels for Linux glibc x86_64/aarch64 and macOS).\n"
    "  2. Set HORUS_SOURCE_STORAGE_BACKEND=kuzu to use the legacy KùzuDB backend, "
    "which remains available for one deprecation release."
)


def _load_sqlite_vec_extension(conn: sqlite3.Connection) -> None:
    """Load the sqlite-vec (vec0) extension into *conn*, or raise a clear error.

    On musl/Alpine ``pip install sqlite-vec`` is impossible (no musllinux wheel,
    no sdist), so either the import is missing or the bundled extension fails to
    load. Either way we raise :class:`SqliteVecUnavailableError` with actionable
    guidance instead of letting a cryptic ``ImportError`` / ``OperationalError``
    surface. We deliberately do NOT auto-fall back to the kùzu backend — that
    would silently hide a real deployment misconfiguration.
    """
    if sqlite_vec is None:
        raise SqliteVecUnavailableError(_SQLITE_VEC_UNAVAILABLE_MSG) from _SQLITE_VEC_IMPORT_ERROR
    try:
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
    except Exception as exc:  # OperationalError, AttributeError, etc.
        raise SqliteVecUnavailableError(_SQLITE_VEC_UNAVAILABLE_MSG) from exc


# Labels that carry no searchable code content (structural / synthetic nodes).
# Mirrors KuzuBackend._SEARCHABLE_TABLES, which excludes Folder/Community/Process
# from full-text, fuzzy, exact-name, and content searches.
_NON_SEARCHABLE_LABELS: frozenset[str] = frozenset(
    {NodeLabel.FOLDER.value, NodeLabel.COMMUNITY.value, NodeLabel.PROCESS.value}
)

_SYNTHETIC_LABELS: tuple[str, ...] = (NodeLabel.COMMUNITY.value, NodeLabel.PROCESS.value)

_SYMBOL_INDEX_LABELS: tuple[str, ...] = (
    NodeLabel.FUNCTION.value,
    NodeLabel.CLASS.value,
    NodeLabel.METHOD.value,
    NodeLabel.INTERFACE.value,
    NodeLabel.TYPE_ALIAS.value,
)

_LABEL_MAP: dict[str, NodeLabel] = {label.value: label for label in NodeLabel}
_REL_TYPE_MAP: dict[str, RelType] = {rt.value: rt for rt in RelType}

_DEDICATED_PROPS = frozenset({"cohesion"})

# Columns selected for a full GraphNode reconstruction, in a fixed order.
_NODE_COLUMNS = (
    "id, label, name, file_path, start_line, end_line, content, signature, "
    "language, class_name, is_dead, is_entry_point, is_exported, cohesion, "
    "properties_json"
)

# A code-shaped identifier (see KuzuBackend for the rationale): an UPPER token
# (>=4 chars) of [A-Z0-9_] containing a digit or underscore.
_CODE_TOKEN_RE = re.compile(r"\b(?=[A-Z0-9_]*[0-9_])[A-Z][A-Z0-9_]{3,}\b")

# FTS bareword token: a run of alphanumerics. Used to sanitise free-text queries
# into a safe FTS5 MATCH expression (avoids injecting FTS operator characters).
_FTS_TOKEN_RE = re.compile(r"[A-Za-z0-9]+")


def _serialize_extra_props(props: dict[str, Any] | None) -> str:
    """Serialise non-dedicated node properties to a JSON string (or '')."""
    if not props:
        return ""
    extra = {k: v for k, v in props.items() if k not in _DEDICATED_PROPS}
    return json.dumps(extra) if extra else ""


def _decorator_args_from_json(props_json: str) -> list[str]:
    """Pull the ``decorator_args`` list out of a node's serialised ``properties_json``."""
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


def _colocated_code_tokens(content: str, token: str, window: int = 200) -> list[str]:
    """Code-shaped identifiers near ``token`` in ``content``, nearest first.

    See :func:`horus_source.core.storage.kuzu_backend._colocated_code_tokens`.
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


def _levenshtein(a: str, b: str, max_distance: int) -> int:
    """Levenshtein edit distance between *a* and *b*, capped at *max_distance* + 1.

    Returns ``max_distance + 1`` as soon as it is provable that the true distance
    exceeds *max_distance*, so callers can cheaply reject far-apart strings.
    """
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if abs(la - lb) > max_distance:
        return max_distance + 1
    if la == 0:
        return lb
    if lb == 0:
        return la
    previous = list(range(lb + 1))
    for i in range(1, la + 1):
        current = [i] + [0] * lb
        ca = a[i - 1]
        row_min = current[0]
        for j in range(1, lb + 1):
            cost = 0 if ca == b[j - 1] else 1
            current[j] = min(
                previous[j] + 1,        # deletion
                current[j - 1] + 1,     # insertion
                previous[j - 1] + cost,  # substitution
            )
            if current[j] < row_min:
                row_min = current[j]
        if row_min > max_distance:
            return max_distance + 1
        previous = current
    return previous[lb]


def _build_fts_match(query: str) -> str | None:
    """Turn a free-text query into a safe FTS5 MATCH expression.

    Splits on non-alphanumerics and ORs prefix matches for each token. Returns
    ``None`` when the query contains no usable tokens (caller short-circuits to
    an empty result, matching KùzuDB's behaviour for an empty FTS query).
    """
    tokens = _FTS_TOKEN_RE.findall(query)
    if not tokens:
        return None
    return " OR ".join(f"{tok}*" for tok in tokens)



# Test/example/demo/bench paths rank LAST in exact-name results (dogfood cycle-4:
# rocket's 10 `examples/*/main.rs` fns named `rocket` starved the pool before the
# core `Rocket` struct — explain never saw the real symbol).
_DEPRIORITIZED_RESULT_PATH_RE = __import__("re").compile(
    r"(^|/)(tests?|__tests__|spec|examples?|samples?|demos?|benches|benchmarks?|fixtures?)(/|$)"
    r"|(\.|_)(test|spec)\.[jt]sx?$|(^|/)test_[^/]*\.py$|_test\.(py|go|rs)$",
)

def _is_deprioritized_result_path(file_path: str) -> bool:
    return bool(file_path) and _DEPRIORITIZED_RESULT_PATH_RE.search(file_path) is not None

def _like_escape(value: str) -> str:
    """Escape ``%``/``_``/``\\`` so *value* is matched literally in a LIKE clause."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class SqliteBackend:
    """StorageBackend implementation backed by SQLite + sqlite-vec + FTS5.

    Usage::

        backend = SqliteBackend()
        backend.initialize(Path("/repo/.horus/source/horus.db"))
        backend.bulk_load(graph)
        node = backend.get_node("function:src/app.py:main")
        backend.close()
    """

    def __init__(self) -> None:
        self._conn: sqlite3.Connection | None = None
        self._lock = threading.RLock()
        self._path: Path | None = None
        self._read_only: bool = False
        # Dedicated read-only connection for execute_raw (the SQL console). Lazily
        # opened against the same file with `mode=ro` so an arbitrary query can
        # NEVER write, regardless of the route's keyword guard. See execute_raw.
        self._ro_conn: sqlite3.Connection | None = None
        # Parity flag with KuzuBackend; SQLite recovery is handled separately and
        # this backend never recreates a corrupt DB silently in Stage 1.
        self.recreated_due_to_corruption: bool = False

    def _require_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("SqliteBackend.initialize() must be called before use")
        return self._conn

    # ------------------------------------------------------------------ lifecycle

    def initialize(
        self,
        path: Path,
        *,
        read_only: bool = False,
        max_retries: int = 0,  # noqa: ARG002 - accepted for StorageBackend parity
        retry_delay: float = 0.3,  # noqa: ARG002 - accepted for StorageBackend parity
        recover_corrupt: bool = False,  # noqa: ARG002 - SQLite recovery is separate
    ) -> None:
        """Open or create the SQLite database at *path* (WAL mode).

        In read-only mode the database must already exist and schema creation is
        skipped. ``max_retries``/``retry_delay``/``recover_corrupt`` are accepted
        for signature parity with :class:`KuzuBackend` but are not yet used here.
        """
        path = Path(path)
        if read_only:
            # Percent-encode the path: a raw f-string lets URI delimiters in the
            # filesystem path (``?``/``#``) truncate the filename and drop
            # ``mode=ro``. ``Path.as_uri()`` escapes it (requires an absolute path).
            uri = path.resolve().as_uri() + "?mode=ro"
            conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(path), check_same_thread=False)

        try:
            _load_sqlite_vec_extension(conn)
        except SqliteVecUnavailableError:
            conn.close()
            raise

        if not read_only:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=OFF")

        self._conn = conn
        self._path = path
        self._read_only = read_only
        if not read_only:
            self._create_schema()

    def close(self) -> None:
        """Close the SQLite connection(s), releasing the file lock."""
        for attr in ("_conn", "_ro_conn"):
            conn = getattr(self, attr)
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    logger.debug("SqliteBackend close failed (%s)", attr, exc_info=True)
                setattr(self, attr, None)

    def _readonly_conn(self) -> sqlite3.Connection:
        """A connection that physically cannot write, for the SQL console.

        When the backend is already open read-only we reuse the main connection.
        Otherwise (the host opens read-write for reindex/watch) we lazily open a
        SEPARATE ``mode=ro`` connection to the same file, so a query that slips
        past the route's keyword guard still cannot mutate the store — SQLite
        rejects the write at the OS/driver level.
        """
        if self._read_only:
            return self._require_conn()
        if self._ro_conn is None:
            if self._path is None:
                raise RuntimeError("SqliteBackend.initialize() must be called before use")
            # Escape the path so ``?``/``#`` in a repo path can't slip past the
            # read-only open (see initialize()). ``as_uri()`` percent-encodes it.
            uri = self._path.resolve().as_uri() + "?mode=ro"
            ro = sqlite3.connect(uri, uri=True, check_same_thread=False)
            try:
                _load_sqlite_vec_extension(ro)
            except SqliteVecUnavailableError:
                # Vector search degrades to FTS; a raw SELECT touching code_vec will
                # error clearly rather than write. Keep the RO conn usable.
                logger.debug("sqlite-vec unavailable on the read-only console connection")
            self._ro_conn = ro
        return self._ro_conn

    def _create_schema(self) -> None:
        conn = self._require_conn()
        with self._lock:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS nodes (
                    id TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    name TEXT,
                    file_path TEXT,
                    start_line INTEGER DEFAULT 0,
                    end_line INTEGER DEFAULT 0,
                    content TEXT DEFAULT '',
                    signature TEXT DEFAULT '',
                    language TEXT DEFAULT '',
                    class_name TEXT DEFAULT '',
                    is_dead INTEGER DEFAULT 0,
                    is_entry_point INTEGER DEFAULT 0,
                    is_exported INTEGER DEFAULT 0,
                    cohesion REAL,
                    properties_json TEXT DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS edges (
                    source TEXT NOT NULL,
                    target TEXT NOT NULL,
                    rel_type TEXT NOT NULL,
                    confidence REAL DEFAULT 1.0,
                    role TEXT DEFAULT '',
                    step_number INTEGER DEFAULT 0,
                    strength REAL DEFAULT 0.0,
                    co_changes INTEGER DEFAULT 0,
                    symbols TEXT DEFAULT '',
                    PRIMARY KEY (source, target, rel_type)
                );

                CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source, rel_type);
                CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target, rel_type);
                CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
                CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);

                CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
                    name, content, signature, content='nodes'
                );

                CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
                    INSERT INTO nodes_fts(rowid, name, content, signature)
                    VALUES (new.rowid, new.name, new.content, new.signature);
                END;

                CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
                    INSERT INTO nodes_fts(nodes_fts, rowid, name, content, signature)
                    VALUES ('delete', old.rowid, old.name, old.content, old.signature);
                END;

                CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
                    INSERT INTO nodes_fts(nodes_fts, rowid, name, content, signature)
                    VALUES ('delete', old.rowid, old.name, old.content, old.signature);
                    INSERT INTO nodes_fts(rowid, name, content, signature)
                    VALUES (new.rowid, new.name, new.content, new.signature);
                END;
                """
            )
            conn.execute(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS code_vec USING vec0("
                f"node_id TEXT PRIMARY KEY, "
                f"embedding float[{EMBEDDING_DIMENSIONS}] distance_metric=cosine)"
            )
            conn.commit()

    # ------------------------------------------------------------------ writes

    def add_nodes(self, nodes: list[GraphNode]) -> None:
        conn = self._require_conn()
        rows = [self._node_to_row(n) for n in nodes]
        if not rows:
            return
        with self._lock:
            conn.executemany(
                "INSERT OR REPLACE INTO nodes ("
                "id, label, name, file_path, start_line, end_line, content, "
                "signature, language, class_name, is_dead, is_entry_point, "
                "is_exported, cohesion, properties_json) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
            conn.commit()

    def add_relationships(self, rels: list[GraphRelationship]) -> None:
        conn = self._require_conn()
        rows = [self._rel_to_row(r) for r in rels]
        if not rows:
            return
        with self._lock:
            conn.executemany(
                "INSERT OR REPLACE INTO edges ("
                "source, target, rel_type, confidence, role, step_number, "
                "strength, co_changes, symbols) VALUES (?,?,?,?,?,?,?,?,?)",
                rows,
            )
            conn.commit()

    def remove_nodes_by_file(self, file_path: str) -> int:
        """Delete all nodes whose ``file_path`` matches, plus their edges. Returns count."""
        conn = self._require_conn()
        with self._lock:
            ids = [
                r[0]
                for r in conn.execute(
                    "SELECT id FROM nodes WHERE file_path = ?", (file_path,)
                ).fetchall()
            ]
            if not ids:
                return 0
            placeholders = ",".join("?" * len(ids))
            conn.execute(
                f"DELETE FROM edges WHERE source IN ({placeholders}) "
                f"OR target IN ({placeholders})",
                ids + ids,
            )
            conn.execute(
                f"DELETE FROM code_vec WHERE node_id IN ({placeholders})", ids
            )
            cur = conn.execute(
                "DELETE FROM nodes WHERE file_path = ?", (file_path,)
            )
            conn.commit()
            return cur.rowcount if cur.rowcount is not None else len(ids)

    def update_dead_flags(self, dead_ids: set[str], alive_ids: set[str]) -> None:
        """Set ``is_dead=1`` on *dead_ids* and ``is_dead=0`` on *alive_ids*."""
        conn = self._require_conn()
        with self._lock:
            for ids, value in ((dead_ids, 1), (alive_ids, 0)):
                id_list = list(ids)
                for i in range(0, len(id_list), 500):
                    batch = id_list[i : i + 500]
                    placeholders = ",".join("?" * len(batch))
                    conn.execute(
                        f"UPDATE nodes SET is_dead = ? WHERE id IN ({placeholders})",
                        [value, *batch],
                    )
            conn.commit()

    def remove_relationships_by_type(self, rel_type: RelType) -> None:
        """Delete all relationships of a specific type."""
        conn = self._require_conn()
        with self._lock:
            conn.execute("DELETE FROM edges WHERE rel_type = ?", (rel_type.value,))
            conn.commit()

    def delete_synthetic_nodes(self) -> None:
        """Remove all COMMUNITY and PROCESS nodes and their relationships."""
        conn = self._require_conn()
        with self._lock:
            placeholders = ",".join("?" * len(_SYNTHETIC_LABELS))
            ids = [
                r[0]
                for r in conn.execute(
                    f"SELECT id FROM nodes WHERE label IN ({placeholders})",
                    _SYNTHETIC_LABELS,
                ).fetchall()
            ]
            if ids:
                id_ph = ",".join("?" * len(ids))
                conn.execute(
                    f"DELETE FROM edges WHERE source IN ({id_ph}) OR target IN ({id_ph})",
                    ids + ids,
                )
                conn.execute(f"DELETE FROM code_vec WHERE node_id IN ({id_ph})", ids)
            conn.execute(
                f"DELETE FROM nodes WHERE label IN ({placeholders})", _SYNTHETIC_LABELS
            )
            conn.commit()

    def bulk_load(self, graph: KnowledgeGraph) -> None:
        """Replace the entire store with the contents of *graph*."""
        conn = self._require_conn()
        with self._lock:
            conn.execute("DELETE FROM edges")
            conn.execute("DELETE FROM nodes")
            conn.execute("DELETE FROM code_vec")
            conn.commit()
        self.add_nodes(list(graph.iter_nodes()))
        self.add_relationships(list(graph.iter_relationships()))
        self.rebuild_fts_indexes()

    def rebuild_fts_indexes(self) -> None:
        """Rebuild the FTS5 index from the ``nodes`` content table."""
        conn = self._require_conn()
        with self._lock:
            conn.execute("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')")
            conn.commit()

    # ------------------------------------------------------------------ embeddings

    def store_embeddings(self, embeddings: list[NodeEmbedding]) -> None:
        """Persist (insert-or-replace) embedding vectors for the given nodes."""
        self._put_embeddings(embeddings)

    def upsert_embeddings(self, embeddings: list[NodeEmbedding]) -> None:
        """Insert or update embeddings without wiping existing ones."""
        self._put_embeddings(embeddings)

    def _put_embeddings(self, embeddings: list[NodeEmbedding]) -> None:
        conn = self._require_conn()
        rows = [e for e in embeddings if e.embedding]
        if not rows:
            return
        with self._lock:
            for emb in rows:
                conn.execute(
                    "DELETE FROM code_vec WHERE node_id = ?", (emb.node_id,)
                )
                conn.execute(
                    "INSERT INTO code_vec(node_id, embedding) VALUES (?, ?)",
                    (emb.node_id, sqlite_vec.serialize_float32(emb.embedding)),
                )
            conn.commit()

    def vector_search(self, vector: list[float], limit: int) -> list[SearchResult]:
        """Find the closest nodes to *vector* by cosine similarity (vec0 brute force)."""
        conn = self._require_conn()
        limit = int(limit)
        try:
            with self._lock:
                rows = conn.execute(
                    "SELECT node_id, distance FROM code_vec "
                    "WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
                    (sqlite_vec.serialize_float32(vector), limit),
                ).fetchall()
        except Exception:
            logger.warning(
                "vector_search failed — semantic search unavailable, degrading to "
                "keyword/FTS only (check embedding dimension vs the index)",
                exc_info=True,
            )
            return []

        if not rows:
            return []

        node_ids = [r[0] for r in rows]
        nodes = self._get_nodes_by_ids(node_ids)
        results: list[SearchResult] = []
        for node_id, distance in rows:
            node = nodes.get(node_id)
            similarity = 1.0 - float(distance)
            label_prefix = node_id.split(":", 1)[0] if node_id else ""
            results.append(
                SearchResult(
                    node_id=node_id,
                    score=similarity,
                    node_name=node.name if node else "",
                    file_path=node.file_path if node else "",
                    label=label_prefix,
                    snippet=(node.content[:200] if node and node.content else ""),
                )
            )
        return results

    # ------------------------------------------------------------------ reads

    def get_node(self, node_id: str) -> GraphNode | None:
        conn = self._require_conn()
        with self._lock:
            row = conn.execute(
                f"SELECT {_NODE_COLUMNS} FROM nodes WHERE id = ?", (node_id,)
            ).fetchone()
        return self._row_to_node(row) if row else None

    def _get_nodes_by_ids(self, node_ids: list[str]) -> dict[str, GraphNode]:
        conn = self._require_conn()
        out: dict[str, GraphNode] = {}
        unique = list(dict.fromkeys(node_ids))
        with self._lock:
            for i in range(0, len(unique), 500):
                batch = unique[i : i + 500]
                placeholders = ",".join("?" * len(batch))
                rows = conn.execute(
                    f"SELECT {_NODE_COLUMNS} FROM nodes WHERE id IN ({placeholders})",
                    batch,
                ).fetchall()
                for row in rows:
                    node = self._row_to_node(row)
                    if node is not None:
                        out[node.id] = node
        return out

    def get_callers(self, node_id: str) -> list[GraphNode]:
        """Return nodes that CALL the node identified by *node_id*."""
        return self._neighbor_nodes(node_id, RelType.CALLS, incoming=True)

    def get_callees(self, node_id: str) -> list[GraphNode]:
        """Return nodes called by the node identified by *node_id*."""
        return self._neighbor_nodes(node_id, RelType.CALLS, incoming=False)

    def get_type_refs(self, node_id: str) -> list[GraphNode]:
        """Return nodes referenced via USES_TYPE from *node_id*."""
        return self._neighbor_nodes(node_id, RelType.USES_TYPE, incoming=False)

    def _neighbor_nodes(
        self, node_id: str, rel_type: RelType, *, incoming: bool
    ) -> list[GraphNode]:
        conn = self._require_conn()
        if incoming:
            # nodes whose edge targets node_id -> return the source nodes
            query = (
                f"SELECT {self._prefixed_node_columns('n')} "
                f"FROM edges e JOIN nodes n ON n.id = e.source "
                f"WHERE e.target = ? AND e.rel_type = ?"
            )
        else:
            query = (
                f"SELECT {self._prefixed_node_columns('n')} "
                f"FROM edges e JOIN nodes n ON n.id = e.target "
                f"WHERE e.source = ? AND e.rel_type = ?"
            )
        with self._lock:
            rows = conn.execute(query, (node_id, rel_type.value)).fetchall()
        return [n for n in (self._row_to_node(r) for r in rows) if n is not None]

    def get_callers_with_confidence(self, node_id: str) -> list[tuple[GraphNode, float]]:
        """Return ``(node, confidence)`` for all callers of *node_id*."""
        return self._neighbor_nodes_with_confidence(node_id, incoming=True)

    def get_callees_with_confidence(self, node_id: str) -> list[tuple[GraphNode, float]]:
        """Return ``(node, confidence)`` for all callees of *node_id*."""
        return self._neighbor_nodes_with_confidence(node_id, incoming=False)

    def _neighbor_nodes_with_confidence(
        self, node_id: str, *, incoming: bool
    ) -> list[tuple[GraphNode, float]]:
        conn = self._require_conn()
        if incoming:
            query = (
                f"SELECT {self._prefixed_node_columns('n')}, e.confidence "
                f"FROM edges e JOIN nodes n ON n.id = e.source "
                f"WHERE e.target = ? AND e.rel_type = ?"
            )
        else:
            query = (
                f"SELECT {self._prefixed_node_columns('n')}, e.confidence "
                f"FROM edges e JOIN nodes n ON n.id = e.target "
                f"WHERE e.source = ? AND e.rel_type = ?"
            )
        with self._lock:
            rows = conn.execute(query, (node_id, RelType.CALLS.value)).fetchall()
        pairs: list[tuple[GraphNode, float]] = []
        for row in rows:
            node = self._row_to_node(row[:-1])
            if node is not None:
                confidence = float(row[-1]) if row[-1] is not None else 1.0
                pairs.append((node, confidence))
        return pairs

    _MAX_BFS_DEPTH = 10

    def traverse(self, start_id: str, depth: int, direction: str = "callers") -> list[GraphNode]:
        """BFS traversal through CALLS edges — flat node list (no depth info)."""
        return [node for node, _ in self.traverse_with_depth(start_id, depth, direction)]

    def traverse_with_depth(
        self,
        start_id: str,
        depth: int,
        direction: str = "callers",
        *,
        product_only: bool = False,
    ) -> list[tuple[GraphNode, int]]:
        """BFS traversal returning ``(node, hop_depth)`` pairs (1-based depth).

        Implemented as a recursive CTE over the ``edges`` table. ``direction``
        ``"callers"`` follows incoming CALLS (blast radius); ``"callees"`` follows
        outgoing CALLS (dependencies). The start node is excluded from results and
        each reachable node is reported at its shortest hop distance — matching the
        BFS semantics of :meth:`KuzuBackend.traverse_with_depth`.

        With ``product_only=True`` non-product nodes (per the shared classifier)
        are neither reported nor expanded — the traversal cannot tunnel through a
        test node. Classification lives in Python, so this path uses a per-level
        frontier BFS instead of the CTE.
        """
        conn = self._require_conn()
        depth = min(int(depth), self._MAX_BFS_DEPTH)
        if depth <= 0:
            return []

        if product_only:
            return self._traverse_product_only(start_id, depth, direction)

        if direction == "callers":
            # follow incoming CALLS: neighbour = source of an edge pointing at current
            step = "e.source"
            join_on = "e.target = tr.id"
        else:
            step = "e.target"
            join_on = "e.source = tr.id"

        cte = (
            f"WITH RECURSIVE tr(id, depth) AS ( "
            f"  SELECT ?, 0 "
            f"  UNION "
            f"  SELECT {step}, tr.depth + 1 "
            f"  FROM tr JOIN edges e ON {join_on} "
            f"  WHERE e.rel_type = ? AND tr.depth < ? "
            f") "
            f"SELECT id, MIN(depth) AS d FROM tr WHERE id <> ? GROUP BY id"
        )
        with self._lock:
            rows = conn.execute(
                cte, (start_id, RelType.CALLS.value, depth, start_id)
            ).fetchall()
        if not rows:
            return []

        node_map = self._get_nodes_by_ids([r[0] for r in rows])
        result: list[tuple[GraphNode, int]] = []
        for node_id, d in sorted(rows, key=lambda r: (r[1], r[0])):
            node = node_map.get(node_id)
            if node is not None:
                result.append((node, int(d)))
        return result

    def _traverse_product_only(
        self, start_id: str, depth: int, direction: str
    ) -> list[tuple[GraphNode, int]]:
        """Frontier BFS that reports and expands ONLY product nodes.

        The recursive CTE cannot call the Python path classifier, so product mode
        walks one hop per query (depth <= 10, so at most 10 queries). A non-product
        node is dropped from the frontier: depth cannot cross through a test file.
        """
        conn = self._require_conn()
        step_col, match_col = (
            ("source", "target") if direction == "callers" else ("target", "source")
        )

        visited: set[str] = {start_id}
        frontier: list[str] = [start_id]
        result: list[tuple[GraphNode, int]] = []

        for hop in range(1, depth + 1):
            placeholders = ",".join("?" for _ in frontier)
            query = (
                f"SELECT DISTINCT e.{step_col} FROM edges e "
                f"WHERE e.rel_type = ? AND e.{match_col} IN ({placeholders})"
            )
            with self._lock:
                rows = conn.execute(query, (RelType.CALLS.value, *frontier)).fetchall()
            next_ids = sorted(r[0] for r in rows if r[0] not in visited)
            if not next_ids:
                break
            visited.update(next_ids)
            node_map = self._get_nodes_by_ids(next_ids)
            frontier = []
            for nid in next_ids:
                node = node_map.get(nid)
                if node is None or not is_product(node.file_path or ""):
                    continue  # cut: neither reported nor expanded through
                result.append((node, hop))
                frontier.append(nid)
            if not frontier:
                break
        return result

    def get_inbound_cross_file_edges(
        self, file_path: str, exclude_source_files: set[str] | None = None
    ) -> list[GraphRelationship]:
        """Return inbound edges where the target is in *file_path* and the source is not."""
        conn = self._require_conn()
        exclude = exclude_source_files or set()
        edges: list[GraphRelationship] = []
        try:
            with self._lock:
                rows = conn.execute(
                    "SELECT s.id, s.file_path, t.id, e.rel_type, e.confidence, "
                    "e.role, e.step_number, e.strength, e.co_changes, e.symbols "
                    "FROM edges e "
                    "JOIN nodes t ON t.id = e.target "
                    "JOIN nodes s ON s.id = e.source "
                    "WHERE t.file_path = ? AND s.file_path <> ?",
                    (file_path, file_path),
                ).fetchall()
        except Exception:
            logger.warning(
                "Failed to query inbound cross-file edges for %s", file_path, exc_info=True
            )
            return edges

        for row in rows:
            src_file = row[1] or ""
            if src_file in exclude:
                continue
            rel = self._row_to_rel(
                src_id=row[0] or "",
                tgt_id=row[2] or "",
                rel_type_str=row[3] or "",
                confidence=row[4],
                role=row[5],
                step_number=row[6],
                strength=row[7],
                co_changes=row[8],
                symbols=row[9],
            )
            if rel is not None:
                edges.append(rel)
        return edges

    def get_process_memberships(self, node_ids: list[str]) -> dict[str, str]:
        """Return ``{node_id: process_name}`` for nodes belonging to a Process."""
        conn = self._require_conn()
        if not node_ids:
            return {}
        mapping: dict[str, str] = {}
        with self._lock:
            for i in range(0, len(node_ids), 500):
                batch = node_ids[i : i + 500]
                placeholders = ",".join("?" * len(batch))
                rows = conn.execute(
                    f"SELECT e.source, p.name FROM edges e "
                    f"JOIN nodes p ON p.id = e.target "
                    f"WHERE e.rel_type = ? AND p.label = ? "
                    f"AND e.source IN ({placeholders})",
                    [RelType.STEP_IN_PROCESS.value, NodeLabel.PROCESS.value, *batch],
                ).fetchall()
                for nid, pname in rows:
                    if nid and pname and nid not in mapping:
                        mapping[nid] = pname
        return mapping

    def get_indexed_files(self) -> dict[str, str]:
        """Return ``{file_path: sha256(content)}`` for all File nodes."""
        conn = self._require_conn()
        mapping: dict[str, str] = {}
        with self._lock:
            rows = conn.execute(
                "SELECT file_path, content FROM nodes WHERE label = ?",
                (NodeLabel.FILE.value,),
            ).fetchall()
        for fp, content in rows:
            mapping[fp or ""] = hashlib.sha256((content or "").encode()).hexdigest()
        return mapping

    def get_file_index(self) -> dict[str, str]:
        """Return ``{file_path: node_id}`` for all File nodes."""
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT file_path, id FROM nodes WHERE label = ?",
                (NodeLabel.FILE.value,),
            ).fetchall()
        return {fp: nid for fp, nid in rows}

    def get_symbol_name_index(self) -> dict[str, list[str]]:
        """Return ``{symbol_name: [node_id, ...]}`` for callable/type symbols."""
        conn = self._require_conn()
        index: dict[str, list[str]] = {}
        placeholders = ",".join("?" * len(_SYMBOL_INDEX_LABELS))
        with self._lock:
            rows = conn.execute(
                f"SELECT name, id FROM nodes WHERE label IN ({placeholders})",
                _SYMBOL_INDEX_LABELS,
            ).fetchall()
        for name, nid in rows:
            index.setdefault(name, []).append(nid)
        return index

    def load_graph(self) -> KnowledgeGraph:
        """Reconstruct a full :class:`KnowledgeGraph` from the database."""
        conn = self._require_conn()
        graph = KnowledgeGraph()
        with self._lock:
            node_rows = conn.execute(
                f"SELECT {_NODE_COLUMNS} FROM nodes"
            ).fetchall()
            edge_rows = conn.execute(
                "SELECT source, target, rel_type, confidence, role, step_number, "
                "strength, co_changes, symbols FROM edges"
            ).fetchall()

        for row in node_rows:
            node = self._row_to_node(row)
            if node is not None:
                graph.add_node(node)

        for row in edge_rows:
            rel = self._row_to_rel(
                src_id=row[0] or "",
                tgt_id=row[1] or "",
                rel_type_str=row[2] or "",
                confidence=row[3],
                role=row[4],
                step_number=row[5],
                strength=row[6],
                co_changes=row[7],
                symbols=row[8],
            )
            if rel is not None:
                graph.add_relationship(rel)
        return graph

    def execute_raw(self, query: str) -> list[list[Any]]:
        """Execute a raw SQL query on a READ-ONLY connection and return rows.

        Runs against `mode=ro` (see :meth:`_readonly_conn`), so this SQL-console
        entry point cannot mutate the store even if the route's keyword guard is
        bypassed. No commit — a read-only connection has nothing to commit.
        """
        conn = self._readonly_conn()
        with self._lock:
            cur = conn.execute(query)
            try:
                rows = cur.fetchall()
            except sqlite3.ProgrammingError:
                return []
        return [list(r) for r in rows]

    # ------------------------------------------------------------------ analytics

    def count_nodes_by_label(self) -> dict[str, int]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT label, count(*) FROM nodes GROUP BY label ORDER BY count(*) DESC"
            ).fetchall()
        return {(label or "unknown"): int(count) for label, count in rows}

    def count_edges_by_type(self) -> dict[str, int]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT rel_type, count(*) FROM edges GROUP BY rel_type "
                "ORDER BY count(*) DESC"
            ).fetchall()
        return {(rt or "unknown"): int(count) for rt, count in rows}

    def get_dead_code_symbols(self) -> list[tuple[str, str, str, int, str]]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT id, name, file_path, start_line FROM nodes "
                "WHERE is_dead = 1 ORDER BY file_path"
            ).fetchall()
        out: list[tuple[str, str, str, int, str]] = []
        for nid, name, file_path, start_line in rows:
            label = (nid or "").split(":", 1)[0]
            out.append((nid or "", name or "", file_path or "", int(start_line or 0), label))
        return out

    def get_coupling_pairs(self) -> list[tuple[str, str, str, str, float, int]]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT s.name, s.file_path, t.name, t.file_path, e.strength, e.co_changes "
                "FROM edges e JOIN nodes s ON s.id = e.source "
                "JOIN nodes t ON t.id = e.target "
                "WHERE e.rel_type = ?",
                (RelType.COUPLED_WITH.value,),
            ).fetchall()
        return [
            (sn or "", sf or "", tn or "", tf or "", float(strength or 0.0), int(cc or 0))
            for sn, sf, tn, tf, strength, cc in rows
        ]

    def get_coupling_strengths(self) -> list[float]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT strength FROM edges WHERE rel_type = ?",
                (RelType.COUPLED_WITH.value,),
            ).fetchall()
        return [float(r[0] or 0.0) for r in rows]

    def get_communities_with_members(
        self,
    ) -> list[tuple[str, str, float | None, list[str]]]:
        conn = self._require_conn()
        with self._lock:
            comms = conn.execute(
                "SELECT id, name, cohesion FROM nodes WHERE label = ?",
                (NodeLabel.COMMUNITY.value,),
            ).fetchall()
            out: list[tuple[str, str, float | None, list[str]]] = []
            for cid, name, cohesion in comms:
                members = conn.execute(
                    "SELECT source FROM edges WHERE target = ? AND rel_type = ?",
                    (cid, RelType.MEMBER_OF.value),
                ).fetchall()
                out.append(
                    (
                        cid or "",
                        name or "",
                        float(cohesion) if cohesion is not None else None,
                        [m[0] for m in members if m[0]],
                    )
                )
        return out

    def count_communities(self) -> int:
        conn = self._require_conn()
        with self._lock:
            row = conn.execute(
                "SELECT count(*) FROM nodes WHERE label = ?",
                (NodeLabel.COMMUNITY.value,),
            ).fetchone()
        return int(row[0] or 0) if row else 0

    def avg_calls_confidence(self) -> float | None:
        conn = self._require_conn()
        with self._lock:
            row = conn.execute(
                "SELECT avg(confidence) FROM edges WHERE rel_type = ?",
                (RelType.CALLS.value,),
            ).fetchone()
        return float(row[0]) if row and row[0] is not None else None

    def count_symbols_and_dead(self) -> tuple[int, int]:
        conn = self._require_conn()
        labels = (NodeLabel.FUNCTION.value, NodeLabel.METHOD.value, NodeLabel.CLASS.value)
        placeholders = ",".join("?" * len(labels))
        with self._lock:
            row = conn.execute(
                f"SELECT count(*), COALESCE(sum(is_dead), 0) FROM nodes "
                f"WHERE label IN ({placeholders}) AND start_line > 0",
                labels,
            ).fetchone()
        return (int(row[0] or 0), int(row[1] or 0)) if row else (0, 0)

    def count_embeddings(self) -> int:
        conn = self._require_conn()
        try:
            with self._lock:
                row = conn.execute("SELECT count(*) FROM code_vec").fetchone()
            return int(row[0] or 0) if row else 0
        except Exception:
            logger.debug("count_embeddings failed", exc_info=True)
            return 0

    def count_callables_in_processes(self) -> tuple[int, int]:
        conn = self._require_conn()
        labels = (NodeLabel.FUNCTION.value, NodeLabel.METHOD.value)
        placeholders = ",".join("?" * len(labels))
        with self._lock:
            total_row = conn.execute(
                f"SELECT count(*) FROM nodes WHERE label IN ({placeholders})", labels
            ).fetchone()
            in_proc_row = conn.execute(
                f"SELECT count(DISTINCT e.source) FROM edges e "
                f"JOIN nodes n ON n.id = e.source "
                f"WHERE e.rel_type = ? AND n.label IN ({placeholders})",
                (RelType.STEP_IN_PROCESS.value, *labels),
            ).fetchone()
        return (
            int(total_row[0] or 0) if total_row else 0,
            int(in_proc_row[0] or 0) if in_proc_row else 0,
        )

    def get_file_nodes(self) -> list[tuple[str, str, str, str]]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT id, name, file_path, language FROM nodes WHERE label = ?",
                (NodeLabel.FILE.value,),
            ).fetchall()
        return [(i or "", n or "", fp or "", lang or "") for i, n, fp, lang in rows]

    def get_symbol_counts_by_file(self) -> dict[str, int]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT file_path, count(*) FROM nodes "
                "WHERE file_path <> '' AND start_line > 0 GROUP BY file_path"
            ).fetchall()
        return {fp: int(count) for fp, count in rows if fp}

    def get_processes_with_steps(
        self,
    ) -> list[tuple[str, str, list[str], list[int | None]]]:
        conn = self._require_conn()
        with self._lock:
            procs = conn.execute(
                "SELECT id, name FROM nodes WHERE label = ? ORDER BY name",
                (NodeLabel.PROCESS.value,),
            ).fetchall()
            out: list[tuple[str, str, list[str], list[int | None]]] = []
            for pid, name in procs:
                steps = conn.execute(
                    "SELECT source, step_number FROM edges "
                    "WHERE target = ? AND rel_type = ?",
                    (pid, RelType.STEP_IN_PROCESS.value),
                ).fetchall()
                node_ids = [s[0] for s in steps if s[0]]
                step_numbers = [
                    (int(s[1]) if s[1] is not None else None) for s in steps if s[0]
                ]
                out.append((pid or "", name or "", node_ids, step_numbers))
        return out

    def get_symbols_in_file(self, file_path: str) -> list[GraphNode]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                f"SELECT {_NODE_COLUMNS} FROM nodes "
                f"WHERE file_path = ? AND start_line > 0 ORDER BY start_line",
                (file_path,),
            ).fetchall()
        return [n for n in (self._row_to_node(r) for r in rows) if n is not None]

    def get_file_imports(self, file_path: str) -> list[str]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT t.file_path FROM edges e "
                "JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target "
                "WHERE s.file_path = ? AND s.label = ? AND t.label = ? "
                "AND e.rel_type = ? ORDER BY t.file_path",
                (file_path, NodeLabel.FILE.value, NodeLabel.FILE.value, RelType.IMPORTS.value),
            ).fetchall()
        return [r[0] for r in rows if r[0]]

    def get_file_importers(self, file_path: str) -> list[str]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT s.file_path FROM edges e "
                "JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target "
                "WHERE t.file_path = ? AND s.label = ? AND t.label = ? "
                "AND e.rel_type = ? ORDER BY s.file_path",
                (file_path, NodeLabel.FILE.value, NodeLabel.FILE.value, RelType.IMPORTS.value),
            ).fetchall()
        return [r[0] for r in rows if r[0]]

    def get_file_coupling(self, file_path: str) -> list[tuple[str, float, int]]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT CASE WHEN s.file_path = ? THEN t.file_path ELSE s.file_path END, "
                "e.strength, e.co_changes "
                "FROM edges e JOIN nodes s ON s.id = e.source "
                "JOIN nodes t ON t.id = e.target "
                "WHERE e.rel_type = ? AND s.label = ? AND t.label = ? "
                "AND (s.file_path = ? OR t.file_path = ?) "
                "ORDER BY e.strength DESC",
                (
                    file_path,
                    RelType.COUPLED_WITH.value,
                    NodeLabel.FILE.value,
                    NodeLabel.FILE.value,
                    file_path,
                    file_path,
                ),
            ).fetchall()
        return [(other or "", float(s or 0.0), int(cc or 0)) for other, s, cc in rows]

    def get_heritage(self, node_id: str) -> list[tuple[str, str, str]]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT p.name, p.file_path, e.rel_type FROM edges e "
                "JOIN nodes p ON p.id = e.target "
                "WHERE e.source = ? AND e.rel_type IN (?, ?)",
                (node_id, RelType.EXTENDS.value, RelType.IMPLEMENTS.value),
            ).fetchall()
        return [(n or "", fp or "", rt or "") for n, fp, rt in rows]

    def get_node_communities(self, node_id: str) -> list[str]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT c.name FROM edges e JOIN nodes c ON c.id = e.target "
                "WHERE e.source = ? AND e.rel_type = ? AND c.label = ?",
                (node_id, RelType.MEMBER_OF.value, NodeLabel.COMMUNITY.value),
            ).fetchall()
        return [r[0] for r in rows if r[0]]

    def get_node_processes(self, node_id: str) -> list[str]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT p.name FROM edges e JOIN nodes p ON p.id = e.target "
                "WHERE e.source = ? AND e.rel_type = ? AND p.label = ?",
                (node_id, RelType.STEP_IN_PROCESS.value, NodeLabel.PROCESS.value),
            ).fetchall()
        return [r[0] for r in rows if r[0]]

    def get_community_members(
        self, name: str
    ) -> list[tuple[str, str, str, int, bool, bool]]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT n.name, n.id, n.file_path, n.start_line, "
                "n.is_entry_point, n.is_exported "
                "FROM edges e JOIN nodes n ON n.id = e.source "
                "JOIN nodes c ON c.id = e.target "
                "WHERE c.label = ? AND c.name = ? AND e.rel_type = ? "
                "ORDER BY n.file_path, n.start_line, n.name, n.id",
                (NodeLabel.COMMUNITY.value, name, RelType.MEMBER_OF.value),
            ).fetchall()
        out: list[tuple[str, str, str, int, bool, bool]] = []
        for nm, nid, fp, sl, entry, exported in rows:
            label = (nid or "").split(":", 1)[0]
            out.append(
                (nm or "", label, fp or "", int(sl or 0), bool(entry), bool(exported))
            )
        # Deterministic order independent of the backend's ORDER BY (cross-backend
        # parity: kuzu does not reliably honor ORDER BY on this traversal).
        out.sort(key=lambda t: (t[2], t[3], t[0]))
        return out

    def get_communities_summary(self) -> list[tuple[str, float, str]]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT name, cohesion, properties_json FROM nodes "
                "WHERE label = ? ORDER BY cohesion DESC",
                (NodeLabel.COMMUNITY.value,),
            ).fetchall()
        return [(n or "", float(c) if c is not None else 0.0, pj or "") for n, c, pj in rows]

    def get_cross_community_processes(self) -> list[tuple[str, list[str]]]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT p.name, c.name FROM edges sp "
                "JOIN nodes p ON p.id = sp.target AND p.label = ? "
                "JOIN edges mo ON mo.source = sp.source AND mo.rel_type = ? "
                "JOIN nodes c ON c.id = mo.target AND c.label = ? "
                "WHERE sp.rel_type = ?",
                (
                    NodeLabel.PROCESS.value,
                    RelType.MEMBER_OF.value,
                    NodeLabel.COMMUNITY.value,
                    RelType.STEP_IN_PROCESS.value,
                ),
            ).fetchall()
        by_proc: dict[str, set[str]] = {}
        for proc, comm in rows:
            if proc and comm:
                by_proc.setdefault(proc, set()).add(comm)
        return [
            (proc, sorted(comms)) for proc, comms in by_proc.items() if len(comms) > 1
        ]

    def get_file_community_counts(self, file_path: str) -> list[tuple[str, int]]:
        conn = self._require_conn()
        with self._lock:
            rows = conn.execute(
                "SELECT c.name, count(*) FROM edges e "
                "JOIN nodes n ON n.id = e.source JOIN nodes c ON c.id = e.target "
                "WHERE n.file_path = ? AND e.rel_type = ? AND c.label = ? "
                "GROUP BY c.name ORDER BY count(*) DESC",
                (file_path, RelType.MEMBER_OF.value, NodeLabel.COMMUNITY.value),
            ).fetchall()
        return [(n or "", int(count)) for n, count in rows]

    # ------------------------------------------------------------------ CLI read path

    def content_contains_any(self, tokens: list[str], limit: int) -> list[dict[str, Any]]:
        """Nodes whose ``content`` contains ANY of *tokens* (case-insensitive substring).

        Returns up to *limit* dicts with the full ``id``/``name``/``file_path``/``content``,
        ordered by ``id``. Folder/community/process nodes are excluded. Mirrors
        :meth:`KuzuBackend.content_contains_any` exactly so results are backend-identical.
        """
        conn = self._require_conn()
        limit = int(limit)
        toks = [t for t in tokens if t]
        if not toks:
            return []
        like_clause = " OR ".join("lower(content) LIKE ? ESCAPE '\\'" for _ in toks)
        label_ph = ",".join("?" * len(_NON_SEARCHABLE_LABELS))
        params: list[Any] = [f"%{_like_escape(t.lower())}%" for t in toks]
        params += sorted(_NON_SEARCHABLE_LABELS)
        with self._lock:
            rows = conn.execute(
                f"SELECT id, name, file_path, content FROM nodes "
                f"WHERE ({like_clause}) AND label NOT IN ({label_ph}) "
                f"ORDER BY id LIMIT ?",
                [*params, limit],
            ).fetchall()
        return [
            {
                "id": r[0] or "",
                "name": r[1] or "",
                "file_path": r[2] or "",
                "content": r[3] or "",
            }
            for r in rows
        ]

    def files_containing(
        self, tokens: list[str], per_token_limit: int
    ) -> dict[str, list[str]]:
        """Distinct file paths whose FILE-node content contains each token (per-token budget)."""
        conn = self._require_conn()
        per_token_limit = int(per_token_limit)
        out: dict[str, list[str]] = {}
        with self._lock:
            for token in tokens:
                if not token:
                    continue
                rows = conn.execute(
                    "SELECT DISTINCT file_path FROM nodes "
                    "WHERE label = 'file' AND file_path != '' "
                    "AND lower(content) LIKE ? ESCAPE '\\' "
                    "ORDER BY file_path LIMIT ?",
                    [f"%{_like_escape(token.lower())}%", per_token_limit],
                ).fetchall()
                out[token] = [r[0] for r in rows]
        return out

    def flows_for_symbol(self, node_id: str) -> dict[str, list[dict[str, Any]]]:
        """Process flows *node_id* is a step in, with each flow's ordered, named steps."""
        conn = self._require_conn()
        with self._lock:
            proc_rows = conn.execute(
                "SELECT p.id, p.name FROM edges e JOIN nodes p ON p.id = e.target "
                "WHERE e.source = ? AND e.rel_type = ? AND p.label = ? "
                "ORDER BY p.name, p.id",
                (node_id, RelType.STEP_IN_PROCESS.value, NodeLabel.PROCESS.value),
            ).fetchall()
            processes = [{"id": pid or "", "name": pname or ""} for pid, pname in proc_rows]
            steps: list[dict[str, Any]] = []
            if proc_rows:
                proc_ids = [pid for pid, _ in proc_rows]
                ph = ",".join("?" * len(proc_ids))
                step_rows = conn.execute(
                    f"SELECT n.id, n.name, n.file_path, n.start_line, e.step_number "
                    f"FROM edges e JOIN nodes n ON n.id = e.source "
                    f"WHERE e.target IN ({ph}) AND e.rel_type = ? "
                    f"ORDER BY e.step_number, n.id",
                    [*proc_ids, RelType.STEP_IN_PROCESS.value],
                ).fetchall()
                seen: set[str] = set()
                for sid, sname, sfile, sline, snum in step_rows:
                    sid = sid or ""
                    if sid in seen:
                        continue
                    seen.add(sid)
                    steps.append(
                        {
                            "id": sid,
                            "name": sname or "",
                            "file_path": sfile or "",
                            "start_line": int(sline or 0),
                            "step_number": int(snum) if snum is not None else None,
                        }
                    )
        return {"processes": processes, "steps": steps}

    def symbols_by_label(self, labels: list[str], limit: int) -> list[dict[str, Any]]:
        """Symbol nodes for the given lowercase *labels*, ordered by (file, line, id)."""
        conn = self._require_conn()
        limit = int(limit)
        labs = [lab for lab in labels if lab]
        if not labs:
            return []
        ph = ",".join("?" * len(labs))
        with self._lock:
            rows = conn.execute(
                f"SELECT id, label, name, file_path, start_line, end_line, class_name, "
                f"is_entry_point, is_exported, signature FROM nodes "
                f"WHERE label IN ({ph}) ORDER BY file_path, start_line, id LIMIT ?",
                [*labs, limit],
            ).fetchall()
        return [
            {
                "id": r[0] or "",
                "label": r[1] or "",
                "name": r[2] or "",
                "file_path": r[3] or "",
                "start_line": int(r[4] or 0),
                "end_line": int(r[5] or 0),
                "class_name": r[6] or "",
                "is_entry_point": bool(r[7]),
                "is_exported": bool(r[8]),
                "signature": r[9] or "",
            }
            for r in rows
        ]

    # ------------------------------------------------------------------ search

    def fts_search(self, query: str, limit: int) -> list[SearchResult]:
        """BM25 full-text search over name/content/signature via FTS5."""
        conn = self._require_conn()
        limit = int(limit)
        match = _build_fts_match(query)
        if match is None:
            return []
        placeholders = ",".join("?" * len(_NON_SEARCHABLE_LABELS))
        sql = (
            "SELECT n.id, n.name, n.file_path, n.content, n.signature, "
            "bm25(nodes_fts) AS rank "
            "FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid "
            f"WHERE nodes_fts MATCH ? AND n.label NOT IN ({placeholders}) "
            "ORDER BY rank LIMIT ?"
        )
        try:
            with self._lock:
                rows = conn.execute(
                    sql,
                    [match, *sorted(_NON_SEARCHABLE_LABELS), limit * 4],
                ).fetchall()
        except Exception:
            logger.debug("fts_search failed", exc_info=True)
            return []

        candidates: list[SearchResult] = []
        for node_id, name, file_path, content, signature, rank in rows:
            node_id = node_id or ""
            file_path = file_path or ""
            # FTS5 bm25 is more negative for better matches; flip to higher-is-better.
            score = -float(rank) if rank is not None else 0.0
            if "/tests/" in file_path or "/test_" in file_path:
                score *= 0.5
            label_prefix = node_id.split(":", 1)[0] if node_id else ""
            if label_prefix in ("function", "class") and "/tests/" not in file_path:
                score *= 1.2
            snippet = (content or "")[:200] or (signature or "")[:200]
            candidates.append(
                SearchResult(
                    node_id=node_id,
                    score=score,
                    node_name=name or "",
                    file_path=file_path,
                    label=label_prefix,
                    snippet=snippet,
                )
            )
        candidates.sort(key=lambda r: (-r.score, r.node_id))
        return candidates[:limit]

    def fuzzy_search(
        self, query: str, limit: int, max_distance: int = 2
    ) -> list[SearchResult]:
        """Fuzzy name search by Levenshtein edit distance (pure Python)."""
        conn = self._require_conn()
        limit = int(limit)
        max_distance = int(max_distance)
        needle = query.lower()
        placeholders = ",".join("?" * len(_NON_SEARCHABLE_LABELS))
        with self._lock:
            rows = conn.execute(
                f"SELECT id, name, file_path, content FROM nodes "
                f"WHERE label NOT IN ({placeholders})",
                sorted(_NON_SEARCHABLE_LABELS),
            ).fetchall()

        candidates: list[SearchResult] = []
        for node_id, name, file_path, content in rows:
            dist = _levenshtein((name or "").lower(), needle, max_distance)
            if dist > max_distance:
                continue
            score = max(0.3, 1.0 - (dist * 0.3))
            label_prefix = (node_id or "").split(":", 1)[0]
            candidates.append(
                SearchResult(
                    node_id=node_id or "",
                    score=score,
                    node_name=name or "",
                    file_path=file_path or "",
                    label=label_prefix,
                    snippet=(content or "")[:200],
                )
            )
        candidates.sort(key=lambda r: (-r.score, r.node_id))
        return candidates[:limit]

    def name_contains_search(self, token: str, limit: int = 20) -> list[SearchResult]:
        """Symbols whose ``name`` CONTAINS *token* (case-insensitive substring).

        The retrieval channel FTS can't provide: `router` must reach `APIRouter`,
        but FTS tokenizes the name as one token and never prefix-matches inside it
        (dogfood cycle-2 N9). Public (non-underscore) names rank first, then
        shorter names (tighter matches), then declarations before members.
        """
        conn = self._require_conn()
        limit = int(limit)
        if not token:
            return []
        placeholders = ",".join("?" * len(_NON_SEARCHABLE_LABELS))
        with self._lock:
            rows = conn.execute(
                f"SELECT id, name, file_path, content FROM nodes "
                f"WHERE lower(name) LIKE ? ESCAPE '\\' AND label NOT IN ({placeholders})",
                [f"%{_like_escape(token.lower())}%", *sorted(_NON_SEARCHABLE_LABELS)],
            ).fetchall()

        ranked: list[tuple[int, int, int, SearchResult]] = []
        for node_id, sym_name, file_path, content in rows:
            node_id = node_id or ""
            sym_name = sym_name or ""
            label_prefix = node_id.split(":", 1)[0] if node_id else ""
            private = 1 if sym_name.startswith(("_", "#")) else 0
            decl_rank = 0 if label_prefix in ("class", "interface") else 1
            ranked.append(
                (
                    private,
                    len(sym_name),
                    decl_rank,
                    SearchResult(
                        node_id=node_id,
                        score=0.5,
                        node_name=sym_name,
                        file_path=file_path or "",
                        label=label_prefix,
                        snippet=(content or "")[:200],
                    ),
                )
            )
        ranked.sort(key=lambda t: (t[0], t[1], t[2], t[3].node_id))
        return [r for _, _, _, r in ranked[:limit]]

    def exact_name_search(self, name: str, limit: int = 5) -> list[SearchResult]:
        """Symbols whose ``name`` equals *name* exactly (case-insensitive).

        Executable symbols (function/method) rank ahead of types/classes; non-test
        ahead of test; a shorter body ahead of a larger one. Mirrors
        :meth:`KuzuBackend.exact_name_search`.
        """
        conn = self._require_conn()
        limit = int(limit)
        placeholders = ",".join("?" * len(_NON_SEARCHABLE_LABELS))
        with self._lock:
            rows = conn.execute(
                f"SELECT id, name, file_path, content, signature FROM nodes "
                f"WHERE lower(name) = lower(?) AND label NOT IN ({placeholders})",
                [name, *sorted(_NON_SEARCHABLE_LABELS)],
            ).fetchall()

        ranked: list[tuple[int, int, SearchResult]] = []
        for node_id, sym_name, file_path, content, signature in rows:
            node_id = node_id or ""
            file_path = file_path or ""
            label_prefix = node_id.split(":", 1)[0] if node_id else ""
            is_test = _is_deprioritized_result_path(file_path)
            exec_rank = 0 if label_prefix in ("function", "method") else 1
            ranked.append(
                (
                    exec_rank + (10 if is_test else 0),
                    len(content or ""),
                    SearchResult(
                        node_id=node_id,
                        score=1.0,
                        node_name=sym_name or "",
                        file_path=file_path,
                        label=label_prefix,
                        snippet=(content or "")[:200] or (signature or "")[:200],
                    ),
                )
            )
        ranked.sort(key=lambda t: (t[0], t[1], t[2].node_id))
        return [r for _, _, r in ranked][:limit]

    def exact_content_search(self, token: str, limit: int) -> list[SearchResult]:
        """Nodes whose raw content contains ``token`` verbatim (HOR-329 parity)."""
        conn = self._require_conn()
        limit = int(limit)
        escaped = _like_escape(token)
        placeholders = ",".join("?" * len(_NON_SEARCHABLE_LABELS))
        with self._lock:
            rows = conn.execute(
                f"SELECT id, name, file_path, content, signature FROM nodes "
                f"WHERE content LIKE ? ESCAPE '\\' AND label NOT IN ({placeholders}) "
                f"LIMIT ?",
                [f"%{escaped}%", *sorted(_NON_SEARCHABLE_LABELS), limit * 5],
            ).fetchall()

        ranked: list[tuple[int, int, SearchResult]] = []
        for node_id, name, file_path, content, signature in rows:
            node_id = node_id or ""
            file_path = file_path or ""
            label_prefix = node_id.split(":", 1)[0] if node_id else ""
            is_test = _is_deprioritized_result_path(file_path)
            exec_rank = 0 if label_prefix in ("function", "method") else 1
            ranked.append(
                (
                    exec_rank + (10 if is_test else 0),
                    len(content or ""),
                    SearchResult(
                        node_id=node_id,
                        score=1.0,
                        node_name=name or "",
                        file_path=file_path,
                        label=label_prefix,
                        snippet=(content or "")[:200] or (signature or "")[:200],
                    ),
                )
            )
        ranked.sort(key=lambda t: (t[0], t[1], t[2].node_id))
        return [r for _, _, r in ranked][:limit]

    def colocated_codes(self, token: str, limit: int = 6) -> list[str]:
        """Logical keys co-located with a display code in a constants object (HOR-329)."""
        conn = self._require_conn()
        escaped = _like_escape(token)
        placeholders = ",".join("?" * len(_NON_SEARCHABLE_LABELS))
        out: list[str] = []
        seen: set[str] = set()
        with self._lock:
            rows = conn.execute(
                f"SELECT content FROM nodes "
                f"WHERE content LIKE ? ESCAPE '\\' AND label NOT IN ({placeholders}) "
                f"LIMIT ?",
                [f"%{escaped}%", *sorted(_NON_SEARCHABLE_LABELS), 25],
            ).fetchall()
        for (content,) in rows:
            for key in _colocated_code_tokens(content or "", token):
                if key not in seen:
                    seen.add(key)
                    out.append(key)
                    if len(out) >= limit:
                        return out
        return out

    def decorator_arg_search(self, value: str, limit: int) -> list[SearchResult]:
        """Symbols whose decorator carries *value* as a string-literal argument."""
        conn = self._require_conn()
        limit = int(limit)
        needle = value.casefold()
        escaped = _like_escape(value.lower())
        placeholders = ",".join("?" * len(_NON_SEARCHABLE_LABELS))
        with self._lock:
            rows = conn.execute(
                f"SELECT id, name, file_path, content, signature, properties_json "
                f"FROM nodes "
                f"WHERE lower(properties_json) LIKE ? ESCAPE '\\' "
                f"AND label NOT IN ({placeholders}) LIMIT ?",
                [f"%{escaped}%", *sorted(_NON_SEARCHABLE_LABELS), limit * 5],
            ).fetchall()

        ranked: list[tuple[int, SearchResult]] = []
        seen: set[str] = set()
        for node_id, name, file_path, content, signature, props_json in rows:
            node_id = node_id or ""
            if node_id in seen:
                continue
            args = _decorator_args_from_json(props_json or "")
            if not any(a.casefold() == needle for a in args):
                continue
            seen.add(node_id)
            file_path = file_path or ""
            label_prefix = node_id.split(":", 1)[0] if node_id else ""
            is_test = _is_deprioritized_result_path(file_path)
            exec_rank = 0 if label_prefix in ("function", "method") else 1
            ranked.append(
                (
                    exec_rank + (10 if is_test else 0),
                    SearchResult(
                        node_id=node_id,
                        score=1.0,
                        node_name=name or "",
                        file_path=file_path,
                        label=label_prefix,
                        snippet=(content or "")[:200] or (signature or "")[:200],
                    ),
                )
            )
        ranked.sort(key=lambda t: (t[0], t[1].node_id))
        return [r for _, r in ranked][:limit]

    # ------------------------------------------------------------------ helpers

    @staticmethod
    def _prefixed_node_columns(alias: str) -> str:
        return ", ".join(f"{alias}.{col.strip()}" for col in _NODE_COLUMNS.split(","))

    @staticmethod
    def _node_to_row(node: GraphNode) -> tuple[Any, ...]:
        props = node.properties or {}
        return (
            node.id,
            node.label.value,
            node.name,
            node.file_path,
            node.start_line,
            node.end_line,
            node.content,
            node.signature,
            node.language,
            node.class_name,
            1 if node.is_dead else 0,
            1 if node.is_entry_point else 0,
            1 if node.is_exported else 0,
            props.get("cohesion"),
            _serialize_extra_props(props),
        )

    @staticmethod
    def _rel_to_row(rel: GraphRelationship) -> tuple[Any, ...]:
        props = rel.properties or {}
        return (
            rel.source,
            rel.target,
            rel.type.value,
            float(props.get("confidence", 1.0)),
            str(props.get("role", "")),
            int(props.get("step_number", 0)),
            float(props.get("strength", 0.0)),
            int(props.get("co_changes", 0)),
            str(props.get("symbols", "")),
        )

    @staticmethod
    def _row_to_node(row: Any) -> GraphNode | None:
        """Convert a ``nodes`` row (column order = ``_NODE_COLUMNS``) into a GraphNode."""
        if row is None:
            return None
        try:
            node_id = row[0]
            label = _LABEL_MAP.get(row[1]) or _LABEL_MAP.get(node_id.split(":", 1)[0])
            if label is None:
                logger.warning("Unknown node label %r in id %s", row[1], node_id)
                return None

            props: dict[str, Any] = {}
            if row[13] is not None:
                props["cohesion"] = float(row[13])
            if row[14]:
                try:
                    extra = json.loads(row[14])
                    if isinstance(extra, dict):
                        props.update(extra)
                except (ValueError, TypeError):
                    pass

            return GraphNode(
                id=node_id,
                label=label,
                name=row[2] or "",
                file_path=row[3] or "",
                start_line=row[4] or 0,
                end_line=row[5] or 0,
                content=row[6] or "",
                signature=row[7] or "",
                language=row[8] or "",
                class_name=row[9] or "",
                is_dead=bool(row[10]),
                is_entry_point=bool(row[11]),
                is_exported=bool(row[12]),
                properties=props,
            )
        except (IndexError, KeyError, AttributeError):
            logger.debug("Failed to convert row to GraphNode: %s", row, exc_info=True)
            return None

    @staticmethod
    def _row_to_rel(
        *,
        src_id: str,
        tgt_id: str,
        rel_type_str: str,
        confidence: Any,
        role: Any,
        step_number: Any,
        strength: Any,
        co_changes: Any,
        symbols: Any,
    ) -> GraphRelationship | None:
        rel_type = _REL_TYPE_MAP.get(rel_type_str)
        if rel_type is None:
            return None
        props: dict[str, Any] = {}
        if confidence is not None:
            props["confidence"] = float(confidence)
        if role is not None and role != "":
            props["role"] = str(role)
        if step_number is not None and step_number != 0:
            props["step_number"] = int(step_number)
        if strength is not None and strength != 0.0:
            props["strength"] = float(strength)
        if co_changes is not None and co_changes != 0:
            props["co_changes"] = int(co_changes)
        if symbols is not None and symbols != "":
            props["symbols"] = str(symbols)
        return GraphRelationship(
            id=f"{rel_type_str}:{src_id}->{tgt_id}",
            type=rel_type,
            source=src_id,
            target=tgt_id,
            properties=props,
        )
