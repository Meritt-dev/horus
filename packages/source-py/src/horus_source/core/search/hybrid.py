"""Hybrid search combining full-text and vector search via Reciprocal Rank Fusion.

Reciprocal Rank Fusion (RRF) merges ranked lists from different retrieval
systems into a single ranking.  Each document receives a score::

    RRF_score(d) = sum_r  weight_r / (k + rank_r(d))

where *k* is a smoothing constant (default 60) that prevents high-ranked items
from dominating, *rank_r(d)* is the 1-based position of document *d* in ranker
*r*'s result list, and *weight_r* scales that ranker's contribution.
"""

from __future__ import annotations

import re
from dataclasses import replace

from horus_source.core.classify import is_product
from horus_source.core.storage.base import SearchResult, StorageBackend

# A code-shaped token: an UPPER token (>=4 chars) of [A-Z0-9_] containing a digit or underscore
# — error codes / log keys (E_FULFILLMENT_SYNC_ERROR_04, ERR243_09, ERR4624). Excludes plain
# ALLCAPS such as URL/API/JSON. Format-agnostic — no assumption about how codes are declared.
_CODE_TOKEN_RE = re.compile(r"\b(?=[A-Z0-9_]*[0-9_])[A-Z][A-Z0-9_]{3,}\b")

# Hint tokens that can name a symbol or a runtime wiring value. Covers identifiers
# (manageSalesForMarket, MANAGE_SALES, syncOrders), dotted/colon message patterns
# (order.created, user:updated) and slash routes (/orders, /api/orders). >=3 chars to skip
# noise words; the deterministic lookups themselves require an EXACT match, so over-generating
# candidate tokens here is harmless — a non-matching token simply yields nothing.
_HINT_TOKEN_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_./:-]{2,}")

# Soft multiplier applied to a deprioritized candidate's RRF score. < 1.0 so core code outranks
# demo/test code on a *shared keyword*, yet > 0 so a STRONG match in such a file is only
# down-weighted, never removed — an example-only repo still returns its examples, correctly
# ranked. This is a ranking aid ONLY: it never changes verdicts, confidence, or the deterministic
# exact-match head (exact name / decorator-arg / exact-content seeds bypass it entirely).
_DEPRIORITIZED_PATH_WEIGHT = 0.5


def _is_deprioritized_path(file_path: str) -> bool:
    """True when *file_path* is not product code (HOR-430) — test / docs / example /
    vendored / config, per the shared classifier. Their symbols hug a shared keyword
    and embed with similar vectors, bubbling above the real library/app source."""
    return bool(file_path) and not is_product(file_path)


