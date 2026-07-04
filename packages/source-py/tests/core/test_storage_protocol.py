"""Backend-agnostic StorageBackend protocol parity suite (HOR-392).

Every test here runs once per concrete backend via the parametrized ``backend``
fixture in ``tests/conftest.py`` (kùzu and SQLite). It exercises only the
:class:`StorageBackend` protocol surface — no raw Cypher/SQL, no private
attributes — so passing against both implementations proves they are
interchangeable behind the seam.
"""

from __future__ import annotations

import hashlib

import pytest

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import (
    GraphNode,
    GraphRelationship,
    NodeLabel,
    RelType,
    generate_id,
)
from horus_source.core.storage.base import NodeEmbedding, StorageBackend


def _make_node(
    label: NodeLabel = NodeLabel.FUNCTION,
    file_path: str = "src/app.py",
    name: str = "my_func",
    content: str = "",
    signature: str = "",
    properties: dict | None = None,
) -> GraphNode:
    return GraphNode(
        id=generate_id(label, file_path, name),
        label=label,
        name=name,
        file_path=file_path,
        content=content,
        signature=signature,
        properties=properties or {},
    )


def _make_rel(
    source: str, target: str, rel_type: RelType = RelType.CALLS
) -> GraphRelationship:
    return GraphRelationship(
        id=f"{rel_type.value}:{source}->{target}",
        type=rel_type,
        source=source,
        target=target,
    )


def _small_graph() -> KnowledgeGraph:
    graph = KnowledgeGraph()
    caller = _make_node(name="caller", file_path="src/a.py")
    callee = _make_node(name="callee", file_path="src/a.py")
    graph.add_node(caller)
    graph.add_node(callee)
    graph.add_relationship(_make_rel(caller.id, callee.id))
    return graph


class TestProtocolConformance:
    def test_is_storage_backend(self, backend: StorageBackend) -> None:
        assert isinstance(backend, StorageBackend)


class TestCrudAndGetNode:
    def test_add_and_get_node(self, backend: StorageBackend) -> None:
        node = _make_node(name="target_func", file_path="src/x.py")
        backend.add_nodes([node])
        result = backend.get_node(node.id)
        assert result is not None
        assert result.id == node.id
        assert result.name == "target_func"
        assert result.file_path == "src/x.py"
        assert result.label == NodeLabel.FUNCTION

    def test_get_missing_returns_none(self, backend: StorageBackend) -> None:
        assert backend.get_node("function:nonexistent.py:ghost") is None

    def test_get_unknown_label_returns_none(self, backend: StorageBackend) -> None:
        assert backend.get_node("unknown_label:foo:bar") is None

    def test_boolean_fields_round_trip(self, backend: StorageBackend) -> None:
        node = GraphNode(
            id=generate_id(NodeLabel.FUNCTION, "src/b.py", "entry"),
            label=NodeLabel.FUNCTION,
            name="entry",
            file_path="src/b.py",
            is_entry_point=True,
            is_exported=True,
        )
        backend.add_nodes([node])
        result = backend.get_node(node.id)
        assert result is not None
        assert result.is_entry_point is True
        assert result.is_exported is True
        assert result.is_dead is False

    def test_extra_properties_round_trip(self, backend: StorageBackend) -> None:
        node = _make_node(
            label=NodeLabel.METHOD,
            name="handler",
            file_path="src/h.ts",
            properties={"cohesion": 0.75, "decorator_args": ["MANAGE_SALES"]},
        )
        backend.add_nodes([node])
        result = backend.get_node(node.id)
        assert result is not None
        assert result.properties.get("cohesion") == pytest.approx(0.75)
        assert result.properties.get("decorator_args") == ["MANAGE_SALES"]

    def test_multiple_labels(self, backend: StorageBackend) -> None:
        fn = _make_node(label=NodeLabel.FUNCTION, name="my_fn", file_path="src/c.py")
        cls = _make_node(label=NodeLabel.CLASS, name="MyClass", file_path="src/c.py")
        backend.add_nodes([fn, cls])
        assert backend.get_node(fn.id).label == NodeLabel.FUNCTION
        assert backend.get_node(cls.id).label == NodeLabel.CLASS


class TestBulkLoad:
    def test_inserts_nodes_and_relationships(self, backend: StorageBackend) -> None:
        backend.bulk_load(_small_graph())
        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        callee_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "callee")
        assert backend.get_node(caller_id).name == "caller"
        assert backend.get_node(callee_id).name == "callee"

    def test_replaces_existing(self, backend: StorageBackend) -> None:
        backend.bulk_load(_small_graph())
        backend.bulk_load(_small_graph())
        graph = backend.load_graph()
        assert graph.node_count == 2
        assert graph.relationship_count == 1


class TestCallersAndCallees:
    def test_get_callers(self, backend: StorageBackend) -> None:
        backend.bulk_load(_small_graph())
        callee_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "callee")
        callers = backend.get_callers(callee_id)
        assert [c.name for c in callers] == ["caller"]

    def test_get_callees(self, backend: StorageBackend) -> None:
        backend.bulk_load(_small_graph())
        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        callees = backend.get_callees(caller_id)
        assert [c.name for c in callees] == ["callee"]

    def test_callers_empty(self, backend: StorageBackend) -> None:
        backend.bulk_load(_small_graph())
        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        assert backend.get_callers(caller_id) == []

    def test_callees_empty(self, backend: StorageBackend) -> None:
        backend.bulk_load(_small_graph())
        callee_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "callee")
        assert backend.get_callees(callee_id) == []

    def test_callers_with_confidence(self, backend: StorageBackend) -> None:
        caller = _make_node(name="caller", file_path="src/a.py")
        callee = _make_node(name="callee", file_path="src/a.py")
        backend.add_nodes([caller, callee])
        rel = GraphRelationship(
            id="calls:1",
            type=RelType.CALLS,
            source=caller.id,
            target=callee.id,
            properties={"confidence": 0.42},
        )
        backend.add_relationships([rel])
        pairs = backend.get_callers_with_confidence(callee.id)
        assert len(pairs) == 1
        node, conf = pairs[0]
        assert node.name == "caller"
        assert conf == pytest.approx(0.42)

    def test_callees_with_confidence(self, backend: StorageBackend) -> None:
        caller = _make_node(name="caller", file_path="src/a.py")
        callee = _make_node(name="callee", file_path="src/a.py")
        backend.add_nodes([caller, callee])
        rel = GraphRelationship(
            id="calls:1",
            type=RelType.CALLS,
            source=caller.id,
            target=callee.id,
            properties={"confidence": 0.9},
        )
        backend.add_relationships([rel])
        pairs = backend.get_callees_with_confidence(caller.id)
        assert [(n.name, round(c, 2)) for n, c in pairs] == [("callee", 0.9)]

    def test_type_refs(self, backend: StorageBackend) -> None:
        user = _make_node(name="useThing", file_path="src/a.py")
        thing = _make_node(label=NodeLabel.CLASS, name="Thing", file_path="src/b.py")
        backend.add_nodes([user, thing])
        backend.add_relationships([_make_rel(user.id, thing.id, RelType.USES_TYPE)])
        refs = backend.get_type_refs(user.id)
        assert [r.name for r in refs] == ["Thing"]


