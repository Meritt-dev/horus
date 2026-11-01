"""Dedicated vector index for Horus Memory claims (M2, spec §4 / 1b).

``MemoryVectorStore`` is a small, self-contained SQLite store that holds embedding
vectors for authored memory *claims*, keyed by the ``memory_id`` that joins them
back to the authoritative Postgres record on the TS side. It is the Python half
of the ``MemoryVectorIndex`` seam.

Since the kùzu→SQLite migration (HOR-392) this is a ``sqlite-vec`` ``vec0`` index
partitioned by ``repo`` (so a repo's claim search never scans another's vectors),
plus a plain ``mem_meta`` KV table for the mirrored claim metadata.

Why a separate store (not the code graph):
- The code graph is fully rebuilt on each re-analyze — authored memory living in
  that store would be destroyed. A dedicated file (``.horus/source/memory.db``)
  gives memory its OWN connection/lock, fully decoupled from the code-graph
  writer and immune to re-analyze.
- The code vector index is an unpartitioned full cosine scan; mixing claims in
  would pollute and slow code search.

Invariants honored here:
- Vectors are a DERIVED, rebuildable index. The TS Postgres record is the source
  of truth; if this store is lost it is rebuilt by replaying ``claim`` text.
- Vectors are LOCAL-ONLY — this store is never part of any cloud-sync path.
- Embeddings reuse the shared nomic embedder (same 384-dim, scheme and
  content-hash cache, HOR-374 thread pin) so claim vectors live in the identical
  space as code vectors.
- A SINGLE serialized writer (one lock guarding the connection) makes concurrent
  upserts safe; reads tolerate a not-yet-indexed claim by simply returning fewer
  hits (the TS caller degrades to Jaccard).
- Only ``repo`` + ``claim_hash``/``scheme_version``/``model`` are mirrored —
  status/visibility/tenancy stay authoritative in TS to avoid drift.
"""

from __future__ import annotations

import hashlib
import logging
import sqlite3
import struct
import threading
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

import sqlite_vec

from horus_source.core.embeddings.embedder import (
    _DEFAULT_MODEL,
    EMBEDDING_SCHEME_VERSION,
    embed_query,
    embed_text_document,
)
from horus_source.core.storage.base import EMBEDDING_DIMENSIONS

logger = logging.getLogger(__name__)

# A single SQLite file, sibling to (but independent of) the code-graph store, so
# it has its own connection and is untouched by code re-analyze.
MEMORY_DB_NAME = "memory.db"


