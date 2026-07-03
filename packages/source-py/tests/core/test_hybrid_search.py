from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from horus_source.core.search.hybrid import _is_deprioritized_path, hybrid_search
from horus_source.core.storage.base import SearchResult


@pytest.fixture()
def mock_storage() -> MagicMock:
    """Return a mock StorageBackend with FTS and vector results that overlap."""
    storage = MagicMock()
    # FTS returns results in ranked order
    storage.fts_search.return_value = [
        SearchResult(node_id="a", score=1.0, node_name="validate_user", file_path="src/auth.py", label="function"),
        SearchResult(node_id="b", score=0.8, node_name="validate_input", file_path="src/forms.py", label="function"),
        SearchResult(node_id="c", score=0.5, node_name="check_valid", file_path="src/utils.py", label="function"),
    ]
    # Vector returns results (some overlap with FTS)
    storage.vector_search.return_value = [
        SearchResult(node_id="b", score=0.95, node_name="validate_input", file_path="src/forms.py", label="function"),
        SearchResult(node_id="d", score=0.9, node_name="verify_user", file_path="src/verify.py", label="function"),
        SearchResult(node_id="a", score=0.7, node_name="validate_user", file_path="src/auth.py", label="function"),
    ]
    return storage

class TestHybridSearchBasic:
    def test_returns_results_from_both_sources(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1, 0.2])
        node_ids = {r.node_id for r in results}
        # All four unique IDs should be present
        assert node_ids == {"a", "b", "c", "d"}

    def test_overlapping_items_boosted_to_top(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1, 0.2])
        ids = [r.node_id for r in results]
        # "a" and "b" appear in both lists, so they should be the top two
        assert set(ids[:2]) == {"a", "b"}

    def test_fts_only_when_no_embedding(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=None)
        assert len(results) == 3
        mock_storage.vector_search.assert_not_called()

    def test_limit_respected(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1], limit=2)
        assert len(results) <= 2

    def test_empty_results(self) -> None:
        storage = MagicMock()
        storage.fts_search.return_value = []
        storage.vector_search.return_value = []
        results = hybrid_search("nothing", storage, query_embedding=[0.1])
        assert results == []

class TestRRFScoring:
    def test_scores_are_positive(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1])
        for r in results:
            assert r.score > 0

    def test_dual_list_item_scores_higher_than_single(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1])
        score_map = {r.node_id: r.score for r in results}
        # "c" only appears in FTS; "d" only in vector; "a" and "b" in both
        assert score_map["a"] > score_map["c"]
        assert score_map["b"] > score_map["d"]

    def test_rrf_scores_match_formula(self, mock_storage: MagicMock) -> None:
        k = 60
        results = hybrid_search(
            "validate", mock_storage, query_embedding=[0.1],
            fts_weight=1.0, vector_weight=1.0, rrf_k=k,
        )
        score_map = {r.node_id: r.score for r in results}

        # "a": FTS rank 1, vector rank 3  ->  1/(60+1) + 1/(60+3)
        expected_a = 1.0 / (k + 1) + 1.0 / (k + 3)
        assert score_map["a"] == pytest.approx(expected_a)

        # "b": FTS rank 2, vector rank 1  ->  1/(60+2) + 1/(60+1)
        expected_b = 1.0 / (k + 2) + 1.0 / (k + 1)
        assert score_map["b"] == pytest.approx(expected_b)

        # "c": FTS rank 3 only  ->  1/(60+3)
        expected_c = 1.0 / (k + 3)
        assert score_map["c"] == pytest.approx(expected_c)

        # "d": vector rank 2 only  ->  1/(60+2)
        expected_d = 1.0 / (k + 2)
        assert score_map["d"] == pytest.approx(expected_d)

    def test_weights_affect_scores(self, mock_storage: MagicMock) -> None:
        k = 60
        results_fts_heavy = hybrid_search(
            "validate", mock_storage, query_embedding=[0.1],
            fts_weight=2.0, vector_weight=0.5, rrf_k=k,
        )
        fts_heavy_scores = {r.node_id: r.score for r in results_fts_heavy}

        results_vec_heavy = hybrid_search(
            "validate", mock_storage, query_embedding=[0.1],
            fts_weight=0.5, vector_weight=2.0, rrf_k=k,
        )
        vec_heavy_scores = {r.node_id: r.score for r in results_vec_heavy}

        # "c" only appears in FTS: fts_heavy should give higher score
        assert fts_heavy_scores["c"] > vec_heavy_scores["c"]
        # "d" only appears in vector: vec_heavy should give higher score
        assert vec_heavy_scores["d"] > fts_heavy_scores["d"]

    def test_custom_rrf_k(self, mock_storage: MagicMock) -> None:
        results_small_k = hybrid_search(
            "validate", mock_storage, query_embedding=[0.1], rrf_k=1,
        )
        results_large_k = hybrid_search(
            "validate", mock_storage, query_embedding=[0.1], rrf_k=100,
        )
        # With a smaller k, scores are larger (denominator smaller)
        small_k_top = results_small_k[0].score
        large_k_top = results_large_k[0].score
        assert small_k_top > large_k_top