def hybrid_search(
    query: str,
    storage: StorageBackend,
    query_embedding: list[float] | None = None,
    limit: int = 20,
    fts_weight: float = 1.0,
    vector_weight: float = 1.0,
    rrf_k: int = 60,
) -> list[SearchResult]:
    """Run hybrid search combining FTS and vector search with RRF.

    Parameters:
        query: The text query for keyword search.
        storage: The storage backend to search against.
        query_embedding: Pre-computed query embedding vector.
            If ``None``, only full-text search is used.
        limit: Maximum number of results to return.
        fts_weight: Weight multiplier for FTS results in RRF scoring.
        vector_weight: Weight multiplier for vector results in RRF scoring.
        rrf_k: RRF smoothing constant (standard value is 60).

    Returns:
        Merged list of :class:`SearchResult` sorted by combined RRF score,
        highest first.
    """
    if limit <= 0:
        return []

    candidate_limit = min(limit * 3, 300)

    fts_results = storage.fts_search(query, limit=candidate_limit)

    if not fts_results and hasattr(storage, "fuzzy_search"):
        fts_results = storage.fuzzy_search(query, limit=candidate_limit)

    vector_results: list[SearchResult] = []
    if query_embedding is not None:
        vector_results = storage.vector_search(query_embedding, limit=candidate_limit)

    # Name-substring channel (dogfood cycle-2 N9): FTS tokenizes `APIRouter` as ONE
    # token, so the query `router` never reaches it, and near-flat vector scores bury
    # it — fastapi's marquee class missed the top-20 entirely while _private internals
    # filled the page. A symbol whose NAME contains the query token is prime evidence
    # for a symbol search; single-token queries only (a multi-word query is a concept,
    # not a name fragment).
    name_results: list[SearchResult] = []
    if " " not in query.strip() and hasattr(storage, "name_contains_search"):
        name_results = storage.name_contains_search(query.strip(), limit=candidate_limit)

    rrf_scores: dict[str, float] = {}
    metadata: dict[str, SearchResult] = {}

    _accumulate_ranks(fts_results, fts_weight, rrf_k, rrf_scores, metadata)
    _accumulate_ranks(vector_results, vector_weight, rrf_k, rrf_scores, metadata)
    _accumulate_ranks(name_results, 1.2, rrf_k, rrf_scores, metadata)

    merged: list[SearchResult] = []
    for node_id, score in rrf_scores.items():
        source = metadata[node_id]
        # HOR-430: soft down-weight example/demo/fixture/docs/test paths so core code outranks
        # them on a shared keyword. A soft multiplier (never a filter): a strong match in such a
        # file is merely down-weighted and still surfaces, and an example-only repo still returns
        # all its examples ranked among themselves. The deterministic exact-match head below
        # (exact name / decorator-arg / exact-content) is built separately and is NOT penalised.
        if _is_deprioritized_path(source.file_path):
            score *= _DEPRIORITIZED_PATH_WEIGHT
        merged.append(
            replace(source, score=score),
        )

    merged.sort(key=lambda r: r.score, reverse=True)

    # Deterministic seed matches are prepended ahead of the probabilistic RRF ranking, in
    # descending order of how precisely the query pins a single symbol:
    #   1. exact symbol-name match  — the query token IS the symbol's name;
    #   2. decorator-argument match — a runtime signal name (queue/route/job/pattern) wired to
    #      its handler via @Processor('Q') / @Get('/x') / @Process('job') / @MessagePattern(...);
    #   3. HOR-329 exact-content match for error-code / log-key tokens.
    # Each is additive: when none fire, the RRF result is returned unchanged.
    head: list[SearchResult] = []
    seen: set[str] = set()

    def _add(results: list[SearchResult]) -> None:
        for r in results:
            if r.node_id not in seen:
                seen.add(r.node_id)
                head.append(r)

    hint_tokens = list(dict.fromkeys(_HINT_TOKEN_RE.findall(query)))

    # 1. Exact symbol-name match (right-file/right-function): prefer executable, non-test.
    #
    # HOR-430: the exact-name head bypasses RRF *and* the path penalty entirely, so a bare
    # dictionary word that happens to appear in prose (e.g. "Event", "Order") and also names a
    # symbol in an example/demo/test file gets force-promoted to score 1.0 ahead of the
    # semantically-correct core code. That is exactly the false-friend the RRF down-weight cannot
    # reach, because the head fills every `limit` slot before the penalised tail is ever consulted.
    #
    # Fix: subject the exact-name head to the same path-deprioritization as the RRF tail, mirroring
    # the engine's rankSeeds "hasReal" rule — when the RRF merge already contains a real
    # (non-deprioritized) candidate, an exact-name hit on a deprioritized path is NOT prepended; it
    # is left for the (already path-penalised) RRF tail to place, so semantically-related core code
    # wins. Honesty-safe: this is a reorder, never a filter. If NO real candidate exists (an
    # example-only repo, or a hint that genuinely targets example code), the example/test exact-name
    # matches are still prepended via the escape hatch below. Only block 1 (bare symbol names) is
    # gated; the decorator-arg and exact-content heads stay anchored regardless of path, because
    # they are triggered by a deliberate runtime/code-shaped token rather than a generic word.
    demoted_name_hits: list[SearchResult] = []
    demoted_ids: set[str] = set()
    name_fn = getattr(storage, "exact_name_search", None)
    if callable(name_fn):
        has_real_candidate = any(
            not _is_deprioritized_path(r.file_path) for r in merged
        )
        for token in hint_tokens:
            for r in name_fn(token, limit):
                if r.node_id in seen or r.node_id in demoted_ids:
                    continue
                if has_real_candidate and _is_deprioritized_path(r.file_path):
                    # Demote: do not prepend. If it is in the RRF merge it stays in the tail at its
                    # path-penalised position; otherwise it is appended last (still returned).
                    demoted_ids.add(r.node_id)
                    demoted_name_hits.append(r)
                else:
                    seen.add(r.node_id)
                    head.append(r)

    # 2. Decorator-argument match (runtime signal -> handler symbol).
    decarg_fn = getattr(storage, "decorator_arg_search", None)
    if callable(decarg_fn):
        for token in hint_tokens:
            _add(decarg_fn(token, limit))

    # 3. HOR-329: an error-code / log-key token shreds into generic FTS tokens (fulfillment/
    # sync/error) and embeds fuzzily, so neither ranker above can pick out the raise site —
    # but the intact code is verbatim in the raising function's content.
    exact_fn = getattr(storage, "exact_content_search", None)
    if callable(exact_fn):
        alias_fn = getattr(storage, "colocated_codes", None)
        for code in dict.fromkeys(_CODE_TOKEN_RE.findall(query)):
            direct = exact_fn(code, limit)
            if any(r.label in ("function", "method") for r in direct):
                _add(direct)
            elif callable(alias_fn):
                # Display-code → raise-site (HOR-329): a numeric code (ERR4624) lives only in a
                # constants object next to its logical key and never in the raising function;
                # resolve the enclosing logical key, then ITS raise site.
                resolved: list[SearchResult] = []
                for alias in alias_fn(code):
                    resolved.extend(exact_fn(alias, limit))
                _add(resolved if resolved else direct)
            else:
                _add(direct)

    if head or demoted_name_hits:
        tail = [r for r in merged if r.node_id not in seen]
        tail_ids = {r.node_id for r in tail}
        # Demoted exact-name hits absent from the RRF tail are appended last so they are reordered
        # to the back but never filtered out (honesty: a ranking aid, never a filter).
        extra = [r for r in demoted_name_hits if r.node_id not in tail_ids and r.node_id not in seen]
        return (head + tail + extra)[:limit]

    return merged[:limit]

def _accumulate_ranks(
    results: list[SearchResult],
    weight: float,
    k: int,
    scores: dict[str, float],
    metadata: dict[str, SearchResult],
) -> None:
    """Add RRF contributions from a single ranked list.

    Only the first occurrence of each ``node_id`` in *results* is considered
    (i.e. duplicates within the same list are ignored).
    """
    seen: set[str] = set()
    for rank_0, result in enumerate(results):
        nid = result.node_id
        if nid in seen:
            continue
        seen.add(nid)

        rank_1 = rank_0 + 1  # 1-based rank
        scores[nid] = scores.get(nid, 0.0) + weight / (k + rank_1)

        if nid not in metadata:
            metadata[nid] = result
