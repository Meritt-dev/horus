from __future__ import annotations

from pathlib import Path

import pytest

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import (
    GraphNode,
    GraphRelationship,
    NodeLabel,
    RelType,
    generate_id,
)
from horus_source.core.storage.base import NodeEmbedding
from horus_source.core.storage.kuzu_backend import KuzuBackend


@pytest.fixture()
def backend(tmp_path: Path) -> KuzuBackend:
    """Return a KuzuBackend initialised in a temporary directory."""
    db_path = tmp_path / "test_db"
    b = KuzuBackend()
    b.initialize(db_path)
    yield b
    b.close()


def _make_node(
    label: NodeLabel = NodeLabel.FUNCTION,
    file_path: str = "src/app.py",
    name: str = "my_func",
    content: str = "",
) -> GraphNode:
    """Helper to build a GraphNode with a deterministic id."""
    return GraphNode(
        id=generate_id(label, file_path, name),
        label=label,
        name=name,
        file_path=file_path,
        content=content,
    )


def _make_rel(
    source: str,
    target: str,
    rel_type: RelType = RelType.CALLS,
    rel_id: str | None = None,
) -> GraphRelationship:
    """Helper to build a GraphRelationship."""
    return GraphRelationship(
        id=rel_id or f"{rel_type.value}:{source}->{target}",
        type=rel_type,
        source=source,
        target=target,
    )


def _build_small_graph() -> KnowledgeGraph:
    """Build a small KnowledgeGraph with 2 functions and 1 CALLS relationship."""
    graph = KnowledgeGraph()

    caller = _make_node(name="caller", file_path="src/a.py")
    callee = _make_node(name="callee", file_path="src/a.py")
    graph.add_node(caller)
    graph.add_node(callee)

    rel = _make_rel(caller.id, callee.id)
    graph.add_relationship(rel)

    return graph


class TestInitializeAndClose:
    def test_initialize_creates_db(self, backend: KuzuBackend) -> None:
        assert backend._db is not None
        assert backend._conn is not None

    def test_close_releases_handles(self, tmp_path: Path) -> None:
        b = KuzuBackend()
        b.initialize(tmp_path / "close_test")
        b.close()
        assert b._db is None
        assert b._conn is None


class TestBulkLoad:
    def test_bulk_load_inserts_nodes_and_relationships(
        self, backend: KuzuBackend
    ) -> None:
        graph = _build_small_graph()
        backend.bulk_load(graph)

        # Both function nodes should be retrievable.
        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        callee_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "callee")

        caller = backend.get_node(caller_id)
        callee = backend.get_node(callee_id)

        assert caller is not None
        assert caller.name == "caller"
        assert callee is not None
        assert callee.name == "callee"

    def test_bulk_load_replaces_existing(self, backend: KuzuBackend) -> None:
        graph = _build_small_graph()
        backend.bulk_load(graph)
        backend.bulk_load(graph)

        rows = backend.execute_raw("MATCH (n:Function) RETURN n.id")
        assert len(rows) == 2


class TestGetNode:
    def test_returns_correct_node(self, backend: KuzuBackend) -> None:
        node = _make_node(name="target_func", file_path="src/x.py")
        backend.add_nodes([node])

        result = backend.get_node(node.id)
        assert result is not None
        assert result.id == node.id
        assert result.name == "target_func"
        assert result.file_path == "src/x.py"
        assert result.label == NodeLabel.FUNCTION

    def test_returns_none_for_missing(self, backend: KuzuBackend) -> None:
        result = backend.get_node("function:nonexistent.py:ghost")
        assert result is None

    def test_returns_none_for_unknown_label(self, backend: KuzuBackend) -> None:
        result = backend.get_node("unknown_label:foo:bar")
        assert result is None

    def test_preserves_boolean_fields(self, backend: KuzuBackend) -> None:
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


class TestCallersAndCallees:
    def test_get_callers(self, backend: KuzuBackend) -> None:
        graph = _build_small_graph()
        backend.bulk_load(graph)

        callee_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "callee")
        callers = backend.get_callers(callee_id)

        assert len(callers) == 1
        assert callers[0].name == "caller"

    def test_get_callees(self, backend: KuzuBackend) -> None:
        graph = _build_small_graph()
        backend.bulk_load(graph)

        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        callees = backend.get_callees(caller_id)

        assert len(callees) == 1
        assert callees[0].name == "callee"

    def test_get_callers_empty(self, backend: KuzuBackend) -> None:
        graph = _build_small_graph()
        backend.bulk_load(graph)

        # The caller has no one calling it.
        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        callers = backend.get_callers(caller_id)
        assert callers == []

    def test_get_callees_empty(self, backend: KuzuBackend) -> None:
        graph = _build_small_graph()
        backend.bulk_load(graph)

        # The callee does not call anyone.
        callee_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "callee")
        callees = backend.get_callees(callee_id)
        assert callees == []


