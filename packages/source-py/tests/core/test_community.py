from __future__ import annotations

import pytest

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import (
    GraphNode,
    GraphRelationship,
    NodeLabel,
    RelType,
    generate_id,
)
from horus_source.core.ingestion.community import (
    dominant_subsystems,
    export_to_igraph,
    generate_label,
    process_communities,
)


def _add_function(
    graph: KnowledgeGraph,
    file_path: str,
    name: str,
    start_line: int = 1,
    end_line: int = 10,
) -> str:
    """Add a Function node and return its ID."""
    node_id = generate_id(NodeLabel.FUNCTION, file_path, name)
    graph.add_node(
        GraphNode(
            id=node_id,
            label=NodeLabel.FUNCTION,
            name=name,
            file_path=file_path,
            start_line=start_line,
            end_line=end_line,
        )
    )
    return node_id

def _add_call(graph: KnowledgeGraph, source_id: str, target_id: str) -> None:
    """Add a CALLS relationship between two nodes."""
    rel_id = f"calls:{source_id}->{target_id}"
    graph.add_relationship(
        GraphRelationship(
            id=rel_id,
            type=RelType.CALLS,
            source=source_id,
            target=target_id,
            properties={"confidence": 1.0},
        )
    )

@pytest.fixture()
def two_cluster_graph() -> KnowledgeGraph:
    """Build a graph with two clear clusters connected by a single cross-edge.

    Cluster 1 (auth): validate, hash_password, check_token
        - validate -> hash_password
        - validate -> check_token
        - hash_password -> check_token

    Cluster 2 (data): query_db, format_result, cache_result
        - query_db -> format_result
        - query_db -> cache_result
        - format_result -> cache_result

    Cross-cluster: validate -> query_db
    """
    g = KnowledgeGraph()

    # Cluster 1: auth
    validate = _add_function(g, "src/auth/validate.py", "validate")
    hash_pw = _add_function(g, "src/auth/hash.py", "hash_password")
    check_tok = _add_function(g, "src/auth/token.py", "check_token")

    _add_call(g, validate, hash_pw)
    _add_call(g, validate, check_tok)
    _add_call(g, hash_pw, check_tok)

    # Cluster 2: data
    query_db = _add_function(g, "src/data/query.py", "query_db")
    format_res = _add_function(g, "src/data/format.py", "format_result")
    cache_res = _add_function(g, "src/data/cache.py", "cache_result")

    _add_call(g, query_db, format_res)
    _add_call(g, query_db, cache_res)
    _add_call(g, format_res, cache_res)

    # Cross-cluster edge
    _add_call(g, validate, query_db)

    return g

class TestExportToIgraph:
    def test_export_to_igraph(self, two_cluster_graph: KnowledgeGraph) -> None:
        ig_graph, index_map = export_to_igraph(two_cluster_graph)

        # 6 function nodes total.
        assert ig_graph.vcount() == 6
        # 7 CALLS edges (3 + 3 intra-cluster + 1 cross-cluster).
        assert ig_graph.ecount() == 7
        # Index map has one entry per vertex.
        assert len(index_map) == 6

    def test_export_to_igraph_empty(self) -> None:
        g = KnowledgeGraph()
        ig_graph, index_map = export_to_igraph(g)

        assert ig_graph.vcount() == 0
        assert ig_graph.ecount() == 0
        assert len(index_map) == 0