class TestTraverse:
    def _chain(self, backend: StorageBackend) -> tuple[str, str, str]:
        a = _make_node(name="a", file_path="src/a.py")
        b = _make_node(name="b", file_path="src/a.py")
        c = _make_node(name="c", file_path="src/a.py")
        backend.add_nodes([a, b, c])
        backend.add_relationships(
            [_make_rel(a.id, b.id), _make_rel(b.id, c.id)]
        )
        return a.id, b.id, c.id

    def test_one_hop(self, backend: StorageBackend) -> None:
        backend.bulk_load(_small_graph())
        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        nodes = backend.traverse(caller_id, depth=1, direction="callees")
        assert [n.name for n in nodes] == ["callee"]

    def test_zero_depth(self, backend: StorageBackend) -> None:
        backend.bulk_load(_small_graph())
        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        assert backend.traverse(caller_id, depth=0, direction="callees") == []

    def test_traverse_callers(self, backend: StorageBackend) -> None:
        backend.bulk_load(_small_graph())
        callee_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "callee")
        nodes = backend.traverse(callee_id, depth=1, direction="callers")
        assert [n.name for n in nodes] == ["caller"]

    def test_multi_hop_with_depth(self, backend: StorageBackend) -> None:
        a_id, b_id, c_id = self._chain(backend)
        pairs = backend.traverse_with_depth(a_id, depth=3, direction="callees")
        by_name = {n.name: d for n, d in pairs}
        assert by_name == {"b": 1, "c": 2}

    def test_depth_limits_results(self, backend: StorageBackend) -> None:
        a_id, b_id, c_id = self._chain(backend)
        pairs = backend.traverse_with_depth(a_id, depth=1, direction="callees")
        assert [n.name for n, _ in pairs] == ["b"]

    def test_cycle_terminates(self, backend: StorageBackend) -> None:
        a = _make_node(name="a", file_path="src/a.py")
        b = _make_node(name="b", file_path="src/a.py")
        backend.add_nodes([a, b])
        backend.add_relationships([_make_rel(a.id, b.id), _make_rel(b.id, a.id)])
        pairs = backend.traverse_with_depth(a.id, depth=5, direction="callees")
        assert {n.name for n, _ in pairs} == {"b"}


class TestTraverseProductOnly:
    """product_only traversal: test nodes are neither reported nor tunneled through."""

    def _mixed_callers(self, backend: StorageBackend) -> tuple[str, str, str, str]:
        # target <- prod_caller ; target <- test_caller <- deep_prod
        target = _make_node(name="target", file_path="src/core.py")
        prod_caller = _make_node(name="prod_caller", file_path="src/app.py")
        test_caller = _make_node(name="test_caller", file_path="tests/test_core.py")
        deep_prod = _make_node(name="deep_prod", file_path="src/deep.py")
        backend.add_nodes([target, prod_caller, test_caller, deep_prod])
        backend.add_relationships([
            _make_rel(prod_caller.id, target.id),
            _make_rel(test_caller.id, target.id),
            _make_rel(deep_prod.id, test_caller.id),
        ])
        return target.id, prod_caller.id, test_caller.id, deep_prod.id

    def test_product_only_drops_test_callers_and_cuts_through_them(
        self, backend: StorageBackend
    ) -> None:
        target_id, *_ = self._mixed_callers(backend)
        pairs = backend.traverse_with_depth(
            target_id, depth=3, direction="callers", product_only=True
        )
        # test_caller is gone AND deep_prod (reachable only THROUGH it) is cut.
        assert {n.name for n, _ in pairs} == {"prod_caller"}

    def test_default_traversal_still_returns_everything(
        self, backend: StorageBackend
    ) -> None:
        target_id, *_ = self._mixed_callers(backend)
        pairs = backend.traverse_with_depth(target_id, depth=3, direction="callers")
        assert {n.name for n, _ in pairs} == {"prod_caller", "test_caller", "deep_prod"}