class TestExecuteRaw:
    def test_simple_cypher(self, backend: KuzuBackend) -> None:
        backend.add_nodes([_make_node(name="raw_test")])

        rows = backend.execute_raw("MATCH (n:Function) RETURN n.name")
        assert len(rows) == 1
        assert rows[0][0] == "raw_test"

    def test_return_expression(self, backend: KuzuBackend) -> None:
        rows = backend.execute_raw("RETURN 1 + 2 AS result")
        assert rows == [[3]]


class TestGetIndexedFiles:
    def test_returns_empty_initially(self, backend: KuzuBackend) -> None:
        result = backend.get_indexed_files()
        assert result == {}

    def test_returns_files_after_insert(self, backend: KuzuBackend) -> None:
        file_node = _make_node(
            label=NodeLabel.FILE,
            file_path="src/main.py",
            name="main.py",
            content="print('hello')",
        )
        backend.add_nodes([file_node])

        result = backend.get_indexed_files()
        assert "src/main.py" in result
        # The hash should be the sha256 of the content.
        import hashlib

        expected_hash = hashlib.sha256(b"print('hello')").hexdigest()
        assert result["src/main.py"] == expected_hash


class TestRemoveNodesByFile:
    def test_removes_matching_nodes(self, backend: KuzuBackend) -> None:
        n1 = _make_node(name="f1", file_path="src/a.py")
        n2 = _make_node(name="f2", file_path="src/a.py")
        n3 = _make_node(name="f3", file_path="src/b.py")
        backend.add_nodes([n1, n2, n3])

        backend.remove_nodes_by_file("src/a.py")

        assert backend.get_node(n1.id) is None
        assert backend.get_node(n2.id) is None
        assert backend.get_node(n3.id) is not None

    def test_returns_zero_for_no_match(self, backend: KuzuBackend) -> None:
        result = backend.remove_nodes_by_file("nonexistent.py")
        assert result == 0


class TestTraverse:
    def test_traverse_one_hop(self, backend: KuzuBackend) -> None:
        graph = _build_small_graph()
        backend.bulk_load(graph)

        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        nodes = backend.traverse(caller_id, depth=1, direction="callees")

        assert len(nodes) == 1
        assert nodes[0].name == "callee"

    def test_traverse_zero_depth(self, backend: KuzuBackend) -> None:
        graph = _build_small_graph()
        backend.bulk_load(graph)

        caller_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "caller")
        nodes = backend.traverse(caller_id, depth=0, direction="callees")
        assert nodes == []

    def test_traverse_callers(self, backend: KuzuBackend) -> None:
        graph = _build_small_graph()
        backend.bulk_load(graph)

        # callee is the target; traverse callers should return the caller.
        callee_id = generate_id(NodeLabel.FUNCTION, "src/a.py", "callee")
        nodes = backend.traverse(callee_id, depth=1, direction="callers")

        assert len(nodes) == 1
        assert nodes[0].name == "caller"


class TestMultipleLabels:
    def test_class_and_function(self, backend: KuzuBackend) -> None:
        fn = _make_node(label=NodeLabel.FUNCTION, name="my_fn", file_path="src/c.py")
        cls = _make_node(label=NodeLabel.CLASS, name="MyClass", file_path="src/c.py")
        backend.add_nodes([fn, cls])

        assert backend.get_node(fn.id) is not None
        assert backend.get_node(cls.id) is not None
        assert backend.get_node(fn.id).label == NodeLabel.FUNCTION
        assert backend.get_node(cls.id).label == NodeLabel.CLASS


