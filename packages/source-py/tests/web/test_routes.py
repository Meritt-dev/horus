from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import (
    GraphNode,
    GraphRelationship,
    NodeLabel,
    RelType,
)


def _make_app(
    storage: MagicMock,
    repo_path: Path | None = None,
    watch: bool = False,
) -> FastAPI:
    """Build a FastAPI app with a mocked storage backend.

    Instead of calling ``create_app`` (which needs a real KuzuDB path),
    this replicates the app assembly from ``app.py`` but injects a mock
    storage directly.
    """
    from horus_source.web.routes.analysis import router as analysis_router
    from horus_source.web.routes.cypher import router as cypher_router
    from horus_source.web.routes.diff import router as diff_router
    from horus_source.web.routes.events import router as events_router
    from horus_source.web.routes.files import router as files_router
    from horus_source.web.routes.graph import router as graph_router
    from horus_source.web.routes.host import router as host_router
    from horus_source.web.routes.processes import router as processes_router
    from horus_source.web.routes.search import router as search_router

    app = FastAPI()
    app.state.storage = storage
    app.state.repo_path = repo_path
    app.state.event_listeners = None
    app.state.watch = watch
    app.state.host_url = "http://127.0.0.1:8420"
    app.state.mcp_url = "http://127.0.0.1:8420/mcp"
    app.state.mode = "host" if watch else "standalone"

    app.include_router(graph_router)
    app.include_router(host_router)
    app.include_router(search_router)
    app.include_router(analysis_router)
    app.include_router(files_router)
    app.include_router(cypher_router)
    app.include_router(diff_router)
    app.include_router(processes_router)
    app.include_router(events_router)

    return app


def _sample_node(
    node_id: str = "function:src/app.py:main",
    label: NodeLabel = NodeLabel.FUNCTION,
    name: str = "main",
    file_path: str = "src/app.py",
    start_line: int = 1,
    end_line: int = 20,
    **kwargs,
) -> GraphNode:
    return GraphNode(
        id=node_id,
        label=label,
        name=name,
        file_path=file_path,
        start_line=start_line,
        end_line=end_line,
        **kwargs,
    )


def _sample_edge(
    edge_id: str = "calls:main->helper",
    rel_type: RelType = RelType.CALLS,
    source: str = "function:src/app.py:main",
    target: str = "function:src/utils.py:helper",
    **props,
) -> GraphRelationship:
    return GraphRelationship(
        id=edge_id,
        type=rel_type,
        source=source,
        target=target,
        properties=props,
    )


@pytest.fixture
def mock_storage() -> MagicMock:
    """Create a MagicMock that mimics StorageBackend with sane defaults."""
    storage = MagicMock()

    # Default: empty graph
    graph = KnowledgeGraph()
    storage.load_graph.return_value = graph

    # Default: node lookup returns None (tests override as needed)
    storage.get_node.return_value = None
    storage.get_callers_with_confidence.return_value = []
    storage.get_callees_with_confidence.return_value = []
    storage.get_type_refs.return_value = []
    storage.get_process_memberships.return_value = {}
    storage.traverse_with_depth.return_value = []
    storage.execute_raw.return_value = []
    # Typed analytics defaults (HOR-392 stage 2) — empty unless a test overrides.
    storage.count_nodes_by_label.return_value = {}
    storage.count_edges_by_type.return_value = {}
    storage.get_dead_code_symbols.return_value = []
    storage.get_coupling_pairs.return_value = []
    storage.get_coupling_strengths.return_value = []
    storage.get_communities_with_members.return_value = []
    storage.count_communities.return_value = 0
    storage.avg_calls_confidence.return_value = None
    storage.count_symbols_and_dead.return_value = (0, 0)
    storage.count_callables_in_processes.return_value = (0, 0)
    storage.get_file_nodes.return_value = []
    storage.get_symbol_counts_by_file.return_value = {}
    storage.get_processes_with_steps.return_value = []
    # File-level node-detail context + CLI read-path defaults (HOR-392).
    storage.get_file_imports.return_value = []
    storage.get_file_coupling.return_value = []
    storage.get_symbols_in_file.return_value = []
    storage.content_contains_any.return_value = []
    storage.flows_for_symbol.return_value = {"processes": [], "steps": []}
    storage.symbols_by_label.return_value = []

    return storage


@pytest.fixture
def client(mock_storage: MagicMock) -> TestClient:
    """Create a TestClient with mocked storage and no repo_path."""
    app = _make_app(mock_storage)
    return TestClient(app)