class TestTraverseInheritance:
    """Blast-radius traversal follows incoming EXTENDS/IMPLEMENTS when requested (B3.4)."""

    _RELS = (RelType.CALLS.value, RelType.EXTENDS.value, RelType.IMPLEMENTS.value)

    def _hierarchy(self, backend: StorageBackend) -> dict[str, str]:
        # A (base class) <-EXTENDS- B (subclass) <-CALLS- caller
        # IFace (interface) <-IMPLEMENTS- C
        base = _make_node(label=NodeLabel.CLASS, name="A", file_path="src/base.py")
        sub = _make_node(label=NodeLabel.CLASS, name="B", file_path="src/sub.py")
        caller = _make_node(name="use_b", file_path="src/app.py")
        iface = _make_node(label=NodeLabel.INTERFACE, name="IFace", file_path="src/i.py")
        impl = _make_node(label=NodeLabel.CLASS, name="C", file_path="src/impl.py")
        backend.add_nodes([base, sub, caller, iface, impl])
        backend.add_relationships([
            _make_rel(sub.id, base.id, RelType.EXTENDS),
            _make_rel(caller.id, sub.id, RelType.CALLS),
            _make_rel(impl.id, iface.id, RelType.IMPLEMENTS),
        ])
        return {"A": base.id, "B": sub.id, "caller": caller.id,
                "IFace": iface.id, "C": impl.id}

    def test_subclass_in_blast_radius_transitively(self, backend: StorageBackend) -> None:
        ids = self._hierarchy(backend)
        pairs = backend.traverse_with_depth(
            ids["A"], depth=3, direction="callers", rel_types=self._RELS
        )
        by_name = {n.name: d for n, d in pairs}
        # incoming EXTENDS reaches B, then incoming CALLS reaches its caller.
        assert by_name == {"B": 1, "use_b": 2}

    def test_implements_reaches_implementor(self, backend: StorageBackend) -> None:
        ids = self._hierarchy(backend)
        pairs = backend.traverse_with_depth(
            ids["IFace"], depth=3, direction="callers", rel_types=self._RELS
        )
        assert {n.name for n, _ in pairs} == {"C"}

    def test_default_rel_types_excludes_subtypes(self, backend: StorageBackend) -> None:
        # Back-compat: without rel_types the walk is CALLS-only, so a base type with
        # no direct callers has an empty radius (no EXTENDS/IMPLEMENTS traversal).
        ids = self._hierarchy(backend)
        pairs = backend.traverse_with_depth(ids["A"], depth=3, direction="callers")
        assert pairs == []

    def test_product_only_agrees_with_cte(self, backend: StorageBackend) -> None:
        ids = self._hierarchy(backend)
        cte = backend.traverse_with_depth(
            ids["A"], depth=3, direction="callers", rel_types=self._RELS
        )
        product = backend.traverse_with_depth(
            ids["A"], depth=3, direction="callers",
            product_only=True, rel_types=self._RELS,
        )
        assert {n.name for n, _ in cte} == {n.name for n, _ in product}


class TestGetEmbeddedNodeIds:
    """The resumable-embedding diff key: which node_ids already have a vector (B1.2)."""

    def test_matches_stored_subset_and_count(self, backend: StorageBackend) -> None:
        nodes = [_make_node(name=f"e{i}", file_path=f"src/e{i}.py") for i in range(4)]
        backend.add_nodes(nodes)
        embedded = nodes[:2]
        backend.upsert_embeddings([
            NodeEmbedding(node_id=n.id, embedding=[1.0] + [0.0] * 383) for n in embedded
        ])
        ids = backend.get_embedded_node_ids()
        assert ids == {n.id for n in embedded}
        assert len(ids) == backend.count_embeddings()

    def test_empty_when_nothing_embedded(self, backend: StorageBackend) -> None:
        node = _make_node(name="lonely", file_path="src/l.py")
        backend.add_nodes([node])
        assert backend.get_embedded_node_ids() == set()


class TestRemoveNodesByFile:
    def test_removes_matching(self, backend: StorageBackend) -> None:
        n1 = _make_node(name="f1", file_path="src/a.py")
        n2 = _make_node(name="f2", file_path="src/a.py")
        n3 = _make_node(name="f3", file_path="src/b.py")
        backend.add_nodes([n1, n2, n3])
        removed = backend.remove_nodes_by_file("src/a.py")
        assert removed == 2
        assert backend.get_node(n1.id) is None
        assert backend.get_node(n2.id) is None
        assert backend.get_node(n3.id) is not None

    def test_zero_for_no_match(self, backend: StorageBackend) -> None:
        assert backend.remove_nodes_by_file("nonexistent.py") == 0


class TestInboundCrossFileEdges:
    def test_returns_cross_file_only(self, backend: StorageBackend) -> None:
        local = _make_node(name="local", file_path="src/target.py")
        target = _make_node(name="target", file_path="src/target.py")
        external = _make_node(name="external", file_path="src/other.py")
        backend.add_nodes([local, target, external])
        backend.add_relationships(
            [_make_rel(external.id, target.id), _make_rel(local.id, target.id)]
        )
        edges = backend.get_inbound_cross_file_edges("src/target.py")
        assert [e.source for e in edges] == [external.id]

    def test_excludes_source_files(self, backend: StorageBackend) -> None:
        target = _make_node(name="target", file_path="src/target.py")
        external = _make_node(name="external", file_path="src/other.py")
        backend.add_nodes([target, external])
        backend.add_relationships([_make_rel(external.id, target.id)])
        edges = backend.get_inbound_cross_file_edges(
            "src/target.py", exclude_source_files={"src/other.py"}
        )
        assert edges == []


class TestProcessMemberships:
    def test_returns_membership(self, backend: StorageBackend) -> None:
        step = _make_node(name="step1", file_path="src/a.py")
        proc = _make_node(label=NodeLabel.PROCESS, name="checkout", file_path="")
        backend.add_nodes([step, proc])
        backend.add_relationships([_make_rel(step.id, proc.id, RelType.STEP_IN_PROCESS)])
        assert backend.get_process_memberships([step.id]) == {step.id: "checkout"}

    def test_empty_input(self, backend: StorageBackend) -> None:
        assert backend.get_process_memberships([]) == {}


class TestIndexes:
    def test_indexed_files(self, backend: StorageBackend) -> None:
        f = _make_node(
            label=NodeLabel.FILE,
            file_path="src/main.py",
            name="main.py",
            content="print('hello')",
        )
        backend.add_nodes([f])
        result = backend.get_indexed_files()
        assert result["src/main.py"] == hashlib.sha256(b"print('hello')").hexdigest()

    def test_file_index(self, backend: StorageBackend) -> None:
        f = _make_node(
            label=NodeLabel.FILE, file_path="src/main.py", name="main.py"
        )
        backend.add_nodes([f])
        assert backend.get_file_index() == {"src/main.py": f.id}

    def test_symbol_name_index(self, backend: StorageBackend) -> None:
        fn = _make_node(name="doThing", file_path="src/a.py")
        cls = _make_node(label=NodeLabel.CLASS, name="Thing", file_path="src/b.py")
        backend.add_nodes([fn, cls])
        index = backend.get_symbol_name_index()
        assert fn.id in index["doThing"]
        assert cls.id in index["Thing"]