class TestLoadGraph:
    def test_round_trips_nodes_and_relationships(self, backend: KuzuBackend) -> None:
        n1 = _make_node(name="alpha", file_path="src/a.py")
        n2 = _make_node(name="beta", file_path="src/a.py")
        n3 = _make_node(label=NodeLabel.CLASS, name="Gamma", file_path="src/a.py")
        backend.add_nodes([n1, n2, n3])

        r1 = _make_rel(n1.id, n2.id, RelType.CALLS)
        r2 = _make_rel(n1.id, n3.id, RelType.CALLS)
        backend.add_relationships([r1, r2])

        graph = backend.load_graph()

        assert graph.node_count == 3
        assert graph.relationship_count == 2
        assert graph.get_node(n1.id) is not None
        assert graph.get_node(n2.id) is not None
        assert graph.get_node(n3.id) is not None

    def test_preserves_node_properties(self, backend: KuzuBackend) -> None:
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

        graph = backend.load_graph()
        loaded = graph.get_node(node.id)

        assert loaded is not None
        assert loaded.name == "special"
        assert loaded.signature == "def special() -> bool"
        assert loaded.is_dead is True
        assert loaded.is_entry_point is True
        assert loaded.is_exported is False

    def test_empty_storage_returns_empty_graph(self, backend: KuzuBackend) -> None:
        graph = backend.load_graph()

        assert graph.node_count == 0
        assert graph.relationship_count == 0


class TestDeleteSyntheticNodes:
    def test_removes_community_and_process_keeps_function(
        self, backend: KuzuBackend
    ) -> None:
        fn = _make_node(name="real_func", file_path="src/a.py")
        comm = _make_node(
            label=NodeLabel.COMMUNITY, name="comm_1", file_path=""
        )
        proc = _make_node(
            label=NodeLabel.PROCESS, name="proc_1", file_path=""
        )
        backend.add_nodes([fn, comm, proc])

        # Add MEMBER_OF edge (fn -> community) and STEP_IN_PROCESS (fn -> process).
        r1 = _make_rel(fn.id, comm.id, RelType.MEMBER_OF)
        r2 = _make_rel(fn.id, proc.id, RelType.STEP_IN_PROCESS)
        backend.add_relationships([r1, r2])

        backend.delete_synthetic_nodes()

        graph = backend.load_graph()
        # Only the function node should survive.
        assert graph.node_count == 1
        assert graph.get_node(fn.id) is not None
        assert graph.get_node(comm.id) is None
        assert graph.get_node(proc.id) is None
        # All relationships should be gone (targets deleted).
        assert graph.relationship_count == 0


class TestUpsertEmbeddings:
    def test_upserts_without_wiping(self, backend: KuzuBackend) -> None:
        emb_a = NodeEmbedding(node_id="function:src/a.py:alpha", embedding=[1.0] * 384)
        emb_b = NodeEmbedding(node_id="function:src/a.py:beta", embedding=[3.0] * 384)

        backend.store_embeddings([emb_a])
        backend.upsert_embeddings([emb_b])

        rows = backend.execute_raw(
            "MATCH (e:Embedding) RETURN e.node_id ORDER BY e.node_id"
        )
        node_ids = [r[0] for r in rows]
        assert "function:src/a.py:alpha" in node_ids
        assert "function:src/a.py:beta" in node_ids

    def test_updates_existing_embedding(self, backend: KuzuBackend) -> None:
        emb = NodeEmbedding(node_id="function:src/a.py:alpha", embedding=[1.0] * 384)
        backend.store_embeddings([emb])

        updated_vec = [9.0] + [0.0] * 383
        updated = NodeEmbedding(
            node_id="function:src/a.py:alpha", embedding=updated_vec
        )
        backend.upsert_embeddings([updated])

        rows = backend.execute_raw(
            "MATCH (e:Embedding) WHERE e.node_id = 'function:src/a.py:alpha' "
            "RETURN e.vec"
        )
        assert len(rows) == 1
        assert rows[0][0][0] == 9.0
        assert rows[0][0][1] == 0.0


class TestUpdateDeadFlags:
    def test_sets_dead_and_alive(self, backend: KuzuBackend) -> None:
        n1 = _make_node(name="func_a", file_path="src/a.py")
        n2 = _make_node(name="func_b", file_path="src/a.py")
        backend.add_nodes([n1, n2])

        backend.update_dead_flags(dead_ids={n1.id}, alive_ids={n2.id})

        dead_node = backend.get_node(n1.id)
        alive_node = backend.get_node(n2.id)
        assert dead_node is not None
        assert dead_node.is_dead is True
        assert alive_node is not None
        assert alive_node.is_dead is False


