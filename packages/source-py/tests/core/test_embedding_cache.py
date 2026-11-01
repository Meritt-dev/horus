"""HOR-358 — persistent content-hash embedding cache."""

from __future__ import annotations

import types
from pathlib import Path

import numpy as np
import pytest

from horus_source.core.embeddings import cache as cache_mod
from horus_source.core.embeddings import embedder
from horus_source.core.embeddings.cache import EmbeddingCache, get_shared_cache, make_key


def _vec(seed: float) -> np.ndarray:
    return np.full(768, seed, dtype=np.float32)


class _CountingModel:
    """Stand-in for fastembed's model: returns one vector per text, counts texts seen."""

    def __init__(self) -> None:
        self.embedded = 0

    def passage_embed(self, texts, batch_size=8):  # noqa: ANN001
        texts = list(texts)
        self.embedded += len(texts)
        return iter([_vec(float(i + 1)) for i in range(len(texts))])


class TestMakeKey:
    def test_stable_for_identical_inputs(self) -> None:
        a = make_key("m", 2, 384, "search_document: hello")
        b = make_key("m", 2, 384, "search_document: hello")
        assert a == b

    def test_sensitive_to_every_input(self) -> None:
        base = make_key("m", 2, 384, "x")
        assert make_key("m2", 2, 384, "x") != base  # model
        assert make_key("m", 3, 384, "x") != base  # scheme
        assert make_key("m", 2, 256, "x") != base  # dimensions
        assert make_key("m", 2, 384, "y") != base  # text


class TestEmbeddingCacheStore:
    def test_put_get_roundtrip(self, tmp_path: Path) -> None:
        c = EmbeddingCache(tmp_path / "c.db")
        assert c.available
        c.put_many({"k1": [0.1, 0.2, 0.3], "k2": [0.4, 0.5]})
        got = c.get_many(["k1", "k2", "missing"])
        assert "missing" not in got
        assert got["k1"] == pytest.approx([0.1, 0.2, 0.3], abs=1e-6)
        assert got["k2"] == pytest.approx([0.4, 0.5], abs=1e-6)

    def test_persists_across_instances(self, tmp_path: Path) -> None:
        path = tmp_path / "c.db"
        EmbeddingCache(path).put_many({"k": [1.0, 2.0]})
        reopened = EmbeddingCache(path)
        assert reopened.get_many(["k"])["k"] == pytest.approx([1.0, 2.0], abs=1e-6)

    def test_get_many_empty_is_safe(self, tmp_path: Path) -> None:
        assert EmbeddingCache(tmp_path / "c.db").get_many([]) == {}


class TestSharedCacheToggle:
    def test_disabled_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HORUS_EMBED_CACHE", "0")
        cache_mod._reset_shared_cache()
        assert get_shared_cache() is None

    def test_enabled_returns_cache(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv("HORUS_EMBED_CACHE", "1")
        monkeypatch.setenv("HORUS_EMBED_CACHE_PATH", str(tmp_path / "c.db"))
        cache_mod._reset_shared_cache()
        c = get_shared_cache()
        assert c is not None and c.available


class TestEmbedNodeListUsesCache:
    def _enable(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> _CountingModel:
        monkeypatch.setenv("HORUS_EMBED_CACHE", "1")
        monkeypatch.setenv("HORUS_EMBED_CACHE_PATH", str(tmp_path / "c.db"))
        cache_mod._reset_shared_cache()
        model = _CountingModel()
        monkeypatch.setattr(embedder, "_get_model", lambda _name: model)
        return model

    def test_second_run_hits_cache_and_skips_model(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        model = self._enable(monkeypatch, tmp_path)
        nodes = [types.SimpleNamespace(id=f"n{i}") for i in range(3)]
        texts = ["alpha", "beta", "gamma"]

        first = embedder._embed_node_list(nodes, texts, "nomic-ai/nomic-embed-text-v1.5", 8, 384)
        assert model.embedded == 3  # all misses on a cold cache
        assert [e.node_id for e in first] == ["n0", "n1", "n2"]

        # Second identical run: every text is a hit, so the model is never called again.
        model.embedded = 0
        second = embedder._embed_node_list(nodes, texts, "nomic-ai/nomic-embed-text-v1.5", 8, 384)
        assert model.embedded == 0
        assert [e.embedding for e in second] == [e.embedding for e in first]

    def test_partial_hit_only_embeds_new_texts(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        model = self._enable(monkeypatch, tmp_path)
        embedder._embed_node_list(
            [types.SimpleNamespace(id="n0")], ["alpha"], "nomic-ai/nomic-embed-text-v1.5", 8, 384
        )
        model.embedded = 0
        # "alpha" cached, "beta" new → only one new embed.
        out = embedder._embed_node_list(
            [types.SimpleNamespace(id="n0"), types.SimpleNamespace(id="n1")],
            ["alpha", "beta"],
            "nomic-ai/nomic-embed-text-v1.5",
            8,
            384,
        )
        assert model.embedded == 1
        assert len(out) == 2