class TestResultOrdering:
    def test_descending_score_order(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1])
        scores = [r.score for r in results]
        assert scores == sorted(scores, reverse=True)

    def test_fts_only_preserves_order(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=None)
        scores = [r.score for r in results]
        assert scores == sorted(scores, reverse=True)

class TestMetadataPreservation:
    def test_node_name_preserved(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1])
        names = {r.node_name for r in results}
        assert "validate_user" in names
        assert "validate_input" in names
        assert "verify_user" in names

    def test_file_path_preserved(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1])
        paths = {r.file_path for r in results}
        assert "src/auth.py" in paths
        assert "src/forms.py" in paths

    def test_label_preserved(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1])
        for r in results:
            assert r.label == "function"

class TestEdgeCases:
    def test_vector_only_results(self) -> None:
        storage = MagicMock()
        storage.fts_search.return_value = []
        storage.vector_search.return_value = [
            SearchResult(node_id="x", score=0.9, node_name="find_me"),
        ]
        results = hybrid_search("query", storage, query_embedding=[0.1])
        assert len(results) == 1
        assert results[0].node_id == "x"

    def test_fts_only_results_no_vector(self) -> None:
        storage = MagicMock()
        storage.fts_search.return_value = [
            SearchResult(node_id="y", score=0.8, node_name="keyword_hit"),
        ]
        storage.vector_search.return_value = []
        results = hybrid_search("query", storage, query_embedding=[0.5])
        assert len(results) == 1
        assert results[0].node_id == "y"

    def test_limit_zero_returns_empty(self, mock_storage: MagicMock) -> None:
        results = hybrid_search("validate", mock_storage, query_embedding=[0.1], limit=0)
        assert results == []

    def test_fts_called_with_expanded_limit(self, mock_storage: MagicMock) -> None:
        hybrid_search("validate", mock_storage, query_embedding=[0.1], limit=10)
        mock_storage.fts_search.assert_called_once_with("validate", limit=30)
        mock_storage.vector_search.assert_called_once_with([0.1], limit=30)

    def test_duplicate_node_id_in_same_list(self) -> None:
        storage = MagicMock()
        storage.fts_search.return_value = [
            SearchResult(node_id="dup", score=1.0, node_name="dup_func"),
            SearchResult(node_id="dup", score=0.5, node_name="dup_func"),
        ]
        storage.vector_search.return_value = []
        results = hybrid_search("dup", storage, query_embedding=[0.1])
        # Should only appear once
        assert sum(1 for r in results if r.node_id == "dup") == 1


