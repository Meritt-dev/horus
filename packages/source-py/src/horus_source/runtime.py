"""Shared runtime state for Horus host processes."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from horus_source.core.memory.vector_store import MemoryVectorStore
from horus_source.core.storage.base import StorageBackend


@dataclass(slots=True)
class HorusRuntime:
    """Shared runtime container for web and MCP surfaces."""

    storage: StorageBackend
    repo_path: Path | None = None
    watch: bool = False
    lock: asyncio.Lock | None = None
    host_url: str | None = None
    mcp_url: str | None = None
    owns_storage: bool = True
    # True while a fresh index or an interrupted re-embed is still running in the
    # background. The host binds its port and serves /api/host immediately; clients
    # surface "indexing in progress" until this clears (HOR-425).
    indexing: bool = False
    # True once the structural index (symbols + edges) is persisted and searchable,
    # even while ``indexing`` is still True because embeddings are warming in the
    # background. Lets clients tell "usable now, semantic search warming" from
    # "nothing yet" (B1.1). Search degrades to FTS-only until embeddings land.
    structural_ready: bool = False
    event_listeners: list[asyncio.Queue[Any]] | None = field(default=None)
    # The dedicated memory claim vector index. Only the RW host sets this (it is
    # the sole owner of ``.horus/source/memory``); every other surface leaves it
    # ``None`` so the memory routes are absent and the TS client falls back to
    # lexical recall.
    memory_store: MemoryVectorStore | None = None

    def __post_init__(self) -> None:
        if self.event_listeners is None and self.watch:
            self.event_listeners = []
