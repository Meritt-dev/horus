"""Horus Memory — the durable-claim vector index (M2).

The authoritative system-of-record for memory claims lives on the TS/Postgres
side (``@horus/engine`` ``MemoryStore``). This package owns only the *derived,
rebuildable* vector index that makes semantic recall possible — kept in a
DEDICATED kùzu directory (``.horus/source/memory``) that is fully decoupled from
the code graph and therefore immune to ``bulk_load``'s re-analyze wipe.
"""

from horus_source.core.memory.vector_store import (
    MemoryClaim,
    MemorySearchHit,
    MemoryVectorStore,
)
from horus_source.core.memory.writer import MemoryWriter

__all__ = ["MemoryClaim", "MemorySearchHit", "MemoryVectorStore", "MemoryWriter"]