class TestExactCodeMatch:
    """HOR-329: a code-shaped query token surfaces exact-content matches first."""

    def test_exact_content_match_is_prepended_for_an_error_code(self) -> None:
        storage = MagicMock()
        # FTS ranks a fuzzy method first; exact-content finds the true raise site.
        storage.fts_search.return_value = [
            SearchResult(node_id="fuzzy", score=0.9, node_name="syncFoo"),
        ]
        storage.vector_search.return_value = []
        storage.exact_content_search.return_value = [
            SearchResult(node_id="raise", score=1.0, node_name="checkFoo", label="method"),
        ]
        storage.colocated_codes.return_value = []
        results = hybrid_search("E_FOO_BAR_01 failing", storage, query_embedding=None, limit=5)
        assert results[0].node_name == "checkFoo"
        storage.exact_content_search.assert_called_once_with("E_FOO_BAR_01", 5)

    def test_no_exact_lookup_for_a_plain_query(self) -> None:
        storage = MagicMock()
        storage.fts_search.return_value = [
            SearchResult(node_id="a", score=0.5, node_name="validate"),
        ]
        storage.vector_search.return_value = []
        hybrid_search("validate user", storage, query_embedding=None, limit=5)
        storage.exact_content_search.assert_not_called()

    def test_display_code_resolved_via_colocated_logical_key(self) -> None:
        # ERR4624 matches only the constants File (no function) — resolve its enclosing logical
        # key, then THAT key's raise site (HOR-329 follow-up).
        storage = MagicMock()
        storage.fts_search.return_value = [SearchResult(node_id="fuzzy", score=0.5, node_name="other")]
        storage.vector_search.return_value = []

        def exact(token: str, limit: int) -> list[SearchResult]:
            if token == "ERR4624":
                return [SearchResult(node_id="file:logs", score=1.0, node_name="logs.ts", label="file")]
            if token == "E_SYNC_PRODUCT_UPDATE_EXISTING":
                return [SearchResult(node_id="method:raise", score=1.0, node_name="syncProduct", label="method")]
            return []

        storage.exact_content_search.side_effect = exact
        storage.colocated_codes.return_value = ["E_SYNC_PRODUCT_UPDATE_EXISTING"]
        results = hybrid_search("ERR4624 failing", storage, query_embedding=None, limit=5)
        assert results[0].node_name == "syncProduct"
        storage.colocated_codes.assert_called_once_with("ERR4624")


class TestDecoratorArgSeed:
    """A queue/route/job name in the query prepends its decorated handler symbol."""

    def test_queue_name_prepends_processor_handler(self) -> None:
        storage = MagicMock()
        # RRF ranks a semantic neighbour first; the @Processor handler is the real answer.
        storage.fts_search.return_value = [
            SearchResult(node_id="neighbor", score=0.9, node_name="salesHelper"),
        ]
        storage.vector_search.return_value = []
        storage.exact_name_search.return_value = []
        storage.decorator_arg_search.side_effect = lambda token, limit: (
            [SearchResult(node_id="handler", score=1.0, node_name="manageSalesForMarket", label="method")]
            if token == "MANAGE_SALES"
            else []
        )
        results = hybrid_search("MANAGE_SALES queue stuck", storage, query_embedding=None, limit=5)
        assert results[0].node_name == "manageSalesForMarket"
        # The RRF neighbour is preserved in the tail, not dropped.
        assert "salesHelper" in {r.node_name for r in results}

    def test_no_deterministic_match_leaves_rrf_unchanged(self) -> None:
        storage = MagicMock()
        storage.fts_search.return_value = [
            SearchResult(node_id="a", score=0.5, node_name="validate"),
        ]
        storage.vector_search.return_value = []
        storage.exact_name_search.return_value = []
        storage.decorator_arg_search.return_value = []
        results = hybrid_search("validate user input", storage, query_embedding=None, limit=5)
        assert [r.node_id for r in results] == ["a"]


