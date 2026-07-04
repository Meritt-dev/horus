"""Resumable embedding driver (B1.2): embed only the missing vectors, per-chunk durable."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np

import horus_source.core.embeddings.embedder as embedder
from horus_source.core.embeddings.embedder import _get_model, embed_missing
from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import GraphNode, NodeLabel
from horus_source.core.storage.base import NodeEmbedding


def _vec768(base: list[float] | None = None) -> np.ndarray:
    v = np.zeros(768)
    if base:
        v[: len(base)] = base
    return v


def _five_fn_graph() -> tuple[KnowledgeGraph, list[GraphNode]]:
    graph = KnowledgeGraph()
    nodes = []
    for i in range(5):
        n = GraphNode(
            id=f"function:src/m.py:f{i}",
            label=NodeLabel.FUNCTION,
            name=f"f{i}",
            file_path="src/m.py",
        )
        graph.add_node(n)
        nodes.append(n)
    return graph, nodes


def _spy_model(mock_te_cls: MagicMock) -> list[str]:
    """Wire a mock TextEmbedding that records every text it is asked to embed."""
    seen: list[str] = []
    model = MagicMock()

    def _passage_embed(texts, batch_size=None):
        texts = list(texts)
        seen.extend(texts)
        return [_vec768([0.1]) for _ in texts]

    model.passage_embed.side_effect = _passage_embed
    mock_te_cls.return_value = model
    return seen


@patch("fastembed.TextEmbedding")
def test_embed_missing_only_computes_missing(mock_te_cls: MagicMock) -> None:
    _get_model.cache_clear()
    graph, nodes = _five_fn_graph()
    seen = _spy_model(mock_te_cls)

    persisted: list[NodeEmbedding] = []
    already = {nodes[0].id, nodes[1].id}
    n_target, n_computed = embed_missing(
        graph, already, persist=lambda batch: persisted.extend(batch)
    )

    assert (n_target, n_computed) == (5, 3)
    # Only the 3 nodes lacking a vector were sent to the model + persisted.
    assert len(seen) == 3
    assert {e.node_id for e in persisted} == {nodes[2].id, nodes[3].id, nodes[4].id}


@patch("fastembed.TextEmbedding")
def test_embed_missing_persists_per_chunk(
    mock_te_cls: MagicMock, monkeypatch
) -> None:
    _get_model.cache_clear()
    monkeypatch.setattr(embedder, "_EMBED_CHUNK", 2)
    graph, _nodes = _five_fn_graph()
    _spy_model(mock_te_cls)

    calls: list[int] = []
    n_target, n_computed = embed_missing(
        graph, set(), persist=lambda batch: calls.append(len(batch))
    )

    assert (n_target, n_computed) == (5, 5)
    # 5 nodes at chunk size 2 → persisted in multiple batches, not one end-of-run flush.
    assert len(calls) >= 2
    assert sum(calls) == 5


@patch("fastembed.TextEmbedding")
def test_embed_missing_empty_when_all_present(mock_te_cls: MagicMock) -> None:
    _get_model.cache_clear()
    graph, nodes = _five_fn_graph()
    model = MagicMock()
    mock_te_cls.return_value = model

    persisted: list[NodeEmbedding] = []
    all_ids = {n.id for n in nodes}
    n_target, n_computed = embed_missing(
        graph, all_ids, persist=lambda batch: persisted.append(batch)
    )

    assert (n_target, n_computed) == (5, 0)
    assert persisted == []
    model.passage_embed.assert_not_called()


@patch("fastembed.TextEmbedding")
def test_embed_missing_empty_graph(mock_te_cls: MagicMock) -> None:
    _get_model.cache_clear()
    model = MagicMock()
    mock_te_cls.return_value = model
    persisted: list[NodeEmbedding] = []

    assert embed_missing(KnowledgeGraph(), set(), persist=persisted.append) == (0, 0)
    assert persisted == []
    model.passage_embed.assert_not_called()