class TestLoadGraph:
    def test_round_trips(self, backend: StorageBackend) -> None:
        n1 = _make_node(name="alpha", file_path="src/a.py")
        n2 = _make_node(name="beta", file_path="src/a.py")
        n3 = _make_node(label=NodeLabel.CLASS, name="Gamma", file_path="src/a.py")
        backend.add_nodes([n1, n2, n3])
        backend.add_relationships(
            [_make_rel(n1.id, n2.id), _make_rel(n1.id, n3.id)]
        )
        graph = backend.load_graph()
        assert graph.node_count == 3
        assert graph.relationship_count == 2
        assert graph.get_node(n1.id) is not None

    def test_preserves_properties(self, backend: StorageBackend) -> None:
        node = GraphNode(
            id=generate_id(NodeLabel.FUNCTION, "src/d.py", "special"),
            label=NodeLabel.FUNCTION,
            name="special",
            file_path="src/d.py",
            signature="def special() -> bool",
            is_dead=True,
            is_entry_point=True,
        )
        backend.add_nodes([node])
        loaded = backend.load_graph().get_node(node.id)
        assert loaded is not None
        assert loaded.signature == "def special() -> bool"
        assert loaded.is_dead is True
        assert loaded.is_entry_point is True
        assert loaded.is_exported is False

    def test_empty(self, backend: StorageBackend) -> None:
        graph = backend.load_graph()
        assert graph.node_count == 0
        assert graph.relationship_count == 0


class TestDeleteSyntheticNodes:
    def test_removes_community_and_process(self, backend: StorageBackend) -> None:
        fn = _make_node(name="real_func", file_path="src/a.py")
        comm = _make_node(label=NodeLabel.COMMUNITY, name="comm_1", file_path="")
        proc = _make_node(label=NodeLabel.PROCESS, name="proc_1", file_path="")
        backend.add_nodes([fn, comm, proc])
        backend.add_relationships(
            [
                _make_rel(fn.id, comm.id, RelType.MEMBER_OF),
                _make_rel(fn.id, proc.id, RelType.STEP_IN_PROCESS),
            ]
        )
        backend.delete_synthetic_nodes()
        graph = backend.load_graph()
        assert graph.node_count == 1
        assert graph.get_node(fn.id) is not None
        assert graph.get_node(comm.id) is None
        assert graph.get_node(proc.id) is None
        assert graph.relationship_count == 0


class TestUpdateDeadFlags:
    def test_sets_dead_and_alive(self, backend: StorageBackend) -> None:
        n1 = _make_node(name="func_a", file_path="src/a.py")
        n2 = _make_node(name="func_b", file_path="src/a.py")
        backend.add_nodes([n1, n2])
        backend.update_dead_flags(dead_ids={n1.id}, alive_ids={n2.id})
        assert backend.get_node(n1.id).is_dead is True
        assert backend.get_node(n2.id).is_dead is False


class TestRemoveRelationshipsByType:
    def test_removes_only_specified(self, backend: StorageBackend) -> None:
        n1 = _make_node(name="func_x", file_path="src/a.py")
        n2 = _make_node(name="func_y", file_path="src/a.py")
        backend.add_nodes([n1, n2])
        backend.add_relationships(
            [
                _make_rel(n1.id, n2.id, RelType.CALLS),
                _make_rel(n1.id, n2.id, RelType.COUPLED_WITH),
            ]
        )
        backend.remove_relationships_by_type(RelType.COUPLED_WITH)
        rel_types = {r.type for r in backend.load_graph().iter_relationships()}
        assert RelType.CALLS in rel_types
        assert RelType.COUPLED_WITH not in rel_types


class TestFtsSearch:
    def test_name_match(self, backend: StorageBackend) -> None:
        node = _make_node(name="process_data", content="does stuff")
        backend.add_nodes([node])
        backend.rebuild_fts_indexes()
        results = backend.fts_search("process_data", limit=10)
        assert results[0].node_id == node.id
        assert results[0].score > 0

    def test_content_match(self, backend: StorageBackend) -> None:
        node = _make_node(name="unrelated_name", content="this calls process_data inside")
        backend.add_nodes([node])
        backend.rebuild_fts_indexes()
        results = backend.fts_search("process_data", limit=10)
        assert results[0].node_id == node.id

    def test_no_match(self, backend: StorageBackend) -> None:
        backend.add_nodes([_make_node(name="hello", content="world")])
        backend.rebuild_fts_indexes()
        assert backend.fts_search("nonexistent_symbol", limit=10) == []

    def test_limit_respected(self, backend: StorageBackend) -> None:
        nodes = [
            _make_node(name=f"func_{i}", file_path=f"src/f{i}.py", content="common_term")
            for i in range(5)
        ]
        backend.add_nodes(nodes)
        backend.rebuild_fts_indexes()
        assert len(backend.fts_search("common_term", limit=3)) == 3

    def test_result_fields_populated(self, backend: StorageBackend) -> None:
        node = _make_node(
            label=NodeLabel.CLASS,
            name="MyClass",
            file_path="src/models.py",
            content="class body here",
        )
        backend.add_nodes([node])
        backend.rebuild_fts_indexes()
        r = backend.fts_search("MyClass", limit=10)[0]
        assert r.node_name == "MyClass"
        assert r.file_path == "src/models.py"
        assert r.label == "class"
        assert r.snippet != ""

    def test_signature_match(self, backend: StorageBackend) -> None:
        node = _make_node(
            name="unrelated", signature="def special_function(x: int) -> str"
        )
        backend.add_nodes([node])
        backend.rebuild_fts_indexes()
        results = backend.fts_search("special_function", limit=10)
        assert results[0].node_id == node.id


