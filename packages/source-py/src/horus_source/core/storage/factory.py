"""Storage backend factory and store-path resolution (HOR-392 stage 2).

Selects the concrete :class:`StorageBackend` implementation and resolves its
on-disk store path. The default backend is now **SQLite** (sqlite-vec + FTS5);
KùzuDB remains selectable for one deprecation release via the
``HORUS_SOURCE_STORAGE_BACKEND=kuzu`` environment variable.

``KuzuBackend`` is imported lazily so a runtime that never selects it does not
need the (now-optional) ``kuzu`` dependency installed.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from horus_source.core.storage.base import StorageBackend

logger = logging.getLogger(__name__)

SQLITE = "sqlite"
KUZU = "kuzu"

DEFAULT_BACKEND = SQLITE
_ENV_VAR = "HORUS_SOURCE_STORAGE_BACKEND"

# Bumped when the on-disk store layout changes in a way that requires a re-index.
# Stamped into meta.json (``store_format_version``) alongside ``store_backend`` so the
# host-start self-heal can detect an incompatible/legacy store and rebuild it (HOR-433).
STORE_FORMAT_VERSION = 1

# On-disk store name per backend, relative to ``.horus/source/``.
_STORE_NAME: dict[str, str] = {SQLITE: "horus.db", KUZU: "kuzu"}

# Legacy KùzuDB store name. When the active backend is SQLite, a leftover store
# of this name is stale and is pruned (no lossy conversion) so the next analyze
# re-indexes and re-embeds from source.
LEGACY_KUZU_STORE_NAME = "kuzu"


def backend_name() -> str:
    """Return the active backend name, honouring ``HORUS_SOURCE_STORAGE_BACKEND``."""
    name = (os.environ.get(_ENV_VAR) or DEFAULT_BACKEND).strip().lower()
    if name not in (SQLITE, KUZU):
        logger.warning("Unknown %s=%r; falling back to %s", _ENV_VAR, name, DEFAULT_BACKEND)
        return DEFAULT_BACKEND
    return name


def create_backend(name: str | None = None) -> StorageBackend:
    """Instantiate (but do not initialize) the selected backend."""
    name = name or backend_name()
    if name == KUZU:
        from horus_source.core.storage.kuzu_backend import KuzuBackend

        return KuzuBackend()
    from horus_source.core.storage.sqlite_backend import SqliteBackend

    return SqliteBackend()


def store_path(source_dir: Path, name: str | None = None) -> Path:
    """Return the store path inside ``.horus/source/`` for the selected backend."""
    name = name or backend_name()
    return Path(source_dir) / _STORE_NAME[name]


def store_exists(source_dir: Path, name: str | None = None) -> bool:
    """Whether a usable store for the selected backend exists under *source_dir*.

    SQLite stores are a single file; KùzuDB stores are a directory (or single
    file with sidecars on newer kùzu). Both cases are handled.
    """
    path = store_path(source_dir, name)
    if path.is_dir():
        return any(path.iterdir())
    return path.exists()


def legacy_kuzu_store_exists(source_dir: Path) -> bool:
    """Whether a legacy ``.horus/source/kuzu`` store is present under *source_dir*.

    Detection counterpart to :func:`prune_legacy_kuzu_store`: lets the host-start
    self-heal notice a kùzu-era store BEFORE pruning it (HOR-433). Always ``False`` when
    the active backend IS KùzuDB (there the ``kuzu`` store is the live store, not legacy).
    """
    if backend_name() == KUZU:
        return False
    base = Path(source_dir) / LEGACY_KUZU_STORE_NAME
    if base.is_dir():
        return any(base.iterdir())
    return base.exists()


def prune_legacy_kuzu_store(source_dir: Path) -> bool:
    """Delete a stale ``.horus/source/kuzu`` store and its sidecars.

    Called when the active backend is not KùzuDB (the default after HOR-392): the
    legacy store is ignored and removed rather than converted, so analyze rebuilds
    a fresh SQLite store. Returns ``True`` if anything was removed.
    """
    if backend_name() == KUZU:
        return False
    base = Path(source_dir) / LEGACY_KUZU_STORE_NAME
    targets = [
        base,
        base.with_name(base.name + ".wal"),
        base.with_name(base.name + ".tmp"),
        base.with_name(base.name + ".shadow"),
        Path(str(base) + ".lock"),
    ]
    removed = False
    for target in targets:
        try:
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
                removed = True
            elif target.exists():
                target.unlink()
                removed = True
        except OSError:
            logger.debug("Failed to prune legacy kuzu artifact %s", target, exc_info=True)
    if removed:
        logger.info("Pruned legacy KùzuDB store under %s (will re-index into SQLite)", source_dir)
    return removed