class TestDeprioritizedPathDownWeight:
    """HOR-430: example/demo/fixture/docs/test paths are softly down-weighted in the RRF merge
    so core code outranks demo/test code on a shared keyword — but never filtered out."""

    @staticmethod
    def _plain_storage() -> MagicMock:
        storage = MagicMock()
        # Neutralise the deterministic exact-match head so we test the RRF body alone.
        storage.exact_name_search.return_value = []
        storage.decorator_arg_search.return_value = []
        storage.exact_content_search.return_value = []
        storage.colocated_codes.return_value = []
        return storage

    def test_is_deprioritized_path(self) -> None:
        for p in [
            "examples/express/app.ts",
            "example/app.py",
            "samples/demo.ts",
            "demos/x.py",
            "docs/snippets/usage.py",
            "docs_src/tutorial/tutorial001.py",
            "tutorials/intro.py",
            "fixtures/data.py",
            "tests/test_login.py",
            "backend/tests/api/test_login.py",
            "src/app/handler.test.ts",
            "app/handler_test.py",
        ]:
            assert _is_deprioritized_path(p) is True, p
        for p in ["src/server.py", "pydantic/_internal/_core_utils.py", "lib/express/index.js"]:
            assert _is_deprioritized_path(p) is False, p

    def test_example_ranks_below_equal_strength_core_on_shared_keyword(self) -> None:
        storage = self._plain_storage()
        # The example hugs the keyword and would lead by raw RRF (rank 1); the soft penalty flips
        # it so the real source (rank 2) wins — yet the example is still returned (honesty).
        storage.fts_search.return_value = [
            SearchResult(node_id="ex", score=1.0, node_name="createServer", file_path="examples/basic/app.ts", label="function"),
            SearchResult(node_id="core", score=0.9, node_name="createServer", file_path="src/server.ts", label="function"),
        ]
        storage.vector_search.return_value = []
        results = hybrid_search("createServer", storage, query_embedding=None, limit=5)
        ids = [r.node_id for r in results]
        assert ids[0] == "core"
        assert "ex" in ids  # never filtered out

    def test_strong_example_still_surfaces_above_a_weak_core(self) -> None:
        storage = self._plain_storage()
        # The example is a strong, dual-list (FTS + vector) hit; the core is a single weak FTS hit.
        # The soft penalty only halves the example's score, so its strong signal still wins.
        storage.fts_search.return_value = [
            SearchResult(node_id="ex", score=1.0, node_name="run", file_path="examples/sync/run.ts", label="function"),
            SearchResult(node_id="x1", score=0.7, node_name="a", file_path="src/a.ts", label="function"),
            SearchResult(node_id="core", score=0.5, node_name="run", file_path="src/util/misc.ts", label="function"),
        ]
        storage.vector_search.return_value = [
            SearchResult(node_id="ex", score=0.99, node_name="run", file_path="examples/sync/run.ts", label="function"),
        ]
        results = hybrid_search("run sync", storage, query_embedding=[0.1, 0.2], limit=5)
        assert results[0].node_id == "ex"

    def test_example_only_repo_returns_all_examples_ranked(self) -> None:
        storage = self._plain_storage()
        # Every candidate is an example: a uniform penalty preserves their relative order and
        # returns them all (an example/docs library must still be searchable — honesty).
        storage.fts_search.return_value = [
            SearchResult(node_id="e1", score=1.0, node_name="one", file_path="examples/one.ts", label="function"),
            SearchResult(node_id="e2", score=0.8, node_name="two", file_path="examples/two.ts", label="function"),
        ]
        storage.vector_search.return_value = []
        results = hybrid_search("example", storage, query_embedding=None, limit=5)
        assert [r.node_id for r in results] == ["e1", "e2"]

    def test_exact_content_head_bypasses_the_path_penalty(self) -> None:
        # An anchored exact-content match (the raise site of a code token) is prepended ahead of
        # the RRF body and must NOT be penalised even if it lives under examples/ (mirrors the TS
        # "anchored exact seed" exemption).
        storage = self._plain_storage()
        storage.fts_search.return_value = [
            SearchResult(node_id="core", score=0.9, node_name="other", file_path="src/app.ts", label="function"),
        ]
        storage.vector_search.return_value = []
        storage.exact_content_search.return_value = [
            SearchResult(node_id="raise", score=1.0, node_name="emitErr", file_path="examples/demo/run.ts", label="function"),
        ]
        results = hybrid_search("E_FOO_BAR_01 failing", storage, query_embedding=None, limit=5)
        assert results[0].node_id == "raise"


