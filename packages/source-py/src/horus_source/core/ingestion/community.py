"""Phase 8: Community detection for Horus."""

from __future__ import annotations

import logging
import re
from collections import Counter
from pathlib import PurePosixPath

import igraph as ig
import leidenalg

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import (
    GraphNode,
    GraphRelationship,
    NodeLabel,
    RelType,
    generate_id,
)

logger = logging.getLogger(__name__)

_CALLABLE_LABELS: tuple[NodeLabel, ...] = (
    NodeLabel.FUNCTION,
    NodeLabel.METHOD,
    NodeLabel.CLASS,
)

_HERITAGE_EDGE_TYPES: tuple[RelType, ...] = (
    RelType.EXTENDS,
    RelType.IMPLEMENTS,
    RelType.USES_TYPE,
)
_CALLS_WEIGHT = 1.0
_HERITAGE_WEIGHT = 0.5


def export_to_igraph(
    graph: KnowledgeGraph,
) -> tuple[ig.Graph, dict[int, str]]:
    """Extract the call + heritage graph and build an igraph representation.

    Includes Function, Method, and Class nodes. CALLS edges get weight 1.0;
    EXTENDS, IMPLEMENTS, and USES_TYPE edges get weight 0.5 so heritage
    relationships influence community structure without dominating.

    Args:
        graph: The Horus knowledge graph.

    Returns:
        A tuple of ``(igraph_graph, vertex_index_to_node_id)`` where the
        mapping connects igraph vertex indices back to Horus node IDs.
    """
    node_id_to_index: dict[str, int] = {}
    index_to_node_id: dict[int, str] = {}

    for label in _CALLABLE_LABELS:
        for node in graph.get_nodes_by_label(label):
            idx = len(node_id_to_index)
            node_id_to_index[node.id] = idx
            index_to_node_id[idx] = node.id

    num_vertices = len(node_id_to_index)

    edge_list: list[tuple[int, int]] = []
    edge_weights: list[float] = []

    for rel in graph.get_relationships_by_type(RelType.CALLS):
        src_idx = node_id_to_index.get(rel.source)
        tgt_idx = node_id_to_index.get(rel.target)
        if src_idx is not None and tgt_idx is not None:
            edge_list.append((src_idx, tgt_idx))
            edge_weights.append(_CALLS_WEIGHT)

    for rel_type in _HERITAGE_EDGE_TYPES:
        for rel in graph.get_relationships_by_type(rel_type):
            src_idx = node_id_to_index.get(rel.source)
            tgt_idx = node_id_to_index.get(rel.target)
            if src_idx is not None and tgt_idx is not None:
                edge_list.append((src_idx, tgt_idx))
                edge_weights.append(_HERITAGE_WEIGHT)

    ig_graph = ig.Graph(directed=True)
    ig_graph.add_vertices(num_vertices)
    ig_graph.add_edges(edge_list)
    if edge_weights:
        ig_graph.es["weight"] = edge_weights

    return ig_graph, index_to_node_id

# Directory tokens that mark a test/example/docs tree — de-prioritized in community naming so a
# mixed core+test community isn't labelled after its tests (HOR-377).
_TEST_DIR_TOKENS = frozenset(
    {
        "test", "tests", "spec", "specs", "__tests__", "example", "examples",
        "sample", "samples", "demo", "demos", "docs", "doc", "tutorial", "tutorials",
        "fixture", "fixtures", "e2e", "testing",
    }
)

# Test-TIER tokens — the layer of the test pyramid, not a subsystem. A directory called
# ``unit``/``acceptance``/``integration`` describes the test policy, so it must never surface
# as a subsystem name (HOR-377, consistent with HOR-365). Demoted exactly like _TEST_DIR_TOKENS.
_TEST_TIER_TOKENS = frozenset(
    {
        "unit", "acceptance", "integration", "functional", "regression",
        "smoke", "system", "e2e", "endtoend", "end2end", "perf", "performance",
        "bench", "benchmarks", "benchmark", "stress", "contract",
    }
)

# Config-file / tooling tokens — derived from config files (pyproject, mypy, tox, ...) rather
# than from real subsystems. The base segment is matched, so "pyproject-plugin" and
# "mypy-default" are demoted too (HOR-377).
_CONFIG_TOKENS = frozenset(
    {
        "pyproject", "setup", "setuptools", "mypy", "tox", "flake8", "pylint",
        "ruff", "pytest", "conftest", "coveragerc", "coverage", "precommit",
        "pre", "manifest", "cfg", "ini", "toml", "editorconfig", "isort",
        "black", "nox", "noxfile", "makefile", "dockerfile",
    }
)

# All tokens demoted from subsystem labels: test trees, test tiers, and config-file names.
_DEMOTED_TOKENS = _TEST_DIR_TOKENS | _TEST_TIER_TOKENS | _CONFIG_TOKENS

# Split a directory token into its leading alpha-numeric segment so hyphen/underscore/dot
# compounds like "pyproject-plugin" reduce to "pyproject" for config-token matching.
_TOKEN_BASE_RE = re.compile(r"[-_.]")


def _title(name: str) -> str:
    """Capitalize the first letter WITHOUT lowercasing the rest.

    ``str.capitalize()`` lowercases the tail, turning acronyms into noise ("SQS" -> "Sqs"),
    so we only upcase the leading character (HOR-377).
    """
    return name[:1].upper() + name[1:] if name else name


def _is_demoted(token: str) -> bool:
    """True when a directory token is a test-tree, test-tier, or config-file name.

    Matches the whole lowercased token and its leading base segment, so "pyproject-plugin"
    and "mypy-default" are demoted alongside "pyproject" and "mypy" (HOR-377).
    """
    low = token.lower()
    if low in _DEMOTED_TOKENS:
        return True
    base = _TOKEN_BASE_RE.split(low, maxsplit=1)[0]
    return bool(base) and base in _CONFIG_TOKENS