def claim_hash(claim: str) -> str:
    """Stable content hash of a claim's raw text (drift / dedupe signal)."""
    return hashlib.sha256((claim or "").encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class MemoryClaim:
    """A claim to (re)index. ``model`` defaults to the shared nomic model."""

    memory_id: str
    claim: str
    repo: str
    model: str = _DEFAULT_MODEL


@dataclass(frozen=True)
class MemorySearchHit:
    """A single nearest-claim result: the join key + cosine similarity."""

    memory_id: str
    score: float


class MemoryVectorStore:
    """Single-writer SQLite (sqlite-vec) store for memory claim embeddings.

    Usage::

        store = MemoryVectorStore()
        store.initialize(MemoryVectorStore.db_path_for_repo(repo_path))
        store.upsert("mem_01H...", "auth uses JWT in middleware", repo="acme/app")
        hits = store.search("how does auth work", repo="acme/app", limit=5)
        store.close()
    """

    def __init__(self) -> None:
        self._conn: sqlite3.Connection | None = None
        # ONE lock serializes every connection use — writes must be a single
        # serialized stream (the memory store's sole writer discipline).
        self._lock = threading.RLock()
        self._read_only = False

    # ------------------------------------------------------------------ paths
    @staticmethod
    def db_path_for_repo(repo_path: Path) -> Path:
        """The dedicated memory DB file for *repo_path* (``.horus/source/memory.db``)."""
        return repo_path / ".horus" / "source" / MEMORY_DB_NAME

    # ------------------------------------------------------------- lifecycle
    def initialize(
        self,
        path: Path,
        *,
        read_only: bool = False,
        max_retries: int = 0,  # noqa: ARG002 - accepted for call-site parity
        retry_delay: float = 0.3,  # noqa: ARG002 - accepted for call-site parity
    ) -> None:
        """Open or create the memory DB at *path*.

        Schema is created only when writable. ``max_retries``/``retry_delay`` are
        accepted for parity with the previous kùzu signature but unused (SQLite's
        WAL mode allows a writer and concurrent readers without lock retries).
        """
        path = Path(path)
        self._read_only = read_only
        if read_only:
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, check_same_thread=False)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(path), check_same_thread=False)

        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)

        if not read_only:
            conn.execute("PRAGMA journal_mode=WAL")
        self._conn = conn
        if not read_only:
            self._create_schema()

    def close(self) -> None:
        """Close the connection, freeing the file lock."""
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.close()
                except Exception:
                    logger.debug("MemoryVectorStore close failed", exc_info=True)
                self._conn = None

    def __enter__(self) -> "MemoryVectorStore":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _require_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            raise RuntimeError("MemoryVectorStore.initialize() must be called before use")
        return self._conn

    def _require_writable(self) -> sqlite3.Connection:
        if self._read_only:
            raise RuntimeError("MemoryVectorStore is read-only; writes require the host RW owner")
        return self._require_conn()

    def _create_schema(self) -> None:
        conn = self._require_conn()
        conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS mem_vec USING vec0("
            f"memory_id TEXT PRIMARY KEY, "
            f"repo TEXT partition key, "
            f"embedding float[{EMBEDDING_DIMENSIONS}] distance_metric=cosine)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS mem_meta ("
            "memory_id TEXT PRIMARY KEY, repo TEXT, claim_hash TEXT, "
            "scheme_version INTEGER, model TEXT)"
        )
        conn.commit()

    # ----------------------------------------------------------------- writes
    def upsert(
        self,
        memory_id: str,
        claim: str,
        repo: str,
        *,
        model: str = _DEFAULT_MODEL,
    ) -> bool:
        """Embed *claim* and upsert its vector + metadata. Best-effort.

        Returns ``True`` when a vector was written, ``False`` when the claim
        could not be embedded (empty text or embedder failure) — in which case
        the store is left untouched and the caller falls back to lexical recall.
        """
        if not memory_id or not repo:
            return False
        vec = embed_text_document(claim, model_name=model)
        if vec is None:
            logger.debug("memory upsert skipped (no embedding) for %s", memory_id)
            return False
        h = claim_hash(claim)
        with self._lock:
            conn = self._require_writable()
            conn.execute("DELETE FROM mem_vec WHERE memory_id = ?", (memory_id,))
            conn.execute(
                "INSERT INTO mem_vec(memory_id, repo, embedding) VALUES (?, ?, ?)",
                (memory_id, repo, sqlite_vec.serialize_float32(vec)),
            )
            conn.execute(
                "INSERT OR REPLACE INTO mem_meta("
                "memory_id, repo, claim_hash, scheme_version, model) "
                "VALUES (?, ?, ?, ?, ?)",
                (memory_id, repo, h, EMBEDDING_SCHEME_VERSION, model),
            )
            conn.commit()
        return True

    def upsert_many(self, claims: Iterable[MemoryClaim]) -> int:
        """Upsert a batch of claims; returns the number actually indexed."""
        n = 0
        for c in claims:
            if self.upsert(c.memory_id, c.claim, c.repo, model=c.model):
                n += 1
        return n

    def remove(self, memory_id: str) -> None:
        """Delete a claim's vector + metadata. Idempotent / best-effort."""
        if not memory_id:
            return
        with self._lock:
            conn = self._require_writable()
            conn.execute("DELETE FROM mem_vec WHERE memory_id = ?", (memory_id,))
            conn.execute("DELETE FROM mem_meta WHERE memory_id = ?", (memory_id,))
            conn.commit()

    # ------------------------------------------------------------------ reads
    def count(self) -> int:
        """Number of indexed claim vectors."""
        with self._lock:
            conn = self._require_conn()
            row = conn.execute("SELECT count(*) FROM mem_meta").fetchone()
        return int(row[0] or 0) if row else 0

    def get_meta(self, memory_id: str) -> dict | None:
        """Return the mirrored metadata for *memory_id*, or ``None``."""
        with self._lock:
            conn = self._require_conn()
            row = conn.execute(
                "SELECT repo, claim_hash, scheme_version, model FROM mem_meta "
                "WHERE memory_id = ?",
                (memory_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "memory_id": memory_id,
            "repo": row[0],
            "claim_hash": row[1],
            "scheme_version": int(row[2]) if row[2] is not None else None,
            "model": row[3],
        }

    def search(self, query: str, repo: str, limit: int = 10) -> list[MemorySearchHit]:
        """Return the nearest claims to *query* within *repo*, best first.

        Embeds the query with the shared nomic encoder (384-dim) and ranks the
        repo's partition by ``vec0`` cosine distance — the same brute-force cosine
        as code vector search, but pre-filtered by the ``repo`` partition key so
        claim ids never mix into other repos. Falls back to a Python cosine over
        the repo's stored vectors if the native query fails, and returns ``[]`` on
        any embedding/query failure so the caller degrades to lexical recall.
        """
        if not query or not query.strip() or not repo:
            return []
        limit = max(int(limit), 0)
        if limit == 0:
            return []
        vec = embed_query(query)
        if vec is None:
            return []
        try:
            with self._lock:
                conn = self._require_conn()
                rows = conn.execute(
                    "SELECT memory_id, distance FROM mem_vec "
                    "WHERE repo = ? AND embedding MATCH ? ORDER BY distance LIMIT ?",
                    (repo, sqlite_vec.serialize_float32(vec), limit),
                ).fetchall()
            return [
                MemorySearchHit(
                    memory_id=r[0] or "",
                    score=1.0 - float(r[1]) if r[1] is not None else 0.0,
                )
                for r in rows
            ]
        except Exception:
            logger.warning(
                "memory vector_search failed — falling back to Python cosine "
                "(check embedding dimension/scheme vs the index)",
                exc_info=True,
            )
            return self._search_python(vec, repo, limit)

    def _search_python(self, vec: list[float], repo: str, limit: int) -> list[MemorySearchHit]:
        """Small-set cosine fallback over the repo's stored vectors."""
        rows: list[tuple[str, list[float]]] = []
        try:
            with self._lock:
                conn = self._require_conn()
                raw = conn.execute(
                    "SELECT memory_id, embedding FROM mem_vec WHERE repo = ?",
                    (repo,),
                ).fetchall()
            for mid, blob in raw:
                rows.append((mid or "", _deserialize_vec(blob)))
        except Exception:
            logger.warning("memory python-cosine fallback query failed", exc_info=True)
            return []

        def _cos(a: list[float], b: list[float]) -> float:
            if not a or not b or len(a) != len(b):
                return 0.0
            dot = sum(x * y for x, y in zip(a, b))
            na = sum(x * x for x in a) ** 0.5
            nb = sum(y * y for y in b) ** 0.5
            if na == 0.0 or nb == 0.0:
                return 0.0
            return dot / (na * nb)

        scored = [MemorySearchHit(mid, _cos(vec, v)) for mid, v in rows]
        scored.sort(key=lambda h: h.score, reverse=True)
        return scored[:limit]

    # --------------------------------------------------------- scheme refresh
    def stale_memory_ids(
        self,
        *,
        model: str = _DEFAULT_MODEL,
        scheme_version: int = EMBEDDING_SCHEME_VERSION,
    ) -> list[str]:
        """Memory ids whose stored vector predates the current model/scheme.

        A query encoded with the current scheme must never be cosine-compared to
        documents encoded under an older one (HOR-373 silent-recall collapse), so
        these ids need re-embedding from their authoritative claim text.
        """
        with self._lock:
            conn = self._require_conn()
            rows = conn.execute(
                "SELECT memory_id FROM mem_meta "
                "WHERE scheme_version <> ? OR model <> ?",
                (scheme_version, model),
            ).fetchall()
        return [r[0] for r in rows if r[0]]

    def ensure_current_memory_embeddings(
        self,
        claims: Mapping[str, str] | Callable[[str], str | None],
        *,
        model: str = _DEFAULT_MODEL,
    ) -> int:
        """Re-embed claims whose stored scheme/model drifted from the current one.

        The claim *text* is authoritative on the TS side, so the caller supplies it
        — either as a ``{memory_id: claim}`` mapping or a callable resolving a single
        id. Returns the number of claims actually refreshed; ids whose claim text
        cannot be resolved are left as-is (best-effort).
        """
        stale = self.stale_memory_ids(model=model)
        if not stale:
            return 0
        meta_by_id = {mid: (self.get_meta(mid) or {}) for mid in stale}
        resolve: Callable[[str], str | None]
        if callable(claims):
            resolve = claims
        else:
            resolve = lambda mid: claims.get(mid)  # noqa: E731

        refreshed = 0
        for mid in stale:
            text = resolve(mid)
            if not text:
                continue
            repo = meta_by_id.get(mid, {}).get("repo") or ""
            if not repo:
                continue
            if self.upsert(mid, text, repo, model=model):
                refreshed += 1
        return refreshed


def _deserialize_vec(blob: object) -> list[float]:
    """Decode a ``vec0`` float32 embedding blob back into a Python float list."""
    if isinstance(blob, (bytes, bytearray, memoryview)):
        data = bytes(blob)
        n = len(data) // 4
        return list(struct.unpack(f"<{n}f", data))
    if isinstance(blob, (list, tuple)):
        return [float(x) for x in blob]
    return []