class TestRemoveRelationshipsByType:
    def test_removes_only_specified_type(self, backend: KuzuBackend) -> None:
        n1 = _make_node(name="func_x", file_path="src/a.py")
        n2 = _make_node(name="func_y", file_path="src/a.py")
        backend.add_nodes([n1, n2])

        calls_rel = _make_rel(n1.id, n2.id, RelType.CALLS)
        coupled_rel = _make_rel(n1.id, n2.id, RelType.COUPLED_WITH)
        backend.add_relationships([calls_rel, coupled_rel])

        backend.remove_relationships_by_type(RelType.COUPLED_WITH)

        graph = backend.load_graph()
        rel_types = [r.type for r in graph.iter_relationships()]
        assert RelType.CALLS in rel_types
        assert RelType.COUPLED_WITH not in rel_types


def test_colocated_code_tokens_is_format_agnostic() -> None:
    """Display-code → logical-key resolution must not assume one logging/constants layout."""
    from horus_source.core.storage.kuzu_backend import _colocated_code_tokens

    # nested object: `E_KEY: { code: 'ERR4624' }`
    nested = "E_OTHER: { code: 'ERR0001' },\nE_SYNC_PRODUCT_UPDATE_EXISTING: {\n  code: 'ERR4624',\n}"
    assert _colocated_code_tokens(nested, "ERR4624")[0] == "E_SYNC_PRODUCT_UPDATE_EXISTING"

    # flat map: `E_KEY: 'ERR4624'`
    assert _colocated_code_tokens("E_SYNC_PRODUCT_UPDATE_EXISTING: 'ERR4624',", "ERR4624")[0] == (
        "E_SYNC_PRODUCT_UPDATE_EXISTING"
    )

    # inline, key AFTER the code: `{ code: 'ERR4624', key: 'E_FOO_BAR' }`
    assert "E_FOO_BAR" in _colocated_code_tokens("{ code: 'ERR4624', key: 'E_FOO_BAR' }", "ERR4624")

    # no co-located code token → empty (caller falls back; nothing format-specific assumed)
    assert _colocated_code_tokens("just some prose here", "ERR4624") == []


# --- Corrupt-database recovery (HOR-409) ------------------------------------


def _make_corrupt_db(db_path: Path) -> None:
    """Write garbage to *db_path* so KùzuDB rejects it as not a valid database file."""
    db_path.write_bytes(b"this is not a kuzu database file at all -- pure garbage\n" * 32)


def test_initialize_raises_on_corrupt_db_without_recovery(tmp_path: Path) -> None:
    """Without recover_corrupt, a corrupt database surfaces as an error (no silent data loss)."""
    db_path = tmp_path / "kuzu"
    _make_corrupt_db(db_path)
    b = KuzuBackend()
    with pytest.raises(RuntimeError, match="(?i)valid kuzu database"):
        b.initialize(db_path)
    b.close()


def test_initialize_recovers_corrupt_db(tmp_path: Path) -> None:
    """recover_corrupt=True deletes a corrupt DB, recreates it empty, and flags the recreation."""
    db_path = tmp_path / "kuzu"
    _make_corrupt_db(db_path)

    b = KuzuBackend()
    b.initialize(db_path, recover_corrupt=True)
    try:
        assert b.recreated_due_to_corruption is True
        # The recreated database is usable and empty: a write + read round-trips.
        node = _make_node(name="recovered")
        b.add_nodes([node])
        assert b.get_node(node.id) is not None
    finally:
        b.close()


def test_initialize_sidecar_wal_removed_on_recovery(tmp_path: Path) -> None:
    """A stale write-ahead sidecar next to a corrupt DB is cleaned up during recovery."""
    db_path = tmp_path / "kuzu"
    _make_corrupt_db(db_path)
    wal = db_path.with_name(db_path.name + ".wal")
    wal.write_bytes(b"stale wal")

    b = KuzuBackend()
    b.initialize(db_path, recover_corrupt=True)
    try:
        assert b.recreated_due_to_corruption is True
        assert not wal.exists()
    finally:
        b.close()


def test_initialize_clean_db_not_flagged_as_corrupt(tmp_path: Path) -> None:
    """A normal create/open path must never set the corruption-recreated flag."""
    db_path = tmp_path / "kuzu"
    b = KuzuBackend()
    b.initialize(db_path, recover_corrupt=True)
    try:
        assert b.recreated_due_to_corruption is False
    finally:
        b.close()