class TestExactNameSeed:
    """An exact symbol-name token prepends that symbol ahead of semantic neighbours."""

    def test_exact_name_prepended_ahead_of_neighbor(self) -> None:
        storage = MagicMock()
        storage.fts_search.return_value = [
            SearchResult(node_id="neighbor", score=0.95, node_name="manageSalesHelper"),
        ]
        storage.vector_search.return_value = []
        storage.decorator_arg_search.return_value = []
        storage.exact_name_search.side_effect = lambda token, limit: (
            [SearchResult(node_id="exact", score=1.0, node_name="manageSalesForMarket", label="method")]
            if token == "manageSalesForMarket"
            else []
        )
        results = hybrid_search(
            "where is manageSalesForMarket", storage, query_embedding=None, limit=5
        )
        assert results[0].node_name == "manageSalesForMarket"

    def test_semantic_core_outranks_example_exact_name_false_friend(self) -> None:
        # HOR-430: a bare dictionary word in prose ("Event") names a symbol that only exists in an
        # example file. The exact-name head would force-promote that example Event to 1.0 ahead of
        # the semantically-related real cause. With the path-deprioritization of the name head, the
        # real (non-deprioritized) vector/FTS code wins, and the example Event is still returned.
        storage = MagicMock()
        storage.fts_search.return_value = []
        storage.vector_search.return_value = [
            SearchResult(node_id="close", score=0.67, node_name="close_connections", file_path="tortoise/backends/base/client.py", label="function"),
            SearchResult(node_id="closer", score=0.65, node_name="_close", file_path="tortoise/backends/asyncpg/client.py", label="method"),
        ]
        storage.decorator_arg_search.return_value = []
        storage.exact_content_search.return_value = []
        storage.colocated_codes.return_value = []
        storage.exact_name_search.side_effect = lambda token, limit: (
            [SearchResult(node_id="ex_event", score=1.0, node_name="Event", file_path="examples/relations/models.py", label="class")]
            if token == "Event"
            else []
        )
        results = hybrid_search(
            "Event loop never closes its connection", storage, query_embedding=[0.1, 0.2], limit=5
        )
        ids = [r.node_id for r in results]
        # The semantically-related core code leads; the lexical-only example Event is demoted but
        # NEVER filtered out (honesty).
        assert ids[0] == "close"
        assert "ex_event" in ids
        assert ids.index("close") < ids.index("ex_event")
        assert ids.index("closer") < ids.index("ex_event")

    def test_example_exact_name_still_prepended_when_no_real_candidate(self) -> None:
        # Escape hatch: when the RRF merge has NO real (non-deprioritized) candidate — an
        # example-only repo, or a hint genuinely targeting example code — the example exact-name
        # match is still prepended. A ranking aid must never become a filter.
        storage = MagicMock()
        storage.fts_search.return_value = [
            SearchResult(node_id="other_ex", score=0.9, node_name="helper", file_path="examples/util.py", label="function"),
        ]
        storage.vector_search.return_value = []
        storage.decorator_arg_search.return_value = []
        storage.exact_content_search.return_value = []
        storage.colocated_codes.return_value = []
        storage.exact_name_search.side_effect = lambda token, limit: (
            [SearchResult(node_id="ex_event", score=1.0, node_name="Event", file_path="examples/relations/models.py", label="class")]
            if token == "Event"
            else []
        )
        results = hybrid_search("Event model", storage, query_embedding=None, limit=5)
        assert results[0].node_id == "ex_event"

    def test_genuine_exact_name_on_real_path_still_leads_over_neighbor(self) -> None:
        # Regression guard: a real (non-deprioritized) exact-name hit must still be prepended ahead
        # of a semantic neighbour even when other real RRF candidates exist.
        storage = MagicMock()
        storage.fts_search.return_value = [
            SearchResult(node_id="neighbor", score=0.95, node_name="manageSalesHelper", file_path="src/sales.ts", label="function"),
        ]
        storage.vector_search.return_value = []
        storage.decorator_arg_search.return_value = []
        storage.exact_content_search.return_value = []
        storage.colocated_codes.return_value = []
        storage.exact_name_search.side_effect = lambda token, limit: (
            [SearchResult(node_id="exact", score=1.0, node_name="manageSalesForMarket", file_path="src/markets/sales.ts", label="method")]
            if token == "manageSalesForMarket"
            else []
        )
        results = hybrid_search("where is manageSalesForMarket", storage, query_embedding=None, limit=5)
        assert results[0].node_id == "exact"

    def test_decorator_arg_head_not_gated_by_path(self) -> None:
        # The decorator-arg head is a deliberate runtime-signal token, not a generic word, so it
        # stays anchored even on a deprioritized path while a real RRF candidate exists.
        storage = MagicMock()
        storage.fts_search.return_value = [
            SearchResult(node_id="core", score=0.9, node_name="other", file_path="src/app.ts", label="function"),
        ]
        storage.vector_search.return_value = []
        storage.exact_name_search.return_value = []
        storage.exact_content_search.return_value = []
        storage.colocated_codes.return_value = []
        storage.decorator_arg_search.side_effect = lambda token, limit: (
            [SearchResult(node_id="handler", score=1.0, node_name="onJob", file_path="examples/worker/jobs.ts", label="method")]
            if token == "MANAGE_SALES"
            else []
        )
        results = hybrid_search("MANAGE_SALES queue stuck", storage, query_embedding=None, limit=5)
        assert results[0].node_id == "handler"

    def test_exact_name_ranks_ahead_of_decorator_arg(self) -> None:
        # When both fire, the exact-name match (strongest signal) leads.
        storage = MagicMock()
        storage.fts_search.return_value = []
        storage.vector_search.return_value = []
        storage.exact_name_search.side_effect = lambda token, limit: (
            [SearchResult(node_id="byname", score=1.0, node_name="syncOrders", label="method")]
            if token == "syncOrders"
            else []
        )
        storage.decorator_arg_search.side_effect = lambda token, limit: (
            [SearchResult(node_id="byarg", score=1.0, node_name="otherHandler", label="method")]
            if token == "syncOrders"
            else []
        )
        results = hybrid_search("syncOrders", storage, query_embedding=None, limit=5)
        assert [r.node_id for r in results[:2]] == ["byname", "byarg"]