class TestEmbeddingsAndVectorSearch:
    def test_store_and_retrieve(self, backend: StorageBackend) -> None:
        node = _make_node(name="embed_func", file_path="src/embed.py", content="body")
        backend.add_nodes([node])
        vec = [1.0] + [0.0] * 383
        backend.store_embeddings([NodeEmbedding(node_id=node.id, embedding=vec)])
        results = backend.vector_search(vec, limit=5)
        top = results[0]
        assert top.node_id == node.id
        assert top.score == pytest.approx(1.0, abs=1e-5)
        assert top.node_name == "embed_func"

    def test_empty(self, backend: StorageBackend) -> None:
        assert backend.vector_search([1.0] + [0.0] * 383, limit=5) == []

    def test_ranking(self, backend: StorageBackend) -> None:
        n1 = _make_node(name="close_func", file_path="src/a.py")
        n2 = _make_node(name="far_func", file_path="src/b.py")
        backend.add_nodes([n1, n2])
        backend.store_embeddings(
            [
                NodeEmbedding(node_id=n1.id, embedding=[0.9, 0.1] + [0.0] * 382),
                NodeEmbedding(node_id=n2.id, embedding=[0.0, 0.0, 1.0] + [0.0] * 381),
            ]
        )
        results = backend.vector_search([1.0] + [0.0] * 383, limit=5)
        assert len(results) == 2
        assert results[0].node_id == n1.id
        assert results[0].score > results[1].score

    def test_limit(self, backend: StorageBackend) -> None:
        embeddings = []
        nodes = []
        for i in range(5):
            n = _make_node(name=f"vfunc_{i}", file_path=f"src/v{i}.py")
            nodes.append(n)
            vec = [0.0] * 384
            vec[i] = 1.0
            embeddings.append(NodeEmbedding(node_id=n.id, embedding=vec))
        backend.add_nodes(nodes)
        backend.store_embeddings(embeddings)
        results = backend.vector_search([1.0, 0.5, 0.3, 0.1, 0.0] + [0.0] * 379, limit=2)
        assert len(results) == 2

    def test_upsert_replaces(self, backend: StorageBackend) -> None:
        node = _make_node(name="upsert_func", file_path="src/u.py")
        backend.add_nodes([node])
        backend.store_embeddings(
            [NodeEmbedding(node_id=node.id, embedding=[1.0] + [0.0] * 383)]
        )
        backend.store_embeddings(
            [NodeEmbedding(node_id=node.id, embedding=[0.0, 1.0] + [0.0] * 382)]
        )
        results = backend.vector_search([0.0, 1.0] + [0.0] * 382, limit=5)
        assert len(results) == 1
        assert results[0].score == pytest.approx(1.0, abs=1e-5)

    def test_upsert_without_wiping(self, backend: StorageBackend) -> None:
        a = _make_node(name="alpha", file_path="src/a.py")
        b = _make_node(name="beta", file_path="src/a.py")
        backend.add_nodes([a, b])
        backend.store_embeddings(
            [NodeEmbedding(node_id=a.id, embedding=[1.0] + [0.0] * 383)]
        )
        backend.upsert_embeddings(
            [NodeEmbedding(node_id=b.id, embedding=[0.0, 1.0] + [0.0] * 382)]
        )
        a_hits = backend.vector_search([1.0] + [0.0] * 383, limit=5)
        assert any(r.node_id == a.id for r in a_hits)
        b_hits = backend.vector_search([0.0, 1.0] + [0.0] * 382, limit=5)
        assert any(r.node_id == b.id for r in b_hits)


class TestFuzzySearch:
    def test_exact_name(self, backend: StorageBackend) -> None:
        node = _make_node(name="validate_user", content="validates user")
        backend.add_nodes([node])
        results = backend.fuzzy_search("validate_user", limit=10)
        assert results[0].node_id == node.id
        assert results[0].score == 1.0

    def test_typo_within_distance(self, backend: StorageBackend) -> None:
        node = _make_node(name="validate_user", content="validates user")
        backend.add_nodes([node])
        results = backend.fuzzy_search("validte_user", limit=10, max_distance=2)
        assert results[0].node_id == node.id
        assert results[0].score < 1.0

    def test_typo_beyond_distance(self, backend: StorageBackend) -> None:
        backend.add_nodes([_make_node(name="validate_user")])
        assert backend.fuzzy_search("xyz_abc", limit=10, max_distance=2) == []

    def test_score_decreases_with_distance(self, backend: StorageBackend) -> None:
        backend.add_nodes([_make_node(name="process")])
        exact = backend.fuzzy_search("process", limit=10)
        one_off = backend.fuzzy_search("procss", limit=10)
        assert exact[0].score > one_off[0].score

    def test_limit(self, backend: StorageBackend) -> None:
        backend.add_nodes(
            [_make_node(name=f"func_{i}", file_path=f"src/f{i}.py") for i in range(5)]
        )
        assert len(backend.fuzzy_search("func_0", limit=2, max_distance=2)) <= 2


class TestExactNameSearch:
    def test_resolves_symbol(self, backend: StorageBackend) -> None:
        target = _make_node(
            name="manageSalesForMarket", file_path="src/sales.service.ts", content="impl"
        )
        neighbor = _make_node(
            name="manageSalesHelper", file_path="src/sales.service.ts", content="helper"
        )
        backend.add_nodes([target, neighbor])
        results = backend.exact_name_search("manageSalesForMarket", limit=10)
        assert [r.node_name for r in results] == ["manageSalesForMarket"]

    def test_case_insensitive(self, backend: StorageBackend) -> None:
        backend.add_nodes(
            [_make_node(name="SyncOrders", file_path="src/orders.ts", content="x")]
        )
        results = backend.exact_name_search("syncorders", limit=10)
        assert [r.node_name for r in results] == ["SyncOrders"]

    def test_executable_ranks_above_test(self, backend: StorageBackend) -> None:
        prod = _make_node(
            label=NodeLabel.METHOD, name="syncOrders", file_path="src/orders.ts", content="impl"
        )
        test_sym = _make_node(
            label=NodeLabel.METHOD,
            name="syncOrders",
            file_path="tests/orders.test.ts",
            content="spec",
        )
        backend.add_nodes([prod, test_sym])
        results = backend.exact_name_search("syncOrders", limit=10)
        assert results[0].file_path == "src/orders.ts"

    def test_no_match(self, backend: StorageBackend) -> None:
        backend.add_nodes([_make_node(name="somethingElse")])
        assert backend.exact_name_search("doesNotExist", limit=10) == []


