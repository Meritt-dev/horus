"""Storage backend abstraction for Horus.

Defines the :class:`StorageBackend` protocol that all concrete storage
implementations (KuzuDB, Neo4j, in-memory, etc.) must satisfy, along with
supporting data classes for search results and embeddings.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import GraphNode, GraphRelationship, RelType


@dataclass
class SearchResult:
    """A single result from a full-text or vector search."""

    node_id: str
    score: float
    node_name: str = ""
    file_path: str = ""
    label: str = ""
    snippet: str = ""

EMBEDDING_DIMENSIONS: int = 384
"""Number of dimensions expected for all embedding vectors."""



@dataclass
class NodeEmbedding:
    """An embedding vector associated with a graph node."""

    node_id: str
    embedding: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.embedding and len(self.embedding) != EMBEDDING_DIMENSIONS:
            raise ValueError(
                f"Expected embedding of {EMBEDDING_DIMENSIONS} dimensions, "
                f"got {len(self.embedding)}"
            )

@runtime_checkable
class StorageBackend(Protocol):
    """Protocol that every Horus storage backend must implement.

    Covers the full lifecycle of graph persistence: initialisation,
    CRUD operations on nodes and relationships, querying, full-text
    search, vector search, and incremental re-indexing support.
    """

    def initialize(self, path: Path) -> None:
        """Open or create the backing store at *path*."""
        ...

    def close(self) -> None:
        """Release resources held by the backend."""
        ...

    def add_nodes(self, nodes: list[GraphNode]) -> None:
        """Insert or upsert a batch of nodes."""
        ...

    def add_relationships(self, rels: list[GraphRelationship]) -> None:
        """Insert or upsert a batch of relationships."""
        ...

    def remove_nodes_by_file(self, file_path: str) -> int:
        """Remove all nodes originating from *file_path*.

        Returns:
            The number of nodes removed.
        """
        ...

    def get_inbound_cross_file_edges(
        self, file_path: str, exclude_source_files: set[str] | None = None,
    ) -> list[GraphRelationship]:
        """Return inbound edges where the target is in *file_path* and the source is not.

        Args:
            file_path: Target file whose inbound edges to collect.
            exclude_source_files: Source file paths to skip.
        """
        ...

    def get_node(self, node_id: str) -> GraphNode | None:
        """Return a single node by ID, or ``None`` if not found."""
        ...

    def get_callers(self, node_id: str) -> list[GraphNode]:
        """Return nodes that call the node identified by *node_id*."""
        ...

    def get_callees(self, node_id: str) -> list[GraphNode]:
        """Return nodes called by the node identified by *node_id*."""
        ...

    def get_type_refs(self, node_id: str) -> list[GraphNode]:
        """Return nodes that reference the type identified by *node_id*."""
        ...

    def get_callers_with_confidence(self, node_id: str) -> list[tuple[GraphNode, float]]:
        """Return ``(node, confidence)`` pairs for all nodes that CALL *node_id*."""
        ...

    def get_callees_with_confidence(self, node_id: str) -> list[tuple[GraphNode, float]]:
        """Return ``(node, confidence)`` pairs for all nodes called by *node_id*."""
        ...

    def traverse(self, start_id: str, depth: int, direction: str = "callers") -> list[GraphNode]:
        """Breadth-first traversal up to *depth* hops from *start_id*.

        Args:
            direction: ``"callers"`` follows incoming CALLS (blast radius),
                       ``"callees"`` follows outgoing CALLS (dependencies).
        """
        ...

    def traverse_with_depth(
        self,
        start_id: str,
        depth: int,
        direction: str = "callers",
        *,
        product_only: bool = False,
    ) -> list[tuple[GraphNode, int]]:
        """BFS traversal returning ``(node, hop_depth)`` pairs.

        Same semantics as :meth:`traverse` but preserves the hop distance
        (1-based) so callers can group results by proximity. With
        ``product_only=True``, non-product nodes (per
        :mod:`horus_source.core.classify`) are neither reported nor traversed
        through — a test node cuts the walk.
        """
        ...

    def get_process_memberships(self, node_ids: list[str]) -> dict[str, str]:
        """Return ``{node_id: process_name}`` for nodes belonging to a Process."""
        ...

    def execute_raw(self, query: str) -> Any:
        """Execute a raw backend-specific query string."""
        ...

    def name_contains_search(self, token: str, limit: int = 20) -> list[SearchResult]:
        """Symbols whose ``name`` contains *token* (case-insensitive substring).

        The retrieval channel FTS can't provide (`router` → `APIRouter`); public
        names rank before underscore-private, shorter before longer.
        """
        ...

    def exact_name_search(self, name: str, limit: int = 5) -> list[SearchResult]:
        """Search for nodes with an exact name match."""
        ...

    def fts_search(self, query: str, limit: int) -> list[SearchResult]:
        """Full-text search across indexed node content."""
        ...

    def fuzzy_search(
        self, query: str, limit: int, max_distance: int = 2
    ) -> list[SearchResult]:
        """Fuzzy name search by edit distance."""
        ...

    def store_embeddings(self, embeddings: list[NodeEmbedding]) -> None:
        """Persist embedding vectors for the given nodes."""
        ...

    def vector_search(self, vector: list[float], limit: int) -> list[SearchResult]:
        """Find the closest nodes to *vector* by cosine similarity."""
        ...

    def get_indexed_files(self) -> dict[str, str]:
        """Return a mapping of ``{file_path: content_hash}`` for all indexed files."""
        ...

    def load_graph(self) -> KnowledgeGraph:
        """Reconstruct a full :class:`KnowledgeGraph` from the backing store."""
        ...

    def bulk_load(self, graph: KnowledgeGraph) -> None:
        """Replace the entire store contents with *graph*."""
        ...

    def delete_synthetic_nodes(self) -> None:
        """Remove all COMMUNITY and PROCESS nodes and their relationships."""
        ...

    def upsert_embeddings(self, embeddings: list[NodeEmbedding]) -> None:
        """Insert or update embeddings without wiping existing ones."""
        ...

    def update_dead_flags(self, dead_ids: set[str], alive_ids: set[str]) -> None:
        """Set is_dead=True on *dead_ids* and is_dead=False on *alive_ids*."""
        ...

    def remove_relationships_by_type(self, rel_type: RelType) -> None:
        """Delete all relationships of a specific type."""
        ...

    def get_file_index(self) -> dict[str, str]:
        """Return ``{file_path: node_id}`` for all File nodes."""
        ...

    def get_symbol_name_index(self) -> dict[str, list[str]]:
        """Return ``{symbol_name: [node_id, ...]}`` for callable/type symbols."""
        ...

    def rebuild_fts_indexes(self) -> None:
        """Drop and recreate all FTS indexes after bulk data changes."""
        ...

    # ------------------------------------------------------------------ analytics
    # Typed replacements for the raw analytic Cypher/SQL that web routes and MCP
    # tools used to embed via ``execute_raw`` (HOR-392 stage 2). Each returns a
    # plain Python structure so callers stay backend-agnostic.

    def count_nodes_by_label(self) -> dict[str, int]:
        """Return ``{label_value: count}`` over every node (lowercase label keys)."""
        ...

    def count_edges_by_type(self) -> dict[str, int]:
        """Return ``{rel_type: count}`` over every relationship."""
        ...

    def get_dead_code_symbols(self) -> list[tuple[str, str, str, int, str]]:
        """Return ``(id, name, file_path, start_line, label)`` for every dead symbol."""
        ...

    def get_coupling_pairs(self) -> list[tuple[str, str, str, str, float, int]]:
        """Return ``(name_a, file_a, name_b, file_b, strength, co_changes)`` per coupled pair."""
        ...

    def get_coupling_strengths(self) -> list[float]:
        """Return the ``strength`` of every COUPLED_WITH edge."""
        ...

    def get_communities_with_members(
        self,
    ) -> list[tuple[str, str, float | None, list[str]]]:
        """Return ``(id, name, cohesion, member_ids)`` for every community."""
        ...

    def count_communities(self) -> int:
        """Return the number of Community nodes."""
        ...

    def avg_calls_confidence(self) -> float | None:
        """Return the mean confidence across all CALLS edges, or ``None`` if none."""
        ...

    def count_symbols_and_dead(self) -> tuple[int, int]:
        """Return ``(total_symbols, dead_symbols)`` over Function/Method/Class (start_line>0)."""
        ...

    def count_embeddings(self) -> int:
        """Return the number of persisted embedding vectors in the store.

        Used by the host-start self-heal to detect a store that serves 0 embeddings while
        meta records symbols — a stale/legacy/interrupted index that must be rebuilt
        rather than served unsearchable (HOR-433).
        """
        ...

    def count_callables_in_processes(self) -> tuple[int, int]:
        """Return ``(callable_count, in_process_count)`` over Function/Method."""
        ...

    def get_file_nodes(self) -> list[tuple[str, str, str, str]]:
        """Return ``(id, name, file_path, language)`` for every File node."""
        ...

    def get_symbol_counts_by_file(self) -> dict[str, int]:
        """Return ``{file_path: symbol_count}`` for nodes with a file and a body."""
        ...

    def get_processes_with_steps(
        self,
    ) -> list[tuple[str, str, list[str], list[int | None]]]:
        """Return ``(id, name, member_node_ids, step_numbers)`` per Process, ordered by name."""
        ...

    def get_symbols_in_file(self, file_path: str) -> list[GraphNode]:
        """Return every symbol node defined in *file_path* (start_line>0)."""
        ...

    def get_file_imports(self, file_path: str) -> list[str]:
        """Return file paths that *file_path* imports (outgoing IMPORTS)."""
        ...

    def get_file_importers(self, file_path: str) -> list[str]:
        """Return file paths that import *file_path* (incoming IMPORTS)."""
        ...

    def get_file_coupling(self, file_path: str) -> list[tuple[str, float, int]]:
        """Return ``(coupled_file, strength, co_changes)`` for *file_path*, strongest first."""
        ...

    def get_heritage(self, node_id: str) -> list[tuple[str, str, str]]:
        """Return ``(parent_name, parent_file, rel_type)`` for EXTENDS/IMPLEMENTS edges."""
        ...

    def get_node_communities(self, node_id: str) -> list[str]:
        """Return the community name(s) *node_id* belongs to."""
        ...

    def get_node_processes(self, node_id: str) -> list[str]:
        """Return the process name(s) *node_id* is a step in."""
        ...

    def get_community_members(
        self, name: str
    ) -> list[tuple[str, str, str, int, bool, bool]]:
        """Return ``(name, label, file_path, start_line, is_entry, is_exported)`` per member."""
        ...

    def get_communities_summary(self) -> list[tuple[str, float, str]]:
        """Return ``(name, cohesion, properties_json)`` per community, highest cohesion first."""
        ...

    def get_cross_community_processes(self) -> list[tuple[str, list[str]]]:
        """Return ``(process_name, community_names)`` for processes spanning >1 community."""
        ...

    def get_file_community_counts(self, file_path: str) -> list[tuple[str, int]]:
        """Return ``(community_name, member_count)`` for communities touched by *file_path*."""
        ...

    # ------------------------------------------------------------------ CLI read path
    # Typed, backend-agnostic endpoints that back the CLI's read path (HOR-392
    # Option A). They let the CLI consume the graph through HTTP/typed calls
    # instead of emitting Cypher, so the same client works against either backend.

    def content_contains_any(self, tokens: list[str], limit: int) -> list[dict[str, Any]]:
        """Nodes whose ``content`` contains ANY of *tokens* (case-insensitive substring).

        Returns up to *limit* dicts with the **full** (untruncated) ``id``, ``name``,
        ``file_path`` and ``content``, ordered by ``id``. Structural/synthetic nodes
        (folder/community/process) are excluded — they carry no searchable code. This
        unblocks the CLI stitcher, which needs the whole body, not a 200-char snippet.
        """
        ...

    def files_containing(
        self, tokens: list[str], per_token_limit: int
    ) -> dict[str, list[str]]:
        """Distinct file paths whose FILE-node content contains each token.

        Returns ``{token: [file_path, ...]}`` with up to *per_token_limit* paths per
        token (case-insensitive substring, file nodes only — whole-file content).
        Per-token budgets, unlike :meth:`content_contains_any`'s shared limit, so a
        common token can't crowd rarer ones out. Backs external-system detection in
        the engine's `architecture` discovery (the Cypher seam it replaces died in
        the kùzu→SQLite migration).
        """
        ...

    def flows_for_symbol(self, node_id: str) -> dict[str, list[dict[str, Any]]]:
        """Return the process flows *node_id* participates in, with their ordered steps.

        ``{"processes": [{"id", "name"}], "steps": [{"id", "name", "file_path",
        "start_line", "step_number"}]}`` where ``processes`` are the Process nodes
        *node_id* is a step in, and ``steps`` are every step of those processes ordered
        by ``step_number`` (deduplicated). Unlike :meth:`get_processes_with_steps`, the
        steps carry their symbol names.
        """
        ...

    def symbols_by_label(self, labels: list[str], limit: int) -> list[dict[str, Any]]:
        """Return symbol nodes for the given lowercase *labels* (for source-graph extraction).

        Up to *limit* dicts with ``id``, ``label``, ``name``, ``file_path``,
        ``start_line``, ``end_line``, ``class_name``, ``is_entry_point``,
        ``is_exported`` and ``signature``, ordered by ``(file_path, start_line, id)``.
        """
        ...
