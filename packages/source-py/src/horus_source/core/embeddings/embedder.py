"""Batch embedding pipeline for Horus knowledge graphs.

Takes a :class:`KnowledgeGraph`, generates natural-language descriptions for
each embeddable symbol node, encodes them using *fastembed*, and returns a
list of :class:`NodeEmbedding` objects ready for storage.

Only code-level symbol nodes are embedded.  Structural nodes (Folder,
Community, Process) are deliberately skipped — they lack the semantic
richness that makes embedding worthwhile.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from typing import TYPE_CHECKING

from horus_source.core.embeddings.cache import get_shared_cache, make_key
from horus_source.core.embeddings.text import build_class_method_index, generate_text
from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import NodeLabel
from horus_source.core.storage.base import EMBEDDING_DIMENSIONS, NodeEmbedding

if TYPE_CHECKING:
    from fastembed import TextEmbedding

logger = logging.getLogger(__name__)

_model_cache: dict[str, "TextEmbedding"] = {}
_model_lock = threading.Lock()

# nomic-embed-text REQUIRES task-instruction prefixes: queries are encoded with
# "search_query: " and documents with "search_document: ". The model was trained this
# way, and fastembed does NOT add them for us (query_embed and passage_embed return the
# IDENTICAL vector for the same text), so retrieval silently runs without the asymmetry
# the model expects — degrading semantic recall. We prepend the prefixes explicitly
# (query_embed/passage_embed add nothing themselves for this model, so this applies them
# exactly once).
# Ref: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5#usage
_QUERY_PREFIX = "search_query: "
_DOCUMENT_PREFIX = "search_document: "

# Identifies the embedding INPUT scheme — bump whenever a change would invalidate stored
# vectors even though the model name is unchanged: the task prefixes, or generate_text()'s
# output. ensure_current_embeddings() regenerates indexes whose meta records an older
# scheme, so a query encoded the new way is never compared against documents encoded the
# old way.
#   v1: nomic model, NO task prefixes, structural-only symbol text.
#   v2: nomic search_query/search_document prefixes + humanized identifier words.
EMBEDDING_SCHEME_VERSION = 2


def _uses_task_prefixes(model_name: str) -> bool:
    """Whether *model_name* is a nomic model that expects search_query/search_document."""
    return "nomic" in model_name.lower()


def _embed_thread_count() -> int:
    """Pinned ONNX thread count for REPRODUCIBLE embeddings (HOR-374).

    ONNX float-reduction order depends on the thread count, so deriving it from
    ``os.cpu_count()`` made embeddings differ across machines (and against the
    content-hash cache, which assumes determinism). Fixed default; override with
    ``HORUS_EMBED_THREADS`` (reproducibility holds only at a consistent value).
    """
    raw = os.environ.get("HORUS_EMBED_THREADS")
    if raw:
        try:
            n = int(raw)
            if n >= 1:
                return n
        except ValueError:
            pass
    return 4


def _get_model(model_name: str) -> "TextEmbedding":
    cached = _model_cache.get(model_name)
    if cached is not None:
        return cached
    with _model_lock:
        cached = _model_cache.get(model_name)
        if cached is not None:
            return cached
        from fastembed import TextEmbedding

        # Pinned thread count for reproducible embeddings (HOR-374) — see _embed_thread_count.
        model = TextEmbedding(model_name=model_name, threads=_embed_thread_count())
        _model_cache[model_name] = model
        return model


def _get_model_cache_clear() -> None:
    """Clear the model cache (used in tests)."""
    with _model_lock:
        _model_cache.clear()


_get_model.cache_clear = _get_model_cache_clear  # type: ignore[attr-defined]

# Labels worth embedding — skip Folder, Community, Process (structural only).
EMBEDDABLE_LABELS: frozenset[NodeLabel] = frozenset(
    {
        NodeLabel.FILE,
        NodeLabel.FUNCTION,
        NodeLabel.CLASS,
        NodeLabel.METHOD,
        NodeLabel.INTERFACE,
        NodeLabel.TYPE_ALIAS,
        NodeLabel.ENUM,
    }
)

_DEFAULT_MODEL = "nomic-ai/nomic-embed-text-v1.5"
_DEFAULT_DIMENSIONS = EMBEDDING_DIMENSIONS  # 384 via Matryoshka
# Embedding peak memory is dominated by the transformer's attention activations,
# which grow with batch_size * sequence_length^2. A large batch over long code
# texts can balloon to many GB and OOM the indexer; a small batch keeps peak
# roughly CONSTANT regardless of how many nodes the repo has (more nodes => more
# batches, not a bigger one). 8 keeps peak in the low-GBs while staying reasonably
# fast for a one-time index.
_DEFAULT_BATCH_SIZE = 8
# Cap per-node text so one very long symbol can't blow up a batch's activations.
# A symbol's signature/docstring/head easily fits; this also speeds tokenisation.
# nomic-embed-text accepts 8192 tokens; 2048 chars is a safe, fast per-node bound.
_MAX_TEXT_CHARS = 2048

# Embed in bounded chunks. fastembed/ONNX hold working memory proportional to the
# input handed to a single ``passage_embed`` call, so embedding every node at once
# makes peak memory scale with repo size (multi-GB → OOM on large repos). Embedding
# a fixed-size slice at a time and releasing between slices keeps peak ~constant.
_EMBED_CHUNK = 256


def embed_query(
    query: str,
    model_name: str = _DEFAULT_MODEL,
    dimensions: int = _DEFAULT_DIMENSIONS,
) -> list[float] | None:
    """Embed a single query string, returning ``None`` on failure."""
    if not query or not query.strip():
        return None
    try:
        model = _get_model(model_name)
        text = f"{_QUERY_PREFIX}{query}" if _uses_task_prefixes(model_name) else query
        vec = next(iter(model.query_embed(text)))
        return vec[:dimensions].tolist()
    except Exception:
        logger.warning("embed_query failed", exc_info=True)
        return None


def embed_text_document(
    text: str,
    model_name: str = _DEFAULT_MODEL,
    dimensions: int = _DEFAULT_DIMENSIONS,
) -> list[float] | None:
    """Embed a single free-text *document*, returning ``None`` on empty/failure.

    The document-side counterpart of :func:`embed_query`: it applies the same
    ``"search_document: "`` prefix, content-hash cache, embedding scheme and
    pinned thread count that :func:`_embed_node_list` uses for graph symbols, so a
    claim embedded here lands in the IDENTICAL vector space as code embeddings —
    which is what makes cross-store link-by-id (HORUS MEMORY) semantically
    meaningful. Unlike :func:`_embed_node_list` it is node-free: callers that hold
    only raw text (e.g. a memory claim) reuse this without re-deriving a
    ``NodeEmbedding`` id. Best-effort: any failure degrades to ``None`` so the
    caller treats vector indexing as optional and falls back to lexical recall.
    """
    if not text or not text.strip():
        return None
    try:
        add_prefix = _uses_task_prefixes(model_name)
        # Same encoding + cache key as the batched path, so a hit returns exactly
        # what re-embedding would produce (and a document embedded here is
        # comparable to a query embedded via embed_query's "search_query: ").
        encoded = f"{_DOCUMENT_PREFIX}{text}" if add_prefix else text
        cache = get_shared_cache()
        key = (
            make_key(model_name, EMBEDDING_SCHEME_VERSION, dimensions, encoded)
            if cache is not None
            else None
        )
        if key is not None:
            hit = cache.get_many([key]).get(key)
            if hit is not None:
                return hit
        model = _get_model(model_name)
        vec = next(iter(model.passage_embed([encoded])))[:dimensions].tolist()
        if key is not None:
            cache.put_many({key: vec})
        return vec
    except Exception:
        logger.warning("embed_text_document failed", exc_info=True)
        return None


def _embed_node_list(
    nodes: list,
    texts: list[str],
    model_name: str,
    batch_size: int,
    dimensions: int,
    on_chunk: Callable[[list[NodeEmbedding]], None] | None = None,
) -> list[NodeEmbedding]:
    """Embed a list of nodes with their corresponding texts.

    Uses the persistent content-hash cache (HOR-358): unchanged symbols (re-index)
    and code shared across repos hit the cache instead of re-embedding. Only cache
    misses are sent to the model, still in bounded chunks so peak memory stays
    ~constant regardless of repo size.

    When ``on_chunk`` is provided (resumable embedding — B1.2), each chunk's
    :class:`NodeEmbedding` batch is handed to the callback AND its content-hash
    cache entries are flushed *before* the next chunk is computed, so an
    interrupted run leaves the completed vectors durable in both sinks (code_vec
    and the cache) instead of everything landing only at end-of-run.
    """
    if not texts:
        return []

    add_prefix = _uses_task_prefixes(model_name)
    # Documents carry the "search_document: " prefix so they match how queries are
    # encoded ("search_query: ") — see the _QUERY_PREFIX note above. This exact string
    # (prefix included) is what the cache keys on, so a hit returns precisely what
    # re-embedding would produce.
    encoded = [f"{_DOCUMENT_PREFIX}{t}" if add_prefix else t for t in texts]

    cache = get_shared_cache()
    keys = (
        [make_key(model_name, EMBEDDING_SCHEME_VERSION, dimensions, e) for e in encoded]
        if cache is not None
        else None
    )

    vec_by_idx: dict[int, list[float]] = {}
    if keys is not None:
        hits = cache.get_many(keys)
        for i, k in enumerate(keys):
            v = hits.get(k)
            if v is not None:
                vec_by_idx[i] = v

    # When streaming, persist cache-hit vectors immediately: a missing node can be
    # a content-hash HIT (vector known) whose code_vec row was never written. Emitting
    # these upfront makes them durable before the (expensive) miss-compute runs.
    if on_chunk is not None and vec_by_idx:
        hit_idx = sorted(vec_by_idx)
        on_chunk(
            [NodeEmbedding(node_id=nodes[i].id, embedding=vec_by_idx[i]) for i in hit_idx]
        )

    miss_idx = [i for i in range(len(texts)) if i not in vec_by_idx]
    if miss_idx:
        model = _get_model(model_name)
        to_put: dict[str, list[float]] = {}
        # Process a bounded slice at a time so peak memory stays ~constant regardless
        # of how many nodes the repo has. Each vector is immediately reduced to a small
        # truncated float list; the heavy numpy/ONNX intermediates are freed per chunk.
        for start in range(0, len(miss_idx), _EMBED_CHUNK):
            chunk_idx = miss_idx[start : start + _EMBED_CHUNK]
            chunk_encoded = [encoded[i] for i in chunk_idx]
            chunk_put: dict[str, list[float]] = {}
            for i, vector in zip(
                chunk_idx, model.passage_embed(chunk_encoded, batch_size=batch_size)
            ):
                vec = vector[:dimensions].tolist()
                vec_by_idx[i] = vec
                if keys is not None:
                    chunk_put[keys[i]] = vec
            if on_chunk is not None:
                # Per-chunk durability (B1.2): persist this chunk's vectors and flush
                # its cache entries before computing the next, so a crash keeps done work.
                on_chunk(
                    [
                        NodeEmbedding(node_id=nodes[i].id, embedding=vec_by_idx[i])
                        for i in chunk_idx
                    ]
                )
                if keys is not None and chunk_put:
                    cache.put_many(chunk_put)
            elif keys is not None:
                to_put.update(chunk_put)
        if on_chunk is None and keys is not None and to_put:
            cache.put_many(to_put)

    return [
        NodeEmbedding(node_id=nodes[i].id, embedding=vec_by_idx[i])
        for i in range(len(texts))
    ]


def embed_graph(
    graph: KnowledgeGraph,
    model_name: str = _DEFAULT_MODEL,
    batch_size: int = _DEFAULT_BATCH_SIZE,
    dimensions: int = _DEFAULT_DIMENSIONS,
) -> list[NodeEmbedding]:
    """Generate embeddings for all embeddable nodes in the graph.

    Uses fastembed's :class:`TextEmbedding` model for batch encoding.
    Each embeddable node is converted to a natural-language description
    via :func:`generate_text`, then embedded in a single batch call.

    Args:
        graph: The knowledge graph whose nodes should be embedded.
        model_name: The fastembed model identifier.  Defaults to
            ``"nomic-ai/nomic-embed-text-v1.5"``.
        batch_size: Number of texts to encode per batch.  Defaults to 128.
        dimensions: Number of dimensions for Matryoshka truncation.
            Defaults to 384.

    Returns:
        A list of :class:`NodeEmbedding` instances, one per embeddable node,
        each carrying the node's ID and its embedding vector as a plain
        Python ``list[float]``.
    """
    all_nodes = [n for n in graph.iter_nodes() if n.label in EMBEDDABLE_LABELS]
    if not all_nodes:
        return []

    class_method_idx = build_class_method_index(graph)

    texts: list[str] = []
    nodes = []
    for node in all_nodes:
        text = generate_text(node, graph, class_method_idx)
        if text and text.strip():
            texts.append(text[:_MAX_TEXT_CHARS])
            nodes.append(node)

    if not texts:
        return []

    return _embed_node_list(nodes, texts, model_name, batch_size, dimensions)


def embed_missing(
    graph: KnowledgeGraph,
    already_embedded: set[str],
    persist: Callable[[list[NodeEmbedding]], None],
    model_name: str = _DEFAULT_MODEL,
    batch_size: int = _DEFAULT_BATCH_SIZE,
    dimensions: int = _DEFAULT_DIMENSIONS,
) -> tuple[int, int]:
    """Embed ONLY the embeddable nodes not already in *already_embedded* (B1.2).

    The resumable driver: it applies the same label/text filtering as
    :func:`embed_graph`, computes the full set of ``target_ids`` (embeddable nodes
    with non-empty text), and sends only those NOT in *already_embedded* to the
    model. Each computed chunk is streamed to *persist* (e.g.
    ``storage.upsert_embeddings``) as it is produced, so an interrupted run leaves
    the finished vectors durable and the next call resumes on the remainder.

    Args:
        graph: The knowledge graph whose nodes should be embedded.
        already_embedded: node_ids that already have a persisted vector (the diff
            key, from :meth:`StorageBackend.get_embedded_node_ids`).
        persist: Called per chunk with the freshly produced NodeEmbeddings.

    Returns:
        ``(n_target, n_computed)`` — the number of embeddable-with-text nodes and
        how many of them were missing and just computed. Completeness is derivable
        by the caller as ``target_ids <= already_embedded ∪ computed``.
    """
    all_nodes = [n for n in graph.iter_nodes() if n.label in EMBEDDABLE_LABELS]
    if not all_nodes:
        return (0, 0)

    class_method_idx = build_class_method_index(graph)

    target_count = 0
    missing_nodes = []
    missing_texts: list[str] = []
    for node in all_nodes:
        text = generate_text(node, graph, class_method_idx)
        if not (text and text.strip()):
            continue
        target_count += 1
        if node.id in already_embedded:
            continue
        missing_nodes.append(node)
        missing_texts.append(text[:_MAX_TEXT_CHARS])

    if missing_texts:
        _embed_node_list(
            missing_nodes,
            missing_texts,
            model_name,
            batch_size,
            dimensions,
            on_chunk=persist,
        )

    return (target_count, len(missing_texts))


def embed_nodes(
    graph: KnowledgeGraph,
    node_ids: set[str],
    model_name: str = _DEFAULT_MODEL,
    batch_size: int = _DEFAULT_BATCH_SIZE,
    dimensions: int = _DEFAULT_DIMENSIONS,
) -> list[NodeEmbedding]:
    """Like :func:`embed_graph`, but only for the given *node_ids*."""
    if not node_ids:
        return []
    nodes = [graph.get_node(nid) for nid in node_ids]
    nodes = [n for n in nodes if n is not None and n.label in EMBEDDABLE_LABELS]
    if not nodes:
        return []

    class_method_idx = build_class_method_index(graph)

    texts: list[str] = []
    valid_nodes = []
    for node in nodes:
        text = generate_text(node, graph, class_method_idx)
        if text and text.strip():
            texts.append(text[:_MAX_TEXT_CHARS])
            valid_nodes.append(node)

    if not texts:
        return []

    return _embed_node_list(valid_nodes, texts, model_name, batch_size, dimensions)