@pytest.fixture
def client_with_repo(mock_storage: MagicMock, tmp_path: Path) -> TestClient:
    """Create a TestClient with mocked storage and a real repo_path."""
    app = _make_app(mock_storage, repo_path=tmp_path, watch=True)
    return TestClient(app)


class TestGraphEndpoint:
    def test_empty_graph(self, client: TestClient) -> None:
        response = client.get("/graph")
        assert response.status_code == 200
        data = response.json()
        assert "nodes" in data
        assert "edges" in data
        assert data["nodes"] == []
        assert data["edges"] == []

    def test_graph_with_nodes_and_edges(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        node = _sample_node()
        edge = _sample_edge(confidence=0.9)
        graph = KnowledgeGraph()
        graph.add_node(node)
        graph.add_node(
            _sample_node(
                node_id="function:src/utils.py:helper",
                name="helper",
                file_path="src/utils.py",
            )
        )
        graph.add_relationship(edge)
        mock_storage.load_graph.return_value = graph

        response = client.get("/graph")
        assert response.status_code == 200
        data = response.json()
        assert len(data["nodes"]) == 2
        assert len(data["edges"]) == 1
        assert data["total"] == 2  # total node count

        # Verify node serialization shape (camelCase)
        n = data["nodes"][0]
        assert "id" in n
        assert "label" in n
        assert "name" in n
        assert "filePath" in n
        assert "startLine" in n
        assert "endLine" in n
        assert "isDead" in n
        assert "isEntryPoint" in n
        assert "isExported" in n

        # Verify edge serialization shape
        e = data["edges"][0]
        assert "id" in e
        assert "type" in e
        assert "source" in e
        assert "target" in e
        assert "confidence" in e

    def test_graph_load_failure(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.load_graph.side_effect = RuntimeError("DB error")
        response = client.get("/graph")
        assert response.status_code == 500


class TestOverviewEndpoint:
    def test_empty_overview(self, client: TestClient) -> None:
        response = client.get("/overview")
        assert response.status_code == 200
        data = response.json()
        assert "nodesByLabel" in data
        assert "edgesByType" in data
        assert "totalNodes" in data
        assert "totalEdges" in data
        assert data["totalNodes"] == 0
        assert data["totalEdges"] == 0

    def test_overview_with_data(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.count_nodes_by_label.return_value = {"function": 42, "class": 10}
        mock_storage.count_edges_by_type.return_value = {"calls": 100, "imports": 30}

        response = client.get("/overview")
        assert response.status_code == 200
        data = response.json()
        assert data["totalNodes"] == 52
        assert data["totalEdges"] == 130
        assert data["nodesByLabel"]["function"] == 42
        assert data["edgesByType"]["calls"] == 100


class TestHostEndpoint:
    def test_host_info(self, client_with_repo: TestClient, tmp_path: Path) -> None:
        response = client_with_repo.get("/host")
        assert response.status_code == 200
        data = response.json()
        assert data["repoPath"] == str(tmp_path)
        assert data["hostUrl"] == "http://127.0.0.1:8420"
        assert data["mcpUrl"] == "http://127.0.0.1:8420/mcp"
        # HOR-425: absent a runtime the host reports not-indexing.
        assert data["indexing"] is False

    def test_host_info_reports_indexing_from_runtime(self, tmp_path: Path) -> None:
        # HOR-425: while the background index/embed runs, /host stays reachable and
        # reports indexing=True so clients show "indexing in progress".
        from types import SimpleNamespace

        from fastapi import FastAPI
        from fastapi.testclient import TestClient as _TestClient

        from horus_source.web.routes.host import router as host_router

        app = FastAPI()
        app.state.repo_path = tmp_path
        app.state.host_url = "http://127.0.0.1:8420"
        app.state.mcp_url = "http://127.0.0.1:8420/mcp"
        app.state.watch = False
        app.state.mode = "host"
        app.state.runtime = SimpleNamespace(indexing=True)
        app.include_router(host_router)

        data = _TestClient(app).get("/host").json()
        assert data["indexing"] is True


class TestNodeEndpoint:
    def test_node_not_found(self, client: TestClient) -> None:
        response = client.get("/node/nonexistent:id")
        assert response.status_code == 404

    def test_node_with_context(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        target_node = _sample_node()
        caller_node = _sample_node(
            node_id="function:src/cli.py:run",
            name="run",
            file_path="src/cli.py",
        )
        callee_node = _sample_node(
            node_id="function:src/utils.py:helper",
            name="helper",
            file_path="src/utils.py",
        )
        type_ref_node = _sample_node(
            node_id="class:src/models.py:User",
            label=NodeLabel.CLASS,
            name="User",
            file_path="src/models.py",
        )

        mock_storage.get_node.return_value = target_node
        mock_storage.get_callers_with_confidence.return_value = [
            (caller_node, 1.0)
        ]
        mock_storage.get_callees_with_confidence.return_value = [
            (callee_node, 0.8)
        ]
        mock_storage.get_type_refs.return_value = [type_ref_node]
        mock_storage.get_process_memberships.return_value = {}

        response = client.get("/node/function:src/app.py:main")
        assert response.status_code == 200
        data = response.json()

        assert "node" in data
        assert data["node"]["name"] == "main"
        assert "callers" in data
        assert len(data["callers"]) == 1
        assert data["callers"][0]["confidence"] == 1.0
        assert "callees" in data
        assert len(data["callees"]) == 1
        assert data["callees"][0]["confidence"] == 0.8
        assert "typeRefs" in data
        assert len(data["typeRefs"]) == 1
        assert "processMemberships" in data
        # Extended CLI read-path fields (HOR-392).
        assert "content" in data["node"]
        assert "imports" in data
        assert "coupledWith" in data
        assert "communities" in data

    def test_node_detail_includes_file_context_and_communities(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        target = _sample_node()
        mock_storage.get_node.return_value = target
        mock_storage.get_file_imports.return_value = ["src/utils.py"]
        mock_storage.get_file_coupling.return_value = [("src/db.py", 0.8, 5)]
        mock_storage.get_communities_with_members.return_value = [
            ("community::auth", "auth", 0.9, [target.id]),
            ("community::other", "other", 0.5, ["function:x:y"]),
        ]

        response = client.get(f"/node/{target.id}")
        assert response.status_code == 200
        data = response.json()
        assert data["imports"] == ["src/utils.py"]
        assert data["coupledWith"] == [
            {"file": "src/db.py", "strength": 0.8, "coChanges": 5}
        ]
        assert data["communities"] == [{"id": "community::auth", "name": "auth"}]


class TestCliReadPathEndpoints:
    def test_content_search(self, mock_storage: MagicMock, client: TestClient) -> None:
        mock_storage.content_contains_any.return_value = [
            {
                "id": "function:src/sync.py:raise_err",
                "name": "raise_err",
                "file_path": "src/sync.py",
                "content": "raise Error('E_CODE')",
            }
        ]
        response = client.post(
            "/content-search", json={"tokens": ["E_CODE"], "limit": 5}
        )
        assert response.status_code == 200
        results = response.json()["results"]
        assert results == [
            {
                "nodeId": "function:src/sync.py:raise_err",
                "name": "raise_err",
                "filePath": "src/sync.py",
                "content": "raise Error('E_CODE')",
            }
        ]
        mock_storage.content_contains_any.assert_called_once_with(["E_CODE"], 5)

    def test_content_search_files_only(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        # filesOnly returns per-token distinct file paths (external-system detection)
        # and never touches the content path.
        mock_storage.files_containing.return_value = {
            "redis": ["src/queue.ts"],
            "kafka": [],
        }
        response = client.post(
            "/content-search",
            json={"tokens": ["redis", "kafka"], "limit": 500, "filesOnly": True},
        )
        assert response.status_code == 200
        assert response.json() == {"matches": {"redis": ["src/queue.ts"], "kafka": []}}
        mock_storage.files_containing.assert_called_once_with(["redis", "kafka"], 500)
        mock_storage.content_contains_any.assert_not_called()

    def test_symbols_exact_excludes_files_and_hydrates_lines(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        from horus_source.core.storage.base import SearchResult

        sym = SearchResult(
            node_id="function:src/app.py:main",
            score=1.0,
            node_name="main",
            file_path="src/app.py",
            label="function",
        )
        file_hit = SearchResult(
            node_id="file:src/main.py:main.py",
            score=1.0,
            node_name="main.py",
            file_path="src/main.py",
            label="file",
        )
        mock_storage.exact_name_search.return_value = [sym, file_hit]
        mock_storage.get_node.return_value = _sample_node(
            node_id="function:src/app.py:main", start_line=4, end_line=12
        )

        response = client.get("/symbols/exact", params={"name": "main", "limit": 10})
        assert response.status_code == 200
        results = response.json()["results"]
        assert len(results) == 1  # file-label hit dropped
        assert results[0]["nodeId"] == "function:src/app.py:main"
        assert results[0]["startLine"] == 4
        assert results[0]["endLine"] == 12

    def test_symbols_by_label(self, mock_storage: MagicMock, client: TestClient) -> None:
        mock_storage.symbols_by_label.return_value = [
            {
                "id": "function:src/a.py:f",
                "label": "function",
                "name": "f",
                "file_path": "src/a.py",
                "start_line": 1,
                "end_line": 3,
                "class_name": "",
                "is_entry_point": False,
                "is_exported": True,
                "signature": "def f()",
            }
        ]
        response = client.get("/symbols", params={"labels": "function,method", "limit": 50})
        assert response.status_code == 200
        symbols = response.json()["symbols"]
        assert symbols[0]["name"] == "f"
        assert symbols[0]["isExported"] is True
        assert symbols[0]["startLine"] == 1
        mock_storage.symbols_by_label.assert_called_once_with(["function", "method"], 50)

    def test_nodes_lines_batch(self, mock_storage: MagicMock, client: TestClient) -> None:
        def _fake_get_node(node_id: str):
            if node_id == "function:src/a.py:f":
                return _sample_node(node_id=node_id, file_path="src/a.py", start_line=1, end_line=9)
            return None

        mock_storage.get_node.side_effect = _fake_get_node
        response = client.post(
            "/nodes/lines",
            json={"ids": ["function:src/a.py:f", "function:missing:ghost"]},
        )
        assert response.status_code == 200
        lines = response.json()["lines"]
        assert lines == {
            "function:src/a.py:f": {
                "filePath": "src/a.py",
                "startLine": 1,
                "endLine": 9,
            }
        }

    def test_flows_endpoint(self, mock_storage: MagicMock, client: TestClient) -> None:
        mock_storage.flows_for_symbol.return_value = {
            "processes": [{"id": "process::Checkout", "name": "Checkout"}],
            "steps": [
                {
                    "id": "function:src/a.py:caller",
                    "name": "caller",
                    "file_path": "src/a.py",
                    "start_line": 10,
                    "step_number": 1,
                }
            ],
        }
        response = client.get("/flows/function:src/a.py:caller")
        assert response.status_code == 200
        data = response.json()
        assert data["processes"] == [{"id": "process::Checkout", "name": "Checkout"}]
        assert data["steps"] == [
            {
                "nodeId": "function:src/a.py:caller",
                "name": "caller",
                "filePath": "src/a.py",
                "startLine": 10,
                "stepNumber": 1,
            }
        ]

    def test_flows_product_mode_drops_test_file_steps(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.flows_for_symbol.return_value = {
            "processes": [{"id": "process::Checkout", "name": "Checkout"}],
            "steps": [
                {
                    "id": "function:src/a.py:caller",
                    "name": "caller",
                    "file_path": "src/a.py",
                    "start_line": 10,
                    "step_number": 1,
                },
                {
                    "id": "function:tests/test_a.py:test_caller",
                    "name": "test_caller",
                    "file_path": "tests/test_a.py",
                    "start_line": 5,
                    "step_number": 2,
                },
            ],
        }
        response = client.get("/flows/function:src/a.py:caller")
        assert response.status_code == 200
        data = response.json()
        assert [s["nodeId"] for s in data["steps"]] == ["function:src/a.py:caller"]

        # include_tests=true restores everything.
        response = client.get("/flows/function:src/a.py:caller?include_tests=true")
        assert len(response.json()["steps"]) == 2

    def test_flows_all_steps_test_only_returns_empty(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.flows_for_symbol.return_value = {
            "processes": [{"id": "process::T", "name": "T"}],
            "steps": [
                {
                    "id": "function:tests/test_a.py:test_x",
                    "name": "test_x",
                    "file_path": "tests/test_a.py",
                    "start_line": 1,
                    "step_number": 0,
                }
            ],
        }
        response = client.get("/flows/function:tests/test_a.py:test_x")
        data = response.json()
        assert data["steps"] == []
        assert data["processes"] == []

    def test_class_methods(self, mock_storage: MagicMock, client: TestClient) -> None:
        method = _sample_node(
            node_id="method:src/svc.py:OrderService.run",
            label=NodeLabel.METHOD,
            name="run",
            file_path="src/svc.py",
            class_name="OrderService",
        )
        other = _sample_node(
            node_id="method:src/svc.py:Other.run",
            label=NodeLabel.METHOD,
            name="run",
            file_path="src/svc.py",
            class_name="Other",
        )
        free_fn = _sample_node(
            node_id="function:src/svc.py:helper",
            name="helper",
            file_path="src/svc.py",
        )
        mock_storage.get_symbols_in_file.return_value = [method, other, free_fn]
        response = client.get(
            "/class-methods", params={"file": "src/svc.py", "class": "OrderService"}
        )
        assert response.status_code == 200
        methods = response.json()["methods"]
        assert [m["name"] for m in methods] == ["run"]
        assert methods[0]["className"] == "OrderService"


class TestSearchEndpoint:
    def test_search_returns_results(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        from horus_source.core.storage.base import SearchResult

        search_results = [
            SearchResult(
                node_id="function:src/auth.py:validate",
                score=0.95,
                node_name="validate",
                file_path="src/auth.py",
                label="function",
                snippet="def validate(user): ...",
            ),
        ]

        with patch("horus_source.web.routes.search.hybrid_search", return_value=search_results):
            with patch("horus_source.web.routes.search.embed_query", return_value=None):
                response = client.post(
                    "/search", json={"query": "validate", "limit": 10}
                )

        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert len(data["results"]) == 1

        r = data["results"][0]
        assert r["nodeId"] == "function:src/auth.py:validate"
        assert r["score"] == 0.95
        assert r["name"] == "validate"
        assert r["filePath"] == "src/auth.py"
        assert r["label"] == "function"
        assert r["snippet"] == "def validate(user): ..."

    def test_search_empty_results(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        with patch("horus_source.web.routes.search.hybrid_search", return_value=[]):
            with patch("horus_source.web.routes.search.embed_query", return_value=None):
                response = client.post(
                    "/search", json={"query": "nonexistent", "limit": 5}
                )

        assert response.status_code == 200
        data = response.json()
        assert data["results"] == []

    def test_search_failure(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        with patch(
            "horus_source.web.routes.search.hybrid_search",
            side_effect=RuntimeError("search error"),
        ):
            with patch("horus_source.web.routes.search.embed_query", return_value=None):
                response = client.post(
                    "/search", json={"query": "test"}
                )

        assert response.status_code == 500


class TestDeadCodeEndpoint:
    def test_no_dead_code(self, client: TestClient) -> None:
        response = client.get("/dead-code")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 0
        assert data["byFile"] == {}

    def test_dead_code_found(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.get_dead_code_symbols.return_value = [
            ("id1", "unused_func", "src/old.py", 10, "function"),
            ("id2", "stale_helper", "src/old.py", 25, "function"),
            ("id3", "OldModel", "src/models.py", 5, "class"),
        ]

        response = client.get("/dead-code")
        assert response.status_code == 200
        data = response.json()
        assert data["total"] == 3
        assert "src/old.py" in data["byFile"]
        assert len(data["byFile"]["src/old.py"]) == 2
        assert "src/models.py" in data["byFile"]

    def test_dead_code_query_failure(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.get_dead_code_symbols.side_effect = RuntimeError("DB error")
        response = client.get("/dead-code")
        assert response.status_code == 500


class TestCouplingEndpoint:
    def test_no_coupling(self, client: TestClient) -> None:
        response = client.get("/coupling")
        assert response.status_code == 200
        data = response.json()
        assert "pairs" in data
        assert data["pairs"] == []

    def test_coupling_with_data(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.get_coupling_pairs.return_value = [
            ("FileA", "src/a.py", "FileB", "src/b.py", 0.85, 12),
        ]

        response = client.get("/coupling")
        assert response.status_code == 200
        data = response.json()
        assert len(data["pairs"]) == 1
        pair = data["pairs"][0]
        assert pair["fileA"] == "src/a.py"
        assert pair["fileB"] == "src/b.py"
        assert pair["strength"] == 0.85
        assert pair["coChanges"] == 12


class TestHealthEndpoint:
    def test_health_returns_score_and_breakdown(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        # The health endpoint composes five typed analytics calls.
        mock_storage.count_symbols_and_dead.return_value = (170, 5)
        mock_storage.get_coupling_strengths.return_value = [0.5, 0.3]
        mock_storage.count_communities.return_value = 3
        mock_storage.avg_calls_confidence.return_value = 0.9
        mock_storage.count_callables_in_processes.return_value = (80, 15)

        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["score"] > 0
        assert "breakdown" in data
        breakdown = data["breakdown"]
        assert "deadCode" in breakdown
        assert "coupling" in breakdown
        assert "modularity" in breakdown
        assert "confidence" in breakdown
        assert "coverage" in breakdown
        assert breakdown["deadCode"] > 90  # very few dead symbols
        assert breakdown["coupling"] == 100.0  # no high coupling

    def test_health_handles_empty_db(self, client: TestClient) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert "score" in data
        assert "breakdown" in data


class TestCommunitiesEndpoint:
    def test_no_communities(self, client: TestClient) -> None:
        response = client.get("/communities")
        assert response.status_code == 200
        data = response.json()
        assert "communities" in data
        assert data["communities"] == []

    def test_communities_with_data(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.get_communities_with_members.return_value = [
            ("community:auth", "Auth Module", None, ["func:login", "func:register"]),
        ]

        response = client.get("/communities")
        assert response.status_code == 200
        data = response.json()
        assert len(data["communities"]) == 1
        comm = data["communities"][0]
        assert comm["id"] == "community:auth"
        assert comm["name"] == "Auth Module"
        assert comm["memberCount"] == 2
        assert comm["cohesion"] is None
        assert len(comm["members"]) == 2


class TestProcessesEndpoint:
    def test_no_processes(self, client: TestClient) -> None:
        response = client.get("/processes")
        assert response.status_code == 200
        data = response.json()
        assert "processes" in data
        assert data["processes"] == []

    def test_processes_with_data(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.get_processes_with_steps.return_value = [
            ("process:login-flow", "Login Flow",
             ["func:validate", "func:auth"], [1, 2]),
        ]

        response = client.get("/processes")
        assert response.status_code == 200
        data = response.json()
        assert len(data["processes"]) == 1
        proc = data["processes"][0]
        assert proc["name"] == "Login Flow"
        assert proc["kind"] is None
        assert proc["stepCount"] == 2
        assert len(proc["steps"]) == 2
        assert proc["steps"][0]["nodeId"] == "func:validate"
        assert proc["steps"][0]["stepNumber"] == 1


class TestCypherEndpoint:
    def test_valid_query(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = [
            ["main", "src/app.py", 1],
            ["helper", "src/utils.py", 5],
        ]

        response = client.post(
            "/cypher",
            json={"query": "SELECT name, file_path, start_line FROM nodes"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "columns" in data
        assert "rows" in data
        assert "rowCount" in data
        assert "durationMs" in data
        assert data["rowCount"] == 2
        assert len(data["rows"]) == 2
        assert isinstance(data["durationMs"], (int, float))

    def test_empty_results(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = []

        response = client.post(
            "/cypher",
            json={"query": "SELECT * FROM nodes WHERE 1 = 0"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["rowCount"] == 0
        assert data["rows"] == []

    def test_null_results(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = None

        response = client.post(
            "/cypher",
            json={"query": "SELECT * FROM nodes WHERE 1 = 0"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["rowCount"] == 0

    def test_write_query_blocked_create(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "CREATE (n:Test {name: 'test'})"},
        )
        assert response.status_code == 400
        assert "read-only" in response.json()["detail"].lower()

    def test_write_query_blocked_delete(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "MATCH (n) DELETE n"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_set(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "MATCH (n) SET n.name = 'hacked'"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_drop(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "DROP TABLE Node"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_merge(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "MERGE (n:Test {name: 'x'})"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_detach(self, client: TestClient) -> None:
        response = client.post(
            "/cypher",
            json={"query": "MATCH (n) DETACH DELETE n"},
        )
        assert response.status_code == 400

    def test_write_query_blocked_case_insensitive(
        self, client: TestClient
    ) -> None:
        response = client.post(
            "/cypher",
            json={"query": "match (n) delete n"},
        )
        assert response.status_code == 400

    def test_write_keyword_in_comment_allowed(self, client: TestClient) -> None:
        mock_storage = client.app.state.storage
        mock_storage.execute_raw.return_value = [["ok"]]
        response = client.post(
            "/cypher", json={"query": "SELECT name FROM nodes -- DROP TABLE nodes"}
        )
        assert response.status_code == 200

    def test_write_keyword_outside_comment_blocked(self, client: TestClient) -> None:
        response = client.post(
            "/cypher", json={"query": "/* harmless */ CREATE TABLE evil (x)"}
        )
        assert response.status_code == 400

    def test_write_query_blocked_remove(self, client: TestClient) -> None:
        response = client.post("/cypher", json={"query": "MATCH (n) REMOVE n.name"})
        assert response.status_code == 400

    def test_write_query_blocked_install(self, client: TestClient) -> None:
        response = client.post("/cypher", json={"query": "INSTALL httpfs"})
        assert response.status_code == 400

    def test_write_query_blocked_load(self, client: TestClient) -> None:
        response = client.post("/cypher", json={"query": "LOAD FROM 'file.csv'"})
        assert response.status_code == 400

    def test_write_query_blocked_copy(self, client: TestClient) -> None:
        response = client.post("/cypher", json={"query": "COPY Node FROM 'file.csv'"})
        assert response.status_code == 400

    def test_query_execution_failure(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.side_effect = RuntimeError("Syntax error in query")
        response = client.post(
            "/cypher",
            json={"query": "SELECT invalid FROM nope"},
        )
        assert response.status_code == 400
        assert "Syntax error" in response.json()["detail"]

    def test_columns_extracted_from_return(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.execute_raw.return_value = [["test", 42]]

        response = client.post(
            "/cypher",
            json={"query": "SELECT name AS name, count(*) FROM nodes"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "name" in data["columns"]


class TestTreeEndpoint:
    def test_empty_tree(self, client: TestClient) -> None:
        response = client.get("/tree")
        assert response.status_code == 200
        data = response.json()
        assert "tree" in data
        assert data["tree"] == []

    def test_tree_with_files(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.get_file_nodes.return_value = [
            ("file:src/app.py", "app.py", "src/app.py", "python"),
            ("file:src/utils.py", "utils.py", "src/utils.py", "python"),
        ]
        mock_storage.get_symbol_counts_by_file.return_value = {
            "src/app.py": 5, "src/utils.py": 3
        }

        response = client.get("/tree")
        assert response.status_code == 200
        data = response.json()
        assert len(data["tree"]) >= 1

        # Should have a "src" folder at root
        src_folder = next(
            (item for item in data["tree"] if item["name"] == "src"), None
        )
        assert src_folder is not None
        assert src_folder["type"] == "folder"
        assert "children" in src_folder


class TestFileEndpoint:
    def test_no_repo_path(self, client: TestClient) -> None:
        response = client.get("/file?path=src/app.py")
        assert response.status_code == 400
        assert "repo_path" in response.json()["detail"].lower()

    def test_file_not_found(
        self, client_with_repo: TestClient
    ) -> None:
        response = client_with_repo.get("/file?path=nonexistent.py")
        assert response.status_code == 404

    def test_file_found(
        self, mock_storage: MagicMock, tmp_path: Path
    ) -> None:
        # Create a real file in the tmp repo
        src_dir = tmp_path / "src"
        src_dir.mkdir()
        test_file = src_dir / "app.py"
        test_file.write_text("def main():\n    pass\n", encoding="utf-8")

        app = _make_app(mock_storage, repo_path=tmp_path)
        client = TestClient(app)

        response = client.get("/file?path=src/app.py")
        assert response.status_code == 200
        data = response.json()
        assert data["path"] == "src/app.py"
        assert "def main()" in data["content"]
        assert data["language"] == "python"

    def test_path_traversal_blocked(
        self, mock_storage: MagicMock, tmp_path: Path
    ) -> None:
        app = _make_app(mock_storage, repo_path=tmp_path)
        client = TestClient(app)

        response = client.get("/file?path=../../etc/passwd")
        assert response.status_code == 400
        assert "traversal" in response.json()["detail"].lower()


class TestDiffEndpoint:
    def test_no_repo_path(self, client: TestClient) -> None:
        response = client.post("/diff", json={"base": "main", "compare": "feature"})
        assert response.status_code == 400
        assert "repo_path" in response.json()["detail"].lower()

    def test_diff_success(
        self, mock_storage: MagicMock, tmp_path: Path
    ) -> None:
        from dataclasses import dataclass
        from dataclasses import field as dc_field

        @dataclass
        class FakeDiffResult:
            added_nodes: list = dc_field(default_factory=list)
            removed_nodes: list = dc_field(default_factory=list)
            modified_nodes: list = dc_field(default_factory=list)
            added_relationships: list = dc_field(default_factory=list)
            removed_relationships: list = dc_field(default_factory=list)

        added_node = _sample_node(
            node_id="function:src/new.py:new_func",
            name="new_func",
            file_path="src/new.py",
        )
        fake_result = FakeDiffResult(added_nodes=[added_node])

        app = _make_app(mock_storage, repo_path=tmp_path)
        client = TestClient(app)

        with patch("horus_source.web.routes.diff.diff_branches", return_value=fake_result):
            response = client.post(
                "/diff", json={"base": "main", "compare": "feature"}
            )

        assert response.status_code == 200
        data = response.json()
        assert "added" in data
        assert "removed" in data
        assert "modified" in data
        assert "addedEdges" in data
        assert "removedEdges" in data
        assert len(data["added"]) == 1
        assert data["added"][0]["name"] == "new_func"

    def test_diff_with_modified_nodes(
        self, mock_storage: MagicMock, tmp_path: Path
    ) -> None:
        from dataclasses import dataclass
        from dataclasses import field as dc_field

        base_node = _sample_node(
            node_id="function:src/utils.py:helper",
            name="helper",
            file_path="src/utils.py",
        )
        current_node = _sample_node(
            node_id="function:src/utils.py:helper",
            name="helper",
            file_path="src/utils.py",
        )
        current_node.content = "def helper(): return 42"

        @dataclass
        class FakeModifiedResult:
            added_nodes: list = dc_field(default_factory=list)
            removed_nodes: list = dc_field(default_factory=list)
            modified_nodes: list = dc_field(default_factory=list)
            added_relationships: list = dc_field(default_factory=list)
            removed_relationships: list = dc_field(default_factory=list)

        fake_result = FakeModifiedResult(modified_nodes=[(base_node, current_node)])

        app = _make_app(mock_storage, repo_path=tmp_path)
        client = TestClient(app)

        with patch("horus_source.web.routes.diff.diff_branches", return_value=fake_result):
            response = client.post(
                "/diff", json={"base": "main", "compare": "dev"}
            )

        assert response.status_code == 200
        data = response.json()
        assert len(data["modified"]) == 1
        assert "before" in data["modified"][0]
        assert "after" in data["modified"][0]

    def test_diff_value_error(
        self, mock_storage: MagicMock, tmp_path: Path
    ) -> None:
        app = _make_app(mock_storage, repo_path=tmp_path)
        client = TestClient(app)

        with patch(
            "horus_source.web.routes.diff.diff_branches",
            side_effect=ValueError("Invalid branch range"),
        ):
            response = client.post(
                "/diff", json={"base": "main", "compare": "nonexistent"}
            )

        assert response.status_code == 400


class TestReindexEndpoint:
    def test_reindex_no_repo_path(self, client: TestClient) -> None:
        response = client.post("/reindex")
        assert response.status_code == 400

    def test_reindex_not_in_watch_mode(
        self, mock_storage: MagicMock
    ) -> None:
        app = _make_app(mock_storage, repo_path=Path("/tmp/fake"), watch=False)
        client = TestClient(app)
        response = client.post("/reindex")
        assert response.status_code == 400
        assert "watch" in response.json()["detail"].lower()

    def test_reindex_success(self, client_with_repo: TestClient) -> None:
        with patch("horus_source.web.routes.analysis.run_pipeline"):
            response = client_with_repo.post("/reindex")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "started"


class TestImpactEndpoint:
    def test_node_not_found(self, client: TestClient) -> None:
        response = client.get("/impact/nonexistent:id")
        assert response.status_code == 404

    def test_impact_with_affected(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        target = _sample_node()
        affected = _sample_node(
            node_id="function:src/cli.py:run",
            name="run",
            file_path="src/cli.py",
        )

        mock_storage.get_node.return_value = target
        mock_storage.traverse_with_depth.return_value = [(affected, 1)]

        response = client.get("/impact/function:src/app.py:main")
        assert response.status_code == 200
        data = response.json()
        assert "target" in data
        assert "affected" in data
        assert "depths" in data
        assert data["affected"] == 1
        assert data["target"]["name"] == "main"

    def test_impact_defaults_to_product_only(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.get_node.return_value = _sample_node()
        mock_storage.traverse_with_depth.return_value = []

        response = client.get("/impact/function:src/app.py:main")
        assert response.status_code == 200
        mock_storage.traverse_with_depth.assert_called_once_with(
            "function:src/app.py:main", 3, direction="callers", product_only=True
        )

    def test_impact_include_tests_opt_in(
        self, mock_storage: MagicMock, client: TestClient
    ) -> None:
        mock_storage.get_node.return_value = _sample_node()
        mock_storage.traverse_with_depth.return_value = []

        response = client.get("/impact/function:src/app.py:main?include_tests=true")
        assert response.status_code == 200
        mock_storage.traverse_with_depth.assert_called_once_with(
            "function:src/app.py:main", 3, direction="callers", product_only=False
        )


class TestEventsEndpoint:
    def test_events_endpoint_exists(self, client: TestClient) -> None:
        # SSE endpoints return a streaming response. With no event_queue
        # (non-watch mode), the generator exits immediately.
        response = client.get("/events")
        # sse-starlette returns 200 for SSE responses
        assert response.status_code == 200
