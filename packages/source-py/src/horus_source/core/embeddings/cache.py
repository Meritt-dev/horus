"""Persistent content-hash cache for symbol embeddings (HOR-358).

Embedding is the dominant cost of indexing a repo. The fastembed model is
deterministic: the same ``(model, scheme, dimensions, encoded text)`` always
produces the same vector. So we key vectors by a hash of exactly those inputs
and reuse them — turning a re-index (unchanged symbols) or a second repo that
vendors the same file into cache *hits* instead of recompute.

Backed by SQLite in WAL mode so several concurrent indexers (HOR-357 runs a host
per repo) can share one cache without corrupting it. The cache is a pure
optimisation: every failure path degrades to "just embed it", never an error.

Disable with ``HORUS_EMBED_CACHE=0``; relocate with ``HORUS_EMBED_CACHE_PATH``
(defaults to ``$HORUS_HOME/embedding-cache.db`` or ``~/.horus/embedding-cache.db``).
"""

from __future__ import annotations

import array
import hashlib
import logging
import os
import sqlite3
import threading
from pathlib import Path

logger = logging.getLogger(__name__)

_DISABLED_VALUES = {"0", "false", "no", "off"}
# SQLite caps host parameters per statement (default 999); stay well under it.
_IN_CHUNK = 500


def cache_enabled() -> bool:
    """Whether the embedding cache is enabled (default on; off via HORUS_EMBED_CACHE)."""
    return os.environ.get("HORUS_EMBED_CACHE", "1").strip().lower() not in _DISABLED_VALUES


def _default_path() -> Path:
    override = os.environ.get("HORUS_EMBED_CACHE_PATH")
    if override:
        return Path(override)
    home = os.environ.get("HORUS_HOME")
    base = Path(home) if home else Path.home() / ".horus"
    return base / "embedding-cache.db"


def make_key(model_name: str, scheme: int, dimensions: int, encoded_text: str) -> str:
    """Stable cache key for an embedding input.

    Includes everything that affects the output vector — model, embedding-scheme
    version, truncation dimensions, and the exact text handed to the model (with
    its task prefix already applied) — so a hit can only ever return a vector that
    is byte-for-byte what re-embedding would produce.
    """
    h = hashlib.sha256()
    h.update(f"{model_name}\x00{scheme}\x00{dimensions}\x00".encode("utf-8"))
    h.update(encoded_text.encode("utf-8"))
    return h.hexdigest()


def _pack(vec: list[float]) -> bytes:
    return array.array("f", vec).tobytes()


def _unpack(blob: bytes) -> list[float]:
    a = array.array("f")
    a.frombytes(blob)
    return a.tolist()


class EmbeddingCache:
    """SQLite-backed key→vector store. Safe across threads and processes (WAL)."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or _default_path()
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=30.0)
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vec BLOB NOT NULL)"
            )
            conn.commit()
            self._conn = conn
        except Exception:
            logger.warning(
                "embedding cache unavailable at %s — proceeding without it",
                self.path,
                exc_info=True,
            )
            self._conn = None

    @property
    def available(self) -> bool:
        return self._conn is not None

    def get_many(self, keys: list[str]) -> dict[str, list[float]]:
        """Return the subset of *keys* present in the cache, mapped to vectors."""
        out: dict[str, list[float]] = {}
        if not self._conn or not keys:
            return out
        try:
            with self._lock:
                for start in range(0, len(keys), _IN_CHUNK):
                    chunk = keys[start : start + _IN_CHUNK]
                    placeholders = ",".join("?" * len(chunk))
                    rows = self._conn.execute(
                        f"SELECT key, vec FROM embeddings WHERE key IN ({placeholders})",
                        chunk,
                    )
                    for k, blob in rows:
                        out[k] = _unpack(blob)
        except Exception:
            logger.warning("embedding cache read failed — treating as miss", exc_info=True)
        return out

    def put_many(self, items: dict[str, list[float]]) -> None:
        """Insert/overwrite cache entries. Best-effort; never raises."""
        if not self._conn or not items:
            return
        try:
            with self._lock:
                self._conn.executemany(
                    "INSERT OR REPLACE INTO embeddings (key, vec) VALUES (?, ?)",
                    [(k, _pack(v)) for k, v in items.items()],
                )
                self._conn.commit()
        except Exception:
            logger.warning("embedding cache write failed — skipping", exc_info=True)


_shared: EmbeddingCache | None = None
_shared_lock = threading.Lock()


def get_shared_cache() -> EmbeddingCache | None:
    """The process-wide cache, or ``None`` when disabled/unavailable."""
    global _shared
    if not cache_enabled():
        return None
    if _shared is not None:
        return _shared
    with _shared_lock:
        if _shared is None:
            _shared = EmbeddingCache()
    return _shared if _shared and _shared.available else None


def _reset_shared_cache() -> None:
    """Drop the process-wide cache handle (used in tests)."""
    global _shared
    with _shared_lock:
        if _shared is not None and _shared._conn is not None:
            try:
                _shared._conn.close()
            except Exception:
                pass
        _shared = None