def _analytics_graph() -> tuple[KnowledgeGraph, dict[str, str]]:
    """A richer graph exercising every analytics method, plus an id lookup."""
    graph = KnowledgeGraph()

    def node(label: NodeLabel, file_path: str, name: str, **kw) -> GraphNode:
        n = GraphNode(
            id=generate_id(label, file_path, name),
            label=label,
            name=name,
            file_path=file_path,
            **kw,
        )
        graph.add_node(n)
        return n

    file_a = node(NodeLabel.FILE, "src/a.py", "a.py", language="python")
    file_b = node(NodeLabel.FILE, "src/b.py", "b.py", language="python")
    caller = node(NodeLabel.FUNCTION, "src/a.py", "caller", start_line=10, end_line=20)
    callee = node(NodeLabel.FUNCTION, "src/a.py", "callee", start_line=30, end_line=40)
    m1 = node(NodeLabel.METHOD, "src/a.py", "m1", start_line=50, end_line=60, is_dead=True)
    base = node(NodeLabel.CLASS, "src/b.py", "Base", start_line=1, end_line=5)
    child = node(NodeLabel.CLASS, "src/b.py", "Child", start_line=6, end_line=20)
    comm1 = node(NodeLabel.COMMUNITY, "", "Comm1", properties={"cohesion": 0.9})
    comm2 = node(NodeLabel.COMMUNITY, "", "Comm2", properties={"cohesion": 0.5})
    proc1 = node(NodeLabel.PROCESS, "", "Checkout")

    def rel(src: str, tgt: str, rt: RelType, **props) -> None:
        graph.add_relationship(
            GraphRelationship(
                id=f"{rt.value}:{src}->{tgt}", type=rt, source=src, target=tgt,
                properties=props,
            )
        )

    rel(caller.id, callee.id, RelType.CALLS, confidence=0.8)
    rel(callee.id, m1.id, RelType.CALLS, confidence=0.6)
    rel(file_a.id, file_b.id, RelType.COUPLED_WITH, strength=0.8, co_changes=5)
    rel(file_a.id, file_b.id, RelType.IMPORTS)
    rel(caller.id, comm1.id, RelType.MEMBER_OF)
    rel(callee.id, comm1.id, RelType.MEMBER_OF)
    rel(m1.id, comm2.id, RelType.MEMBER_OF)
    rel(caller.id, proc1.id, RelType.STEP_IN_PROCESS, step_number=1)
    rel(callee.id, proc1.id, RelType.STEP_IN_PROCESS, step_number=2)
    rel(m1.id, proc1.id, RelType.STEP_IN_PROCESS, step_number=3)
    rel(child.id, base.id, RelType.EXTENDS)
    rel(caller.id, base.id, RelType.USES_TYPE)

    ids = {
        "file_a": file_a.id, "file_b": file_b.id, "caller": caller.id,
        "callee": callee.id, "m1": m1.id, "base": base.id, "child": child.id,
        "comm1": comm1.id, "comm2": comm2.id, "proc1": proc1.id,
    }
    return graph, ids


