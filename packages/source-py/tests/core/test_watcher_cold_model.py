"""The watcher keeps MCP reads available while its embedding model initializes."""

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from horus_source.core.ingestion import watcher
from horus_source.core.storage.base import SearchResult
from horus_source.mcp import server as mcp_server


def prepare_watcher(monkeypatch, tmp_path):
    async def changes(*args, **kwargs):
        yield {(1, str(tmp_path / "src/a.py"))}
        yield set()
        yield set()

    monkeypatch.setattr(watcher.watchfiles, "awatch", changes)
    monkeypatch.setattr(watcher, "QUIET_PERIOD", 0)
    monkeypatch.setattr(watcher, "load_gitignore", lambda _: [])
    monkeypatch.setattr(watcher, "_get_head_sha", lambda _: "commit")
    monkeypatch.setattr(watcher, "_reindex_files", lambda paths, *args: (
        len(paths), {str(path.relative_to(tmp_path)) for path in paths},
    ))


@pytest.mark.asyncio
async def test_mcp_read_completes_while_watcher_initializes_model(monkeypatch, tmp_path):
    storage = MagicMock()
    hit = SearchResult(node_id="function:src/a.py:foo", node_name="foo", file_path="src/a.py", label="function", score=1)
    storage.fts_search.return_value = [hit]
    storage.exact_name_search.return_value = [hit]
    storage.name_contains_search.return_value = []
    storage.decorator_arg_search.return_value = []
    storage.get_process_memberships.return_value = {}
    prepare_watcher(monkeypatch, tmp_path)
    lock = asyncio.Lock()
    monkeypatch.setattr(mcp_server, "_storage", storage)
    monkeypatch.setattr(mcp_server, "_lock", lock)
    monkeypatch.setattr("horus_source.mcp.tools.embed_query", lambda *args, **kwargs: None)
    entered = threading.Event()
    release = threading.Event()

    def load(*args):
        entered.set()
        assert release.wait(15)
        return MagicMock()

    def update(*args):
        assert lock.locked()  # Structural/database mutations remain serialized.
        return True

    monkeypatch.setattr(watcher, "_get_model", load)
    monkeypatch.setattr(watcher, "_run_incremental_global_phases", update)
    task = asyncio.create_task(watcher.watch_repo(tmp_path, storage, lock=lock))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        result = await asyncio.wait_for(mcp_server.call_tool("horus_source_query", {"query": "foo"}), 5)
        assert "src/a.py" in result[0].text
    finally:
        release.set()
        await asyncio.wait_for(task, 5)


@pytest.mark.asyncio
async def test_failed_model_retries_only_vectors_with_backoff_and_keeps_new_structure(monkeypatch, tmp_path):
    storage = MagicMock()
    prepare_watcher(monkeypatch, tmp_path)
    clock = [100.0]

    async def changes(*args, **kwargs):
        yield {(1, str(tmp_path / "src/a.py"))}
        for at in (102, 160, 200):
            clock[0] = at
            yield set()
        clock[0] = 210
        yield {(1, str(tmp_path / "src/b.py"))}
        clock[0] = 280
        yield set()

    monkeypatch.setattr(watcher.watchfiles, "awatch", changes)
    monkeypatch.setattr(watcher, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    model = MagicMock(side_effect=[RuntimeError("offline"), RuntimeError("still offline"), MagicMock()])
    phases = MagicMock(side_effect=lambda *args: args[4])
    retry = MagicMock(return_value=True)
    monkeypatch.setattr(watcher, "_get_model", model)
    monkeypatch.setattr(watcher, "_run_incremental_global_phases", phases)
    monkeypatch.setattr(watcher, "_run_incremental_embeddings", retry)
    await watcher.watch_repo(tmp_path, storage, lock=asyncio.Lock())
    assert [call.args[4] for call in phases.call_args_list] == [False, False]
    assert [call.args[2] for call in phases.call_args_list] == [{"src/a.py"}, {"src/b.py"}]
    assert model.call_count == 3
    retry.assert_called_once_with(storage, tmp_path, {"src/a.py", "src/b.py"})
