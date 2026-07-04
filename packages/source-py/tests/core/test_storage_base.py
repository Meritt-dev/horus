from __future__ import annotations

from horus_source.core.storage.base import NodeEmbedding, SearchResult, StorageBackend

# SearchResult

class TestSearchResult:
    def test_creation_with_defaults(self) -> None:
        result = SearchResult(node_id="n1", score=0.95)
        assert result.node_id == "n1"
        assert result.score == 0.95
        assert result.node_name == ""
        assert result.file_path == ""
        assert result.label == ""
        assert result.snippet == ""

    def test_creation_with_all_fields(self) -> None:
        result = SearchResult(
            node_id="function:app.py:main",
            score=0.87,
            node_name="main",
            file_path="app.py",
            label="function",
            snippet="def main() -> None: ...",
        )
        assert result.node_id == "function:app.py:main"
        assert result.score == 0.87
        assert result.node_name == "main"
        assert result.file_path == "app.py"
        assert result.label == "function"
        assert result.snippet == "def main() -> None: ..."

# NodeEmbedding

class TestNodeEmbedding:
    def test_creation_with_defaults(self) -> None:
        emb = NodeEmbedding(node_id="n1")
        assert emb.node_id == "n1"
        assert emb.embedding == []

    def test_creation_with_data(self) -> None:
        vec = [0.1] * 384
        emb = NodeEmbedding(node_id="n2", embedding=vec)
        assert emb.node_id == "n2"
        assert emb.embedding == [0.1] * 384

    def test_embedding_default_is_independent(self) -> None:
        a = NodeEmbedding(node_id="a")
        b = NodeEmbedding(node_id="b")
        a.embedding.append(1.0)
        assert b.embedding == []

# StorageBackend protocol

class TestStorageBackend:
    def test_is_a_type(self) -> None:
        assert isinstance(StorageBackend, type)

    def test_runtime_checkable(self) -> None:
        class _DummyBackend:
            def initialize(self, path):
                pass

            def close(self):
                pass

            def add_nodes(self, nodes):
                pass

            def add_relationships(self, rels):
                pass

            def remove_nodes_by_file(self, file_path):
                return 0

            def get_inbound_cross_file_edges(self, file_path, exclude_source_files=None):
                return []

            def get_node(self, node_id):
                return None

            def get_callers(self, node_id):
                return []

            def get_callees(self, node_id):
                return []

            def get_type_refs(self, node_id):
                return []

            def get_callers_with_confidence(self, node_id):
                return []

            def get_callees_with_confidence(self, node_id):
                return []

            def traverse(self, start_id, depth):
                return []

            def traverse_with_depth(self, start_id, depth, direction="callers"):
                return []

            def get_process_memberships(self, node_ids):
                return {}

            def execute_raw(self, query):
                return None

            def exact_name_search(self, name, limit=5):
                return []

            def fts_search(self, query, limit):
                return []

            def fuzzy_search(self, query, limit, max_distance=2):
                return []

            def store_embeddings(self, embeddings):
                pass

            def vector_search(self, vector, limit):
                return []

            def get_indexed_files(self):
                return {}

            def bulk_load(self, graph):
                pass

            def load_graph(self):
                return None

            def delete_synthetic_nodes(self):
                pass

            def get_file_index(self):
                return {}

            def get_symbol_name_index(self):
                return {}

            def upsert_embeddings(self, embeddings):
                pass

            def update_dead_flags(self, dead_ids, alive_ids):
                pass

            def remove_relationships_by_type(self, rel_type):
                pass

            def rebuild_fts_indexes(self):
                pass

            def count_nodes_by_label(self):
                return {}

            def count_edges_by_type(self):
                return {}

            def get_dead_code_symbols(self):
                return []

            def get_coupling_pairs(self):
                return []

            def get_coupling_strengths(self):
                return []

            def get_communities_with_members(self):
                return []

            def count_communities(self):
                return 0

            def avg_calls_confidence(self):
                return None

            def count_symbols_and_dead(self):
                return (0, 0)

            def count_embeddings(self):
                return 0

            def get_embedded_node_ids(self):
                return set()

            def count_callables_in_processes(self):
                return (0, 0)

            def get_file_nodes(self):
                return []

            def get_symbol_counts_by_file(self):
                return {}

            def get_processes_with_steps(self):
                return []

            def get_symbols_in_file(self, file_path):
                return []

            def get_file_imports(self, file_path):
                return []

            def get_file_importers(self, file_path):
                return []

            def get_file_coupling(self, file_path):
                return []

            def get_heritage(self, node_id):
                return []

            def get_node_communities(self, node_id):
                return []

            def get_node_processes(self, node_id):
                return []

            def get_community_members(self, name):
                return []

            def get_communities_summary(self):
                return []

            def get_cross_community_processes(self):
                return []

            def get_file_community_counts(self, file_path):
                return []

            def content_contains_any(self, tokens, limit):
                return []

            def files_containing(self, tokens, per_token_limit):
                return {}

            def name_contains_search(self, token, limit=20):
                return []

            def flows_for_symbol(self, node_id):
                return {"processes": [], "steps": []}

            def symbols_by_label(self, labels, limit):
                return []

        assert isinstance(_DummyBackend(), StorageBackend)

    def test_non_conforming_class_fails(self) -> None:
        class _Incomplete:
            pass

        assert not isinstance(_Incomplete(), StorageBackend)
