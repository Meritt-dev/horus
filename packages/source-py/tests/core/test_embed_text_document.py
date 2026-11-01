"""Tests for embed_text_document — the document-side single-text encoder (M2)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from horus_source.core.embeddings.embedder import (
    _DOCUMENT_PREFIX,
    _get_model,
    embed_text_document,
)


@pytest.fixture(autouse=True)
def _clear_model_cache():
    _get_model.cache_clear()
    yield
    _get_model.cache_clear()


@patch("fastembed.TextEmbedding")
def test_uses_passage_embed_with_document_prefix(mock_te_cls: MagicMock) -> None:
    mock_model = MagicMock()
    mock_model.passage_embed.return_value = iter([np.array([0.5] * 768)])
    mock_te_cls.return_value = mock_model

    embed_text_document("auth uses JWT in middleware")

    mock_model.passage_embed.assert_called_once()
    arg = mock_model.passage_embed.call_args[0][0]
    assert arg == [f"{_DOCUMENT_PREFIX}auth uses JWT in middleware"]


@patch("fastembed.TextEmbedding")
def test_truncates_to_384(mock_te_cls: MagicMock) -> None:
    mock_model = MagicMock()
    mock_model.passage_embed.return_value = iter([np.array([0.5] * 768)])
    mock_te_cls.return_value = mock_model

    result = embed_text_document("a claim")

    assert result is not None
    assert len(result) == 384
    assert all(isinstance(v, float) for v in result)


@patch("fastembed.TextEmbedding")
def test_empty_or_blank_returns_none(mock_te_cls: MagicMock) -> None:
    assert embed_text_document("") is None
    assert embed_text_document("   ") is None
    mock_te_cls.assert_not_called()


@patch("fastembed.TextEmbedding")
def test_model_failure_degrades_to_none(mock_te_cls: MagicMock) -> None:
    mock_model = MagicMock()
    mock_model.passage_embed.side_effect = RuntimeError("boom")
    mock_te_cls.return_value = mock_model

    assert embed_text_document("a claim") is None


@patch("fastembed.TextEmbedding")
def test_matches_query_space_dimensions(mock_te_cls: MagicMock) -> None:
    """Document and query encoders share the same 384-dim output space."""
    from horus_source.core.embeddings.embedder import embed_query

    mock_model = MagicMock()
    mock_model.passage_embed.return_value = iter([np.array([0.5] * 768)])
    mock_model.query_embed.return_value = iter([np.array([0.5] * 768)])
    mock_te_cls.return_value = mock_model

    doc = embed_text_document("a claim")
    q = embed_query("a query")
    assert doc is not None and q is not None
    assert len(doc) == len(q) == 384