class TestProcessCommunities:
    def test_process_communities_creates_nodes(
        self, two_cluster_graph: KnowledgeGraph
    ) -> None:
        process_communities(two_cluster_graph)

        community_nodes = two_cluster_graph.get_nodes_by_label(
            NodeLabel.COMMUNITY
        )
        assert len(community_nodes) >= 2
        # Each community node must have the correct label.
        for node in community_nodes:
            assert node.label == NodeLabel.COMMUNITY
            assert node.name  # Non-empty label.
            assert "symbol_count" in node.properties
            assert "cohesion" in node.properties

    def test_process_communities_creates_member_of(
        self, two_cluster_graph: KnowledgeGraph
    ) -> None:
        process_communities(two_cluster_graph)

        member_rels = two_cluster_graph.get_relationships_by_type(
            RelType.MEMBER_OF
        )
        assert len(member_rels) >= 2  # At least some members assigned.

        # Every MEMBER_OF target must be a COMMUNITY node.
        for rel in member_rels:
            target_node = two_cluster_graph.get_node(rel.target)
            assert target_node is not None
            assert target_node.label == NodeLabel.COMMUNITY

        # Every MEMBER_OF source must be a callable node.
        callable_labels = {NodeLabel.FUNCTION, NodeLabel.METHOD, NodeLabel.CLASS}
        for rel in member_rels:
            source_node = two_cluster_graph.get_node(rel.source)
            assert source_node is not None
            assert source_node.label in callable_labels

    def test_process_communities_returns_count(
        self, two_cluster_graph: KnowledgeGraph
    ) -> None:
        count = process_communities(two_cluster_graph)

        community_nodes = two_cluster_graph.get_nodes_by_label(
            NodeLabel.COMMUNITY
        )
        assert count == len(community_nodes)
        assert count >= 1

    def test_same_label_partitions_collapse_to_one_cluster(self) -> None:
        # HOR-377: two disconnected blobs that resolve to the SAME subsystem name must collapse
        # into ONE community node (not be counted twice). Two separate cliques, both under
        # src/auth/, are distinct Leiden partitions but one "Auth" subsystem.
        g = KnowledgeGraph()
        clique_a = [
            _add_function(g, "src/auth/a1.py", "a1"),
            _add_function(g, "src/auth/a2.py", "a2"),
            _add_function(g, "src/auth/a3.py", "a3"),
        ]
        _add_call(g, clique_a[0], clique_a[1])
        _add_call(g, clique_a[1], clique_a[2])
        _add_call(g, clique_a[2], clique_a[0])

        clique_b = [
            _add_function(g, "src/auth/b1.py", "b1"),
            _add_function(g, "src/auth/b2.py", "b2"),
            _add_function(g, "src/auth/b3.py", "b3"),
        ]
        _add_call(g, clique_b[0], clique_b[1])
        _add_call(g, clique_b[1], clique_b[2])
        _add_call(g, clique_b[2], clique_b[0])

        process_communities(g)

        community_nodes = g.get_nodes_by_label(NodeLabel.COMMUNITY)
        auth_nodes = [n for n in community_nodes if n.name == "Auth"]
        # Exactly ONE "Auth" community, holding members from both cliques.
        assert len(auth_nodes) == 1
        assert auth_nodes[0].properties["symbol_count"] == 6

    def test_process_communities_small_graph(self) -> None:
        g = KnowledgeGraph()
        _add_function(g, "src/a.py", "foo")
        _add_function(g, "src/b.py", "bar")

        result = process_communities(g)

        assert result == 0
        assert len(g.get_nodes_by_label(NodeLabel.COMMUNITY)) == 0