def dominant_subsystems(graph: KnowledgeGraph, member_ids: list[str]) -> list[str]:
    """The ordered subsystem tokens for a community — the single source of truth (HOR-377).

    Both the community *header* (its label, via :func:`generate_label`) and the *list* of
    member subsystems derive from this one function, so the two always reflect the SAME test
    policy (header == list).

    Strategy:
    - Take each member's parent directory name, stripping leading ``_``/``.`` ("_ext" -> "ext").
    - DEMOTE test-tree, test-tier, and config-file tokens (unit/acceptance/integration/tests/
      e2e/pyproject/mypy/...) so they never become a subsystem name; fall back to the demoted
      tokens only when EVERY member is demoted (an all-test community is honestly named "Tests").
    - Count case-insensitively so "SQS" and "sqs" collapse to one entry ("SQS"), never "Sqs+sqs".
    - Return the one or two most frequent tokens, ORDER-INDEPENDENT (sorted) so a swapped pair
      ("Tortoise+Fields" vs "Fields+Tortoise") yields the same list.

    Returns an empty list when no usable file paths are available.
    """
    directories: list[str] = []
    for nid in member_ids:
        node = graph.get_node(nid)
        if node is not None and node.file_path:
            parent = PurePosixPath(node.file_path).parent.name.lstrip("_.")
            if parent:
                directories.append(parent)

    if not directories:
        return []

    preferred = [d for d in directories if not _is_demoted(d)]
    pool = preferred or directories

    counts: Counter[str] = Counter(d.lower() for d in pool)
    # Map each lowercased key back to its first-seen original casing (keeps "SQS", "gRPC").
    repr_by_lower: dict[str, str] = {}
    for d in pool:
        repr_by_lower.setdefault(d.lower(), d)

    top = [key for key, _ in counts.most_common(2)]
    # Sort the rendered tokens so the result is independent of token order/frequency ties:
    # {Tortoise, Fields} -> ["Fields", "Tortoise"] regardless of which came first.
    return sorted(_title(repr_by_lower[key]) for key in top)


def generate_label(graph: KnowledgeGraph, member_ids: list[str]) -> str:
    """Generate a heuristic label for a community from member file paths (HOR-377).

    The label is the ``+``-join of :func:`dominant_subsystems`, so the header is, by
    construction, exactly the listed subsystems under the same test policy. Falls back to
    ``"Cluster"`` when no usable file paths are available.
    """
    tokens = dominant_subsystems(graph, member_ids)
    if not tokens:
        return "Cluster"
    return "+".join(tokens)

def process_communities(
    graph: KnowledgeGraph,
    min_community_size: int = 2,
) -> int:
    """Detect communities in the call graph and add them to the knowledge graph.

    Uses the Leiden algorithm with modularity-based vertex partitioning.

    For each detected community that meets the minimum size threshold:
    - A :attr:`NodeLabel.COMMUNITY` node is created with a generated label
      and metadata (cohesion score, symbol count).
    - :attr:`RelType.MEMBER_OF` relationships are created from each member
      symbol to the community node.

    Args:
        graph: The knowledge graph to analyze and augment.
        min_community_size: Minimum number of members for a community to be
            created. Communities smaller than this are skipped.

    Returns:
        The number of community nodes created.
    """
    ig_graph, index_to_node_id = export_to_igraph(graph)

    if ig_graph.vcount() < 3:
        logger.debug(
            "Call graph too small for community detection (%d nodes), skipping.",
            ig_graph.vcount(),
        )
        return 0

    weights = ig_graph.es["weight"] if ig_graph.ecount() > 0 and "weight" in ig_graph.es.attributes() else None
    partition = leidenalg.find_partition(
        ig_graph, leidenalg.ModularityVertexPartition, weights=weights
    )

    # Group partitions by their generated label so that subsystems which Leiden split into
    # several blobs but which resolve to the SAME order-independent name collapse into ONE
    # community (HOR-377). This is what makes a swapped pair like "Tortoise+Fields" /
    # "Fields+Tortoise" a single cluster instead of two counted separately.
    grouped: dict[str, list[int]] = {}
    label_order: list[str] = []
    for members in partition:
        if len(members) < min_community_size:
            continue
        member_ids = [index_to_node_id[idx] for idx in members]
        label = generate_label(graph, member_ids)
        if label not in grouped:
            grouped[label] = []
            label_order.append(label)
        grouped[label].extend(members)

    community_count = 0
    for i, label in enumerate(label_order):
        members = grouped[label]
        member_ids = [index_to_node_id[idx] for idx in members]

        subgraph = ig_graph.induced_subgraph(members)
        n_members = len(members)
        max_edges = n_members * (n_members - 1)
        density = subgraph.ecount() / max_edges if max_edges > 0 else 0.0

        community_id = generate_id(NodeLabel.COMMUNITY, f"community_{i}")

        community_node = GraphNode(
            id=community_id,
            label=NodeLabel.COMMUNITY,
            name=label,
            properties={
                "cohesion": density,
                "symbol_count": len(member_ids),
            },
        )
        graph.add_node(community_node)

        for member_id in member_ids:
            rel_id = f"member_of:{member_id}->{community_id}"
            graph.add_relationship(
                GraphRelationship(
                    id=rel_id,
                    type=RelType.MEMBER_OF,
                    source=member_id,
                    target=community_id,
                )
            )

        community_count += 1
        logger.info(
            "Community %d: %r with %d members (density=%.3f)",
            i,
            label,
            len(member_ids),
            density,
        )

    logger.info(
        "Community detection complete: %d communities created.", community_count
    )
    return community_count
