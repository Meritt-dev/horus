"""Single serialized async owner for the memory vector store (M2, contract C).

The host is the sole RW owner of the dedicated ``.horus/source/memory`` kùzu
dir. ``MemoryWriter`` makes that ownership safe and non-blocking on the serving
surface:

- Writes (upsert/remove) are ENQUEUED and drained by ONE background consumer
  task — a single serialized writer stream. ``enqueue_*`` never blocks the
  request handler (the TS caller's ``memory add`` must never wait on vector
  indexing), and any per-op failure is swallowed (best-effort).
- The blocking kùzu/embedder work runs in a worker thread (``asyncio.to_thread``)
  so it never stalls the event loop; the store's own lock still serializes the
  connection, so a concurrent ``search`` and the drained write can't race.
- ``search`` is a read: it runs in a thread and returns hits (or ``[]`` on any
  failure), so a not-yet-drained claim simply isn't found yet and the TS caller
  degrades to lexical (Jaccard) recall.

The store remains the source of the index; this class only governs *when* and
*how serially* it is touched from async request handlers.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from horus_source.core.embeddings.embedder import _DEFAULT_MODEL
from horus_source.core.memory.vector_store import MemorySearchHit, MemoryVectorStore

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _Upsert:
    memory_id: str
    claim: str
    repo: str
    model: str

    def apply(self, store: MemoryVectorStore) -> None:
        store.upsert(self.memory_id, self.claim, self.repo, model=self.model)


@dataclass(frozen=True)
class _Remove:
    memory_id: str

    def apply(self, store: MemoryVectorStore) -> None:
        store.remove(self.memory_id)


class MemoryWriter:
    """Serialize all memory-store mutations through one async consumer task."""

    def __init__(self, store: MemoryVectorStore) -> None:
        self._store = store
        self._queue: asyncio.Queue = asyncio.Queue()
        self._task: asyncio.Task | None = None
        self._closed = False

    def start(self) -> None:
        """Spawn the background drain task (must run inside a running loop)."""
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while True:
            op = await self._queue.get()
            try:
                if op is None:  # shutdown sentinel
                    return
                await asyncio.to_thread(op.apply, self._store)
            except Exception:
                logger.warning("memory write op failed (best-effort, dropped)", exc_info=True)
            finally:
                self._queue.task_done()

    # --------------------------------------------------------------- mutations
    def enqueue_upsert(
        self, memory_id: str, claim: str, repo: str, *, model: str = _DEFAULT_MODEL
    ) -> None:
        """Queue a claim (re)index. Non-blocking, best-effort, deduped by id at write."""
        if self._closed or not memory_id or not repo:
            return
        self._queue.put_nowait(_Upsert(memory_id, claim, repo, model))

    def enqueue_remove(self, memory_id: str) -> None:
        """Queue a claim deletion. Non-blocking, best-effort, idempotent."""
        if self._closed or not memory_id:
            return
        self._queue.put_nowait(_Remove(memory_id))

    # ------------------------------------------------------------------- reads
    async def search(self, query: str, repo: str, limit: int = 10) -> list[MemorySearchHit]:
        """Cosine-rank the repo's claims against *query* (off-loop, never raises)."""
        try:
            return await asyncio.to_thread(self._store.search, query, repo, limit)
        except Exception:
            logger.warning("memory search failed (returning empty)", exc_info=True)
            return []

    # --------------------------------------------------------------- lifecycle
    async def join(self) -> None:
        """Wait until every enqueued op has been drained (used by tests/shutdown)."""
        await self._queue.join()

    async def aclose(self) -> None:
        """Drain pending ops, stop the consumer, and release nothing else.

        The underlying store is closed by its RW owner (the host), not here.
        """
        self._closed = True
        if self._task is None:
            return
        await self._queue.join()
        self._queue.put_nowait(None)
        try:
            await self._task
        finally:
            self._task = None