class TestNameSubstringChannel:
    """Dogfood cycle-2 N9: `router` must reach `APIRouter` — FTS tokenizes the name
    as one token and near-flat vector scores buried it below _private internals."""

    def test_name_containing_symbol_joins_the_merge(self) -> None:
        from unittest.mock import MagicMock

        storage = MagicMock()
        storage.fts_search.return_value = [
            SearchResult(node_id="f:_contains_router", score=0.9, node_name="_contains_router", file_path="fastapi/routing.py"),
        ]
        storage.vector_search.return_value = []
        storage.name_contains_search.return_value = [
            SearchResult(node_id="c:APIRouter", score=0.5, node_name="APIRouter", file_path="fastapi/routing.py", label="class"),
        ]
        storage.exact_name_search.return_value = []
        results = hybrid_search("router", storage, query_embedding=None, limit=10)
        names = [r.node_name for r in results]
        assert "APIRouter" in names
        storage.name_contains_search.assert_called_once()

    def test_multi_word_query_skips_the_name_channel(self) -> None:
        from unittest.mock import MagicMock

        storage = MagicMock()
        storage.fts_search.return_value = []
        storage.fuzzy_search.return_value = []
        storage.vector_search.return_value = []
        storage.exact_name_search.return_value = []
        hybrid_search("orders stuck in queue", storage, query_embedding=None, limit=10)
        storage.name_contains_search.assert_not_called()
