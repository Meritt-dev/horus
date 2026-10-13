"""Interactive HTTP and MCP queries serve indexed data during model initialization."""

from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from horus_source.core.embeddings.embedder import _get_model
from horus_source.core.storage.base import SearchResult
from horus_source.mcp import server as mcp_server
from horus_source.mcp.tools import handle_query
from horus_source.web.routes.search import router


@pytest.mark.parametrize("surface", ["http", "mcp"])
def test_indexed_results_return_while_model_is_blocked(surface: str, monkeypatch) -> None:
    _get_model.cache_clear()
    storage = MagicMock()
    hit = SearchResult(
        node_id="function:src/currency.ts:currencyConverter",
        node_name="currencyConverter", file_path="src/currency.ts",
        label="function", score=1.0,
    )
    storage.fts_search.return_value = [hit]
    storage.name_contains_search.return_value = []
    storage.exact_name_search.return_value = [hit]
    storage.decorator_arg_search.return_value = []
    storage.get_process_memberships.return_value = {}
    app = FastAPI()
    app.state.storage = storage
    app.include_router(router)
    monkeypatch.setattr(mcp_server, "_storage", storage)
    monkeypatch.setattr(mcp_server, "_lock", asyncio.Lock())
    entered = threading.Event()
    release = threading.Event()

    def initialize(*args, **kwargs):
        entered.set()
        assert release.wait(15)
        return MagicMock()

    def query_mcp() -> str:
        return asyncio.run(mcp_server.call_tool("horus_source_query", {"query": "currencyConverter"}))[0].text

    with patch("fastembed.TextEmbedding", side_effect=initialize), TestClient(app) as client:
        with ThreadPoolExecutor(max_workers=1) as pool:
            if surface == "http":
                pending = pool.submit(client.post, "/search", json={"query": "currencyConverter"})
            else:
                pending = pool.submit(query_mcp)
            try:
                assert entered.wait(5)
                result = pending.result(timeout=5)
                if surface == "http":
                    assert result.status_code == 200
                    assert result.json()["results"][0]["nodeId"] == hit.node_id
                else:
                    assert "currencyConverter" in result
                    assert "src/currency.ts" in result
                storage.vector_search.assert_not_called()
            finally:
                release.set()
                pending.result(timeout=5)
                _get_model.cache_clear()


def test_one_shot_query_waits_for_semantic_results() -> None:
    _get_model.cache_clear()
    storage = MagicMock()
    storage.fts_search.return_value = []
    storage.name_contains_search.return_value = []
    storage.exact_name_search.return_value = []
    storage.decorator_arg_search.return_value = []
    storage.fuzzy_search.return_value = []
    storage.get_process_memberships.return_value = {}
    storage.vector_search.return_value = [SearchResult(
        node_id="function:src/money.ts:convert", node_name="convert",
        file_path="src/money.ts", label="function", score=1,
    )]
    entered = threading.Event()
    release = threading.Event()
    model = MagicMock()
    model.query_embed.side_effect = lambda _: iter([np.ones(768)])

    def initialize(*args, **kwargs):
        entered.set()
        assert release.wait(15)
        return model

    with patch("fastembed.TextEmbedding", side_effect=initialize), ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(handle_query, storage, "money conversion")
        try:
            assert entered.wait(5)
            assert not pending.done()
            release.set()
            assert "src/money.ts" in pending.result(timeout=5)
            storage.vector_search.assert_called_once()
        finally:
            release.set()
            pending.result(timeout=5)
            _get_model.cache_clear()