class TestAnalytics:
    def test_count_nodes_by_label(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.count_nodes_by_label() == {
            "function": 2, "class": 2, "file": 2, "method": 1,
            "community": 2, "process": 1,
        }

    def test_count_edges_by_type(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.count_edges_by_type() == {
            "calls": 2, "member_of": 3, "step_in_process": 3,
            "coupled_with": 1, "imports": 1, "extends": 1, "uses_type": 1,
        }

    def test_dead_code_symbols(self, backend: StorageBackend) -> None:
        graph, ids = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_dead_code_symbols() == [
            (ids["m1"], "m1", "src/a.py", 50, "method")
        ]

    def test_coupling_pairs_and_strengths(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_coupling_pairs() == [
            ("a.py", "src/a.py", "b.py", "src/b.py", 0.8, 5)
        ]
        assert backend.get_coupling_strengths() == [0.8]

    def test_communities_with_members(self, backend: StorageBackend) -> None:
        graph, ids = _analytics_graph()
        backend.bulk_load(graph)
        got = {
            name: (cohesion, sorted(members))
            for _cid, name, cohesion, members in backend.get_communities_with_members()
        }
        assert got == {
            "Comm1": (0.9, sorted([ids["caller"], ids["callee"]])),
            "Comm2": (0.5, [ids["m1"]]),
        }

    def test_counts(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.count_communities() == 2
        assert backend.avg_calls_confidence() == pytest.approx(0.7)
        assert backend.count_symbols_and_dead() == (5, 1)
        assert backend.count_callables_in_processes() == (3, 3)

    def test_avg_calls_confidence_none_when_empty(self, backend: StorageBackend) -> None:
        assert backend.avg_calls_confidence() is None

    def test_file_nodes_and_symbol_counts(self, backend: StorageBackend) -> None:
        graph, ids = _analytics_graph()
        backend.bulk_load(graph)
        assert sorted(backend.get_file_nodes()) == sorted([
            (ids["file_a"], "a.py", "src/a.py", "python"),
            (ids["file_b"], "b.py", "src/b.py", "python"),
        ])
        assert backend.get_symbol_counts_by_file() == {"src/a.py": 3, "src/b.py": 2}

    def test_processes_with_steps(self, backend: StorageBackend) -> None:
        graph, ids = _analytics_graph()
        backend.bulk_load(graph)
        procs = backend.get_processes_with_steps()
        assert len(procs) == 1
        pid, name, node_ids, steps = procs[0]
        assert (pid, name) == (ids["proc1"], "Checkout")
        assert sorted(zip(node_ids, steps)) == sorted([
            (ids["caller"], 1), (ids["callee"], 2), (ids["m1"], 3)
        ])

    def test_symbols_in_file(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        names = [n.name for n in backend.get_symbols_in_file("src/a.py")]
        assert names == ["caller", "callee", "m1"]

    def test_file_imports_and_importers(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_file_imports("src/a.py") == ["src/b.py"]
        assert backend.get_file_imports("src/b.py") == []
        assert backend.get_file_importers("src/b.py") == ["src/a.py"]
        assert backend.get_file_importers("src/a.py") == []

    def test_file_coupling_undirected(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_file_coupling("src/a.py") == [("src/b.py", 0.8, 5)]
        assert backend.get_file_coupling("src/b.py") == [("src/a.py", 0.8, 5)]

    def test_heritage(self, backend: StorageBackend) -> None:
        graph, ids = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_heritage(ids["child"]) == [("Base", "src/b.py", "extends")]
        assert backend.get_heritage(ids["base"]) == []

    def test_node_communities_and_processes(self, backend: StorageBackend) -> None:
        graph, ids = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_node_communities(ids["caller"]) == ["Comm1"]
        assert backend.get_node_communities(ids["m1"]) == ["Comm2"]
        assert backend.get_node_processes(ids["caller"]) == ["Checkout"]

    def test_community_members(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_community_members("Comm1") == [
            ("caller", "function", "src/a.py", 10, False, False),
            ("callee", "function", "src/a.py", 30, False, False),
        ]

    def test_communities_summary(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_communities_summary() == [
            ("Comm1", 0.9, ""),
            ("Comm2", 0.5, ""),
        ]

    def test_cross_community_processes(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_cross_community_processes() == [
            ("Checkout", ["Comm1", "Comm2"])
        ]

    def test_file_community_counts(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.get_file_community_counts("src/a.py") == [
            ("Comm1", 2), ("Comm2", 1)
        ]


class TestCliReadPath:
    """Parity for the typed CLI read-path methods (HOR-392 Option A).

    These exercise the three endpoints the CLI consumes instead of emitting Cypher;
    running once per backend proves kùzu and SQLite return identical results.
    """

    def _content_graph(self) -> KnowledgeGraph:
        graph = KnowledgeGraph()
        graph.add_node(
            _make_node(
                name="raise_sync_error",
                file_path="src/sync.py",
                content="raise Error('E_FULFILLMENT_SYNC_ERROR_04 happened')",
            )
        )
        graph.add_node(
            _make_node(
                name="handle_order",
                file_path="src/orders.py",
                content="# logs E_FULFILLMENT_SYNC_ERROR_04 then retries via PAYMENT_TIMEOUT",
            )
        )
        graph.add_node(
            _make_node(
                name="unrelated",
                file_path="src/misc.py",
                content="nothing interesting here",
            )
        )
        # Synthetic/structural nodes must be excluded even if content matched.
        graph.add_node(
            _make_node(
                label=NodeLabel.COMMUNITY,
                name="E_FULFILLMENT_SYNC_ERROR_04",
                file_path="",
                content="E_FULFILLMENT_SYNC_ERROR_04",
            )
        )
        return graph

    def test_content_contains_any_matches_any_token(
        self, backend: StorageBackend
    ) -> None:
        backend.bulk_load(self._content_graph())
        rows = backend.content_contains_any(
            ["E_FULFILLMENT_SYNC_ERROR_04", "PAYMENT_TIMEOUT"], limit=10
        )
        names = sorted(r["name"] for r in rows)
        assert names == ["handle_order", "raise_sync_error"]
        # Full (untruncated) content is returned, not a snippet.
        by_name = {r["name"]: r for r in rows}
        assert "E_FULFILLMENT_SYNC_ERROR_04 happened" in by_name["raise_sync_error"]["content"]
        assert by_name["raise_sync_error"]["file_path"] == "src/sync.py"
        assert by_name["raise_sync_error"]["id"].startswith("function:")

    def test_content_contains_any_case_insensitive(
        self, backend: StorageBackend
    ) -> None:
        backend.bulk_load(self._content_graph())
        rows = backend.content_contains_any(["payment_timeout"], limit=10)
        assert [r["name"] for r in rows] == ["handle_order"]

    def test_content_contains_any_excludes_synthetic(
        self, backend: StorageBackend
    ) -> None:
        backend.bulk_load(self._content_graph())
        rows = backend.content_contains_any(["E_FULFILLMENT_SYNC_ERROR_04"], limit=10)
        labels = {r["id"].split(":", 1)[0] for r in rows}
        assert "community" not in labels

    def test_content_contains_any_respects_limit_and_order(
        self, backend: StorageBackend
    ) -> None:
        backend.bulk_load(self._content_graph())
        rows = backend.content_contains_any(["E_FULFILLMENT_SYNC_ERROR_04"], limit=1)
        assert len(rows) == 1
        # Deterministic, id-ordered slice across backends.
        all_rows = backend.content_contains_any(["E_FULFILLMENT_SYNC_ERROR_04"], limit=10)
        assert rows[0]["id"] == sorted(r["id"] for r in all_rows)[0]

    def test_content_contains_any_empty_tokens(self, backend: StorageBackend) -> None:
        backend.bulk_load(self._content_graph())
        assert backend.content_contains_any([], limit=10) == []

    # ---------------------------------------------------------------- files_containing
    # Backs external-system detection in `horus architecture` — per-token distinct
    # FILE paths, so one common marker can't crowd rarer ones out of a shared limit.

    def _files_graph(self) -> KnowledgeGraph:
        graph = KnowledgeGraph()
        graph.add_node(
            _make_node(
                label=NodeLabel.FILE,
                name="queue.ts",
                file_path="src/queue.ts",
                content="import Redis from 'redis'\nimport { Queue } from 'bullmq'",
            )
        )
        graph.add_node(
            _make_node(
                label=NodeLabel.FILE,
                name="db.py",
                file_path="src/db.py",
                content="import asyncpg\nPOOL = asyncpg.create_pool()",
            )
        )
        # A FUNCTION node mentioning a marker must NOT count — file nodes only
        # (symbol content would double-count its containing file).
        graph.add_node(
            _make_node(
                name="uses_redis",
                file_path="src/misc.py",
                content="redis.get('k')",
            )
        )
        return graph

    def test_files_containing_per_token_file_paths(self, backend: StorageBackend) -> None:
        backend.bulk_load(self._files_graph())
        out = backend.files_containing(["redis", "asyncpg", "kafka"], per_token_limit=10)
        assert out["redis"] == ["src/queue.ts"]  # file node only, not uses_redis's file
        assert out["asyncpg"] == ["src/db.py"]
        assert out["kafka"] == []

    def test_files_containing_case_insensitive_and_limit(self, backend: StorageBackend) -> None:
        backend.bulk_load(self._files_graph())
        out = backend.files_containing(["REDIS"], per_token_limit=10)
        assert out["REDIS"] == ["src/queue.ts"]
        capped = backend.files_containing(["import"], per_token_limit=1)
        assert len(capped["import"]) == 1

    def test_files_containing_empty_tokens(self, backend: StorageBackend) -> None:
        backend.bulk_load(self._files_graph())
        assert backend.files_containing([], per_token_limit=10) == {}
        assert backend.files_containing([""], per_token_limit=10) == {}

    def _boundary_graph(self) -> KnowledgeGraph:
        """Files exercising word-boundary / comment-skip refinement (dogfood 0.21, A3)."""
        graph = KnowledgeGraph()
        # `stripe` buried mid-identifier — must NOT match.
        graph.add_node(
            _make_node(
                label=NodeLabel.FILE,
                name="util.ts",
                file_path="src/util.ts",
                content="export function stripEndSlash(s) { return s }",
            )
        )
        # `redis` as a standalone identifier — must match by NAME, not by an import path.
        graph.add_node(
            _make_node(
                label=NodeLabel.FILE,
                name="cache.ts",
                file_path="src/cache.ts",
                content="const redis = createClient()\nawait redis.get('k')",
            )
        )
        # `axios` mentioned only in a comment — must be skipped.
        graph.add_node(
            _make_node(
                label=NodeLabel.FILE,
                name="notes.ts",
                file_path="src/notes.ts",
                content="// Axios, et al. are also supported\nexport const x = 1",
            )
        )
        # `mongo` as a package-name substring (pymongo) — must still match.
        graph.add_node(
            _make_node(
                label=NodeLabel.FILE,
                name="store.py",
                file_path="src/store.py",
                content="from pymongo import MongoClient",
            )
        )
        return graph

    def test_files_containing_word_bounded_and_comment_skip(
        self, backend: StorageBackend
    ) -> None:
        backend.bulk_load(self._boundary_graph())
        out = backend.files_containing(
            ["stripe", "redis", "axios", "mongo"], per_token_limit=10
        )
        assert out["stripe"] == []  # stripEndSlash must not mint a `stripe` dependency
        assert out["redis"] == ["src/cache.ts"]  # standalone identifier matches
        assert out["axios"] == []  # comment-only mention skipped
        assert out["mongo"] == ["src/store.py"]  # pymongo substring preserved

    def test_flows_for_symbol(self, backend: StorageBackend) -> None:
        graph, ids = _analytics_graph()
        backend.bulk_load(graph)
        flows = backend.flows_for_symbol(ids["caller"])
        assert flows["processes"] == [{"id": ids["proc1"], "name": "Checkout"}]
        steps = flows["steps"]
        # Steps carry names and are ordered by step_number (what the old
        # get_processes_with_steps lacked).
        assert [(s["name"], s["step_number"]) for s in steps] == [
            ("caller", 1),
            ("callee", 2),
            ("m1", 3),
        ]
        first = steps[0]
        assert first["id"] == ids["caller"]
        assert first["file_path"] == "src/a.py"
        assert first["start_line"] == 10

    def test_flows_for_symbol_none(self, backend: StorageBackend) -> None:
        graph, ids = _analytics_graph()
        backend.bulk_load(graph)
        # base is not a step in any process.
        flows = backend.flows_for_symbol(ids["base"])
        assert flows == {"processes": [], "steps": []}

    def test_symbols_by_label(self, backend: StorageBackend) -> None:
        graph, ids = _analytics_graph()
        backend.bulk_load(graph)
        rows = backend.symbols_by_label(["function", "method"], limit=100)
        assert [(r["name"], r["label"]) for r in rows] == [
            ("caller", "function"),
            ("callee", "function"),
            ("m1", "method"),
        ]
        caller_row = rows[0]
        assert caller_row["id"] == ids["caller"]
        assert caller_row["file_path"] == "src/a.py"
        assert caller_row["start_line"] == 10
        assert caller_row["end_line"] == 20

    def test_symbols_by_label_full_field_set(self, backend: StorageBackend) -> None:
        node = GraphNode(
            id=generate_id(NodeLabel.METHOD, "src/h.ts", "handler"),
            label=NodeLabel.METHOD,
            name="handler",
            file_path="src/h.ts",
            start_line=3,
            end_line=9,
            class_name="OrderService",
            is_entry_point=True,
            is_exported=True,
            signature="handler(): void",
        )
        backend.add_nodes([node])
        rows = backend.symbols_by_label(["method"], limit=10)
        assert rows == [
            {
                "id": node.id,
                "label": "method",
                "name": "handler",
                "file_path": "src/h.ts",
                "start_line": 3,
                "end_line": 9,
                "class_name": "OrderService",
                "is_entry_point": True,
                "is_exported": True,
                "signature": "handler(): void",
            }
        ]

    def test_symbols_by_label_respects_limit(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        rows = backend.symbols_by_label(["function", "method", "class"], limit=2)
        assert len(rows) == 2

    def test_symbols_by_label_empty(self, backend: StorageBackend) -> None:
        graph, _ = _analytics_graph()
        backend.bulk_load(graph)
        assert backend.symbols_by_label([], limit=10) == []