class TestGenerateLabel:
    def test_generate_label_same_directory(self) -> None:
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "src/auth/validate.py", "validate"),
            _add_function(g, "src/auth/hash.py", "hash_password"),
            _add_function(g, "src/auth/token.py", "check_token"),
        ]

        label = generate_label(g, ids)
        assert label == "Auth"

    def test_generate_label_mixed_directories(self) -> None:
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "src/auth/validate.py", "validate"),
            _add_function(g, "src/auth/hash.py", "hash_password"),
            _add_function(g, "src/data/query.py", "query_db"),
        ]

        label = generate_label(g, ids)
        # Most common is "auth" (2 occurrences), second is "data". Both segments are title-cased
        # now (HOR-377) so neither acronym is mangled.
        assert label == "Auth+Data"

    def test_generate_label_no_file_paths(self) -> None:
        g = KnowledgeGraph()
        node_id = "function:::orphan"
        g.add_node(
            GraphNode(
                id=node_id,
                label=NodeLabel.FUNCTION,
                name="orphan",
                file_path="",
            )
        )

        label = generate_label(g, [node_id])
        assert label == "Cluster"

    def test_prefers_non_test_dirs_for_mixed_community(self) -> None:
        # HOR-377: a community of mostly test files + some core must be named after the CORE,
        # not its tests (scrapy's core was mislabelled "Tests+scrapy").
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "tests/test_pq.py", "test_a"),
            _add_function(g, "tests/test_pq2.py", "test_b"),
            _add_function(g, "scrapy/core/engine.py", "open_spider"),
        ]
        assert generate_label(g, ids) == "Core"

    def test_dedupes_case_different_same_name_dirs(self) -> None:
        # HOR-377: "SQS" + "sqs" must not become "Sqs+sqs"; acronym casing is preserved.
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "kombu/SQS/a.py", "f1"),
            _add_function(g, "kombu/SQS/b.py", "f2"),
            _add_function(g, "lib/sqs/c.py", "f3"),
        ]
        assert generate_label(g, ids) == "SQS"

    def test_strips_leading_underscore(self) -> None:
        # HOR-377: "_ext" -> "Ext".
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "scrapy/_ext/a.py", "f1"),
            _add_function(g, "scrapy/_ext/b.py", "f2"),
        ]
        assert generate_label(g, ids) == "Ext"

    def test_all_test_community_falls_back_to_test_name(self) -> None:
        # HOR-377: when EVERY member is a test, naming after tests is correct (no core to prefer).
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "tests/test_a.py", "test_a"),
            _add_function(g, "tests/test_b.py", "test_b"),
        ]
        assert generate_label(g, ids) == "Tests"

    def test_swapped_pair_yields_one_label(self) -> None:
        # HOR-377: a composite label must be ORDER-INDEPENDENT so swapped duplicates collapse
        # to a single name. tortoise-orm produced both "Tortoise+Fields" and "Fields+Tortoise".
        g = KnowledgeGraph()
        forward = [
            _add_function(g, "tortoise/a.py", "f1"),
            _add_function(g, "tortoise/b.py", "f2"),
            _add_function(g, "fields/c.py", "f3"),
        ]
        backward = [
            _add_function(g, "fields/d.py", "f4"),
            _add_function(g, "fields/e.py", "f5"),
            _add_function(g, "tortoise/f.py", "f6"),
        ]
        label_forward = generate_label(g, forward)
        label_backward = generate_label(g, backward)
        assert label_forward == label_backward == "Fields+Tortoise"

    def test_test_tier_tokens_are_not_subsystem_names(self) -> None:
        # HOR-377: test-tier dirs (unit/acceptance/integration/e2e) describe the test policy,
        # not a subsystem, so a mixed community is named after its core ("models"), never a tier.
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "tests/unit/test_a.py", "test_a"),
            _add_function(g, "tests/acceptance/test_b.py", "test_b"),
            _add_function(g, "tests/integration/test_c.py", "test_c"),
            _add_function(g, "tests/e2e/test_d.py", "test_d"),
            _add_function(g, "app/models/user.py", "save"),
            _add_function(g, "app/models/order.py", "total"),
        ]
        label = generate_label(g, ids)
        assert label == "Models"
        lowered = label.lower()
        for tier in ("unit", "acceptance", "integration", "e2e"):
            assert tier not in lowered

    def test_pure_test_tier_community_falls_back_honestly(self) -> None:
        # HOR-377: when EVERY member is demoted (an all-test community), we fall back to the
        # dominant token rather than inventing a name — here the parent dir is "unit".
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "tests/unit/test_a.py", "test_a"),
            _add_function(g, "tests/unit/test_b.py", "test_b"),
        ]
        assert generate_label(g, ids) == "Unit"

    def test_drops_config_file_tokens(self) -> None:
        # HOR-377: config-file names (pyproject-plugin, mypy-default) are not subsystems.
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "build/pyproject-plugin/a.py", "f1"),
            _add_function(g, "build/mypy-default/b.py", "f2"),
            _add_function(g, "core/runtime/c.py", "f3"),
            _add_function(g, "core/runtime/d.py", "f4"),
        ]
        assert generate_label(g, ids) == "Runtime"

    def test_dedupes_degenerate_case_pair(self) -> None:
        # HOR-377: "Sqs"+"sqs" must collapse to one entry, never a degenerate "Sqs+sqs".
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "a/Sqs/x.py", "f1"),
            _add_function(g, "b/sqs/y.py", "f2"),
        ]
        label = generate_label(g, ids)
        assert "+" not in label
        assert label == "Sqs"

    def test_header_matches_listed_subsystems(self) -> None:
        # HOR-377: the header (label) must be EXACTLY the "+"-join of the listed subsystems,
        # both filtered by the same test policy — no drift between header and list.
        g = KnowledgeGraph()
        ids = [
            _add_function(g, "tests/unit/test_a.py", "test_a"),
            _add_function(g, "pkg/auth/login.py", "login"),
            _add_function(g, "pkg/auth/logout.py", "logout"),
            _add_function(g, "pkg/billing/charge.py", "charge"),
        ]
        listed = dominant_subsystems(g, ids)
        header = generate_label(g, ids)
        assert header == "+".join(listed)
        # The listed subsystems reflect the same policy: no test tier leaks in.
        assert all("unit" != s.lower() for s in listed)
        assert listed == ["Auth", "Billing"]
