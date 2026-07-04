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
from horus_source.core.ingestion.calls import (
    _CALL_BLOCKLIST,
    process_calls,
    resolve_call,
)
from horus_source.core.ingestion.parser_phase import FileParseData
from horus_source.core.ingestion.symbol_lookup import build_name_index
from horus_source.core.parsers.base import CallInfo, ParseResult

_CALLABLE_LABELS = (NodeLabel.FUNCTION, NodeLabel.METHOD, NodeLabel.CLASS)

def _add_file_node(graph: KnowledgeGraph, path: str) -> str:
    """Add a File node and return its ID."""
    node_id = generate_id(NodeLabel.FILE, path)
    graph.add_node(
        GraphNode(
            id=node_id,
            label=NodeLabel.FILE,
            name=path.rsplit("/", 1)[-1],
            file_path=path,
        )
    )
    return node_id

def _add_symbol_node(
    graph: KnowledgeGraph,
    label: NodeLabel,
    file_path: str,
    name: str,
    start_line: int,
    end_line: int,
    class_name: str = "",
) -> str:
    """Add a symbol node with a DEFINES relationship from the file node."""
    symbol_name = (
        f"{class_name}.{name}" if label == NodeLabel.METHOD and class_name else name
    )
    node_id = generate_id(label, file_path, symbol_name)
    graph.add_node(
        GraphNode(
            id=node_id,
            label=label,
            name=name,
            file_path=file_path,
            start_line=start_line,
            end_line=end_line,
            class_name=class_name,
        )
    )
    file_id = generate_id(NodeLabel.FILE, file_path)
    graph.add_relationship(
        GraphRelationship(
            id=f"defines:{file_id}->{node_id}",
            type=RelType.DEFINES,
            source=file_id,
            target=node_id,
        )
    )
    return node_id

@pytest.fixture()
def graph() -> KnowledgeGraph:
    """Build a graph matching the test fixture specification.

    File: src/auth.py
        Function: validate (lines 1-10)
        Function: hash_password (lines 12-20)

    File: src/app.py
        Function: login (lines 1-15)

    File: src/utils.py
        Function: helper (lines 1-5)
    """
    g = KnowledgeGraph()

    # Files
    _add_file_node(g, "src/auth.py")
    _add_file_node(g, "src/app.py")
    _add_file_node(g, "src/utils.py")

    # Symbols in src/auth.py
    _add_symbol_node(g, NodeLabel.FUNCTION, "src/auth.py", "validate", 1, 10)
    _add_symbol_node(g, NodeLabel.FUNCTION, "src/auth.py", "hash_password", 12, 20)

    # Symbols in src/app.py
    _add_symbol_node(g, NodeLabel.FUNCTION, "src/app.py", "login", 1, 15)

    # Symbols in src/utils.py
    _add_symbol_node(g, NodeLabel.FUNCTION, "src/utils.py", "helper", 1, 5)

    return g

@pytest.fixture()
def parse_data() -> list[FileParseData]:
    """Parse data with calls matching the fixture specification.

    src/auth.py: hash_password() at line 5 (inside validate)
    src/app.py: validate() at line 8 (inside login)
    """
    return [
        FileParseData(
            file_path="src/auth.py",
            language="python",
            parse_result=ParseResult(
                calls=[CallInfo(name="hash_password", line=5)],
            ),
        ),
        FileParseData(
            file_path="src/app.py",
            language="python",
            parse_result=ParseResult(
                calls=[CallInfo(name="validate", line=8)],
            ),
        ),
    ]
class TestBuildCallIndex:
    def test_build_call_index(self, graph: KnowledgeGraph) -> None:
        index = build_name_index(graph, _CALLABLE_LABELS)

        # All four functions should appear.
        assert "validate" in index
        assert "hash_password" in index
        assert "login" in index
        assert "helper" in index

        # Each name maps to exactly one node ID.
        assert len(index["validate"]) == 1
        assert len(index["hash_password"]) == 1

        # IDs match expected generate_id output.
        expected_validate = generate_id(
            NodeLabel.FUNCTION, "src/auth.py", "validate"
        )
        assert index["validate"] == [expected_validate]

    def test_build_call_index_includes_classes(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/models.py")
        _add_symbol_node(g, NodeLabel.CLASS, "src/models.py", "User", 1, 20)

        index = build_name_index(g, _CALLABLE_LABELS)
        assert "User" in index
        assert len(index["User"]) == 1

    def test_build_call_index_multiple_same_name(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/a.py")
        _add_file_node(g, "src/b.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/a.py", "init", 1, 5)
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/b.py", "init", 1, 5)

        index = build_name_index(g, _CALLABLE_LABELS)
        assert "init" in index
        assert len(index["init"]) == 2
class TestResolveCallSameFile:
    def test_resolve_call_same_file(self, graph: KnowledgeGraph) -> None:
        index = build_name_index(graph, _CALLABLE_LABELS)
        call = CallInfo(name="hash_password", line=5)

        target_id, confidence = resolve_call(
            call, "src/auth.py", index, graph
        )

        expected_id = generate_id(
            NodeLabel.FUNCTION, "src/auth.py", "hash_password"
        )
        assert target_id == expected_id
        assert confidence == 1.0
class TestResolveCallGlobal:
    def test_resolve_call_global(self, graph: KnowledgeGraph) -> None:
        index = build_name_index(graph, _CALLABLE_LABELS)
        call = CallInfo(name="validate", line=8)

        target_id, confidence = resolve_call(
            call, "src/app.py", index, graph
        )

        expected_id = generate_id(
            NodeLabel.FUNCTION, "src/auth.py", "validate"
        )
        assert target_id == expected_id
        assert confidence == 0.5
class TestResolveCallUnresolved:
    def test_resolve_call_unresolved(self, graph: KnowledgeGraph) -> None:
        index = build_name_index(graph, _CALLABLE_LABELS)
        call = CallInfo(name="nonexistent_function", line=3)

        target_id, confidence = resolve_call(
            call, "src/auth.py", index, graph
        )

        assert target_id is None
        assert confidence == 0.0
class TestProcessCallsCreatesRelationships:
    def test_process_calls_creates_relationships(
        self,
        graph: KnowledgeGraph,
        parse_data: list[FileParseData],
    ) -> None:
        process_calls(parse_data, graph)

        calls_rels = graph.get_relationships_by_type(RelType.CALLS)
        assert len(calls_rels) == 2

        # Collect source->target pairs.
        pairs = {(r.source, r.target) for r in calls_rels}

        validate_id = generate_id(
            NodeLabel.FUNCTION, "src/auth.py", "validate"
        )
        hash_pw_id = generate_id(
            NodeLabel.FUNCTION, "src/auth.py", "hash_password"
        )
        login_id = generate_id(NodeLabel.FUNCTION, "src/app.py", "login")

        # validate -> hash_password (same-file call at line 5 inside validate)
        assert (validate_id, hash_pw_id) in pairs
        # login -> validate (cross-file call at line 8 inside login)
        assert (login_id, validate_id) in pairs
class TestProcessCallsConfidence:
    def test_process_calls_confidence(
        self,
        graph: KnowledgeGraph,
        parse_data: list[FileParseData],
    ) -> None:
        process_calls(parse_data, graph)

        calls_rels = graph.get_relationships_by_type(RelType.CALLS)

        validate_id = generate_id(
            NodeLabel.FUNCTION, "src/auth.py", "validate"
        )
        hash_pw_id = generate_id(
            NodeLabel.FUNCTION, "src/auth.py", "hash_password"
        )
        login_id = generate_id(NodeLabel.FUNCTION, "src/app.py", "login")

        confidences = {(r.source, r.target): r.properties["confidence"] for r in calls_rels}

        # Same-file call: confidence 1.0
        assert confidences[(validate_id, hash_pw_id)] == 1.0
        # Cross-file global match: confidence 0.5
        assert confidences[(login_id, validate_id)] == 0.5
class TestProcessCallsNoDuplicates:
    def test_process_calls_no_duplicates(
        self, graph: KnowledgeGraph
    ) -> None:
        # Two identical calls to hash_password inside validate.
        duplicate_parse_data = [
            FileParseData(
                file_path="src/auth.py",
                language="python",
                parse_result=ParseResult(
                    calls=[
                        CallInfo(name="hash_password", line=5),
                        CallInfo(name="hash_password", line=7),
                    ],
                ),
            ),
        ]

        process_calls(duplicate_parse_data, graph)

        calls_rels = graph.get_relationships_by_type(RelType.CALLS)
        # Both calls resolve to validate -> hash_password, but only one
        # relationship should exist.
        assert len(calls_rels) == 1
class TestResolveMethodCallSelf:
    def test_resolve_method_call_self(self) -> None:
        g = KnowledgeGraph()

        _add_file_node(g, "src/service.py")
        _add_symbol_node(
            g,
            NodeLabel.CLASS,
            "src/service.py",
            "AuthService",
            1,
            30,
        )
        _add_symbol_node(
            g,
            NodeLabel.METHOD,
            "src/service.py",
            "login",
            3,
            15,
            class_name="AuthService",
        )
        _add_symbol_node(
            g,
            NodeLabel.METHOD,
            "src/service.py",
            "check_token",
            17,
            28,
            class_name="AuthService",
        )

        index = build_name_index(g, _CALLABLE_LABELS)
        call = CallInfo(name="check_token", line=10, receiver="self")

        target_id, confidence = resolve_call(
            call, "src/service.py", index, g
        )

        expected_id = generate_id(
            NodeLabel.METHOD, "src/service.py", "AuthService.check_token"
        )
        assert target_id == expected_id
        assert confidence == 1.0

    def test_resolve_method_call_this(self) -> None:
        g = KnowledgeGraph()

        _add_file_node(g, "src/service.ts")
        _add_symbol_node(
            g,
            NodeLabel.CLASS,
            "src/service.ts",
            "AuthService",
            1,
            30,
        )
        _add_symbol_node(
            g,
            NodeLabel.METHOD,
            "src/service.ts",
            "checkToken",
            17,
            28,
            class_name="AuthService",
        )

        index = build_name_index(g, _CALLABLE_LABELS)
        call = CallInfo(name="checkToken", line=10, receiver="this")

        target_id, confidence = resolve_call(
            call, "src/service.ts", index, g
        )

        expected_id = generate_id(
            NodeLabel.METHOD, "src/service.ts", "AuthService.checkToken"
        )
        assert target_id == expected_id
        assert confidence == 1.0
class TestResolveCallImportResolved:
    def test_resolve_call_import_resolved(self) -> None:
        g = KnowledgeGraph()

        # Two files: app.py imports validate from auth.py.
        _add_file_node(g, "src/auth.py")
        _add_file_node(g, "src/app.py")

        _add_symbol_node(
            g, NodeLabel.FUNCTION, "src/auth.py", "validate", 1, 10
        )
        _add_symbol_node(
            g, NodeLabel.FUNCTION, "src/app.py", "login", 1, 15
        )

        # IMPORTS relationship: app.py -> auth.py with symbol "validate"
        app_file_id = generate_id(NodeLabel.FILE, "src/app.py")
        auth_file_id = generate_id(NodeLabel.FILE, "src/auth.py")
        g.add_relationship(
            GraphRelationship(
                id=f"imports:{app_file_id}->{auth_file_id}",
                type=RelType.IMPORTS,
                source=app_file_id,
                target=auth_file_id,
                properties={"symbols": "validate"},
            )
        )

        index = build_name_index(g, _CALLABLE_LABELS)
        call = CallInfo(name="validate", line=8)

        target_id, confidence = resolve_call(
            call, "src/app.py", index, g
        )

        expected_id = generate_id(
            NodeLabel.FUNCTION, "src/auth.py", "validate"
        )
        assert target_id == expected_id
        assert confidence == 1.0
class TestCallBlocklist:
    def test_blocklist_is_frozenset(self) -> None:
        assert isinstance(_CALL_BLOCKLIST, frozenset)

    def test_python_builtins_in_blocklist(self) -> None:
        for name in ("print", "len", "range", "isinstance", "super"):
            assert name in _CALL_BLOCKLIST

    def test_js_globals_in_blocklist(self) -> None:
        for name in ("console", "setTimeout", "fetch", "JSON", "Promise"):
            assert name in _CALL_BLOCKLIST

    def test_react_hooks_in_blocklist(self) -> None:
        for name in ("useState", "useEffect", "useCallback", "useMemo"):
            assert name in _CALL_BLOCKLIST

    def test_blocklisted_call_creates_no_edge(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/main.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/main.py", "do_work", 1, 10)

        parse_data = [
            FileParseData(
                file_path="src/main.py",
                language="python",
                parse_result=ParseResult(
                    calls=[CallInfo(name="print", line=5)],
                ),
            ),
        ]

        process_calls(parse_data, g)
        calls_rels = g.get_relationships_by_type(RelType.CALLS)
        assert len(calls_rels) == 0

    def test_blocklisted_argument_creates_no_edge(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/main.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/main.py", "do_work", 1, 10)

        parse_data = [
            FileParseData(
                file_path="src/main.py",
                language="python",
                parse_result=ParseResult(
                    calls=[
                        CallInfo(name="apply_func", line=5, arguments=["str"]),
                    ],
                ),
            ),
        ]

        process_calls(parse_data, g)
        calls_rels = g.get_relationships_by_type(RelType.CALLS)
        # apply_func is not in the graph so no edge for it; 'str' is blocklisted.
        assert len(calls_rels) == 0

    def test_blocklisted_name_kept_when_defined_same_file(self) -> None:
        # B3.3: `format` is in the blocklist (Python's str.format) but a JS file
        # that DEFINES a local `function format(){}` and calls it same-file must
        # get a real CALL edge — otherwise prettier's format.js reads isDead:true,
        # a dead-code verdict a user could act on by deleting live code.
        g = KnowledgeGraph()
        _add_file_node(g, "src/format.js")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/format.js", "printDoc", 1, 10)
        format_id = _add_symbol_node(
            g, NodeLabel.FUNCTION, "src/format.js", "format", 12, 40
        )

        parse_data = [
            FileParseData(
                file_path="src/format.js",
                language="javascript",
                # printDoc() at line 5 calls the same-file format() helper.
                parse_result=ParseResult(
                    calls=[CallInfo(name="format", line=5)],
                ),
            ),
        ]

        process_calls(parse_data, g)
        targets = {r.target for r in g.get_relationships_by_type(RelType.CALLS)}
        assert format_id in targets

    def test_blocklisted_name_kept_when_imported(self) -> None:
        # A blocklisted name (`send`) imported from another file resolves to the
        # imported definition and keeps its edge (import-resolved, confidence 1.0).
        g = KnowledgeGraph()
        _add_file_node(g, "src/mailer.js")
        send_id = _add_symbol_node(g, NodeLabel.FUNCTION, "src/mailer.js", "send", 1, 10)
        _add_file_node(g, "src/app.js")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/app.js", "notify", 1, 20)

        app_file_id = generate_id(NodeLabel.FILE, "src/app.js")
        mailer_file_id = generate_id(NodeLabel.FILE, "src/mailer.js")
        g.add_relationship(
            GraphRelationship(
                id=f"imports:{app_file_id}->{mailer_file_id}",
                type=RelType.IMPORTS,
                source=app_file_id,
                target=mailer_file_id,
                properties={"symbols": "send"},
            )
        )

        parse_data = [
            FileParseData(
                file_path="src/app.js",
                language="javascript",
                parse_result=ParseResult(calls=[CallInfo(name="send", line=5)]),
            ),
        ]

        process_calls(parse_data, g)
        rels = g.get_relationships_by_type(RelType.CALLS)
        confidences = {r.target: r.properties.get("confidence") for r in rels}
        assert send_id in confidences
        assert confidences[send_id] == 1.0

    def test_unresolved_blocklisted_name_stays_blocklisted(self) -> None:
        # A bare `format()` with NO same-file / imported definition — only a
        # cross-file homonym — stays blocklisted (no false global-fuzzy edge).
        g = KnowledgeGraph()
        _add_file_node(g, "src/other.js")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/other.js", "format", 1, 10)
        _add_file_node(g, "src/app.js")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/app.js", "render", 1, 20)

        parse_data = [
            FileParseData(
                file_path="src/app.js",
                language="javascript",
                parse_result=ParseResult(calls=[CallInfo(name="format", line=5)]),
            ),
        ]

        process_calls(parse_data, g)
        assert len(g.get_relationships_by_type(RelType.CALLS)) == 0

    def test_python_str_format_method_call_still_dropped(self) -> None:
        # A Python `.py` caller of `x.format()` (str.format) has no same-file /
        # imported `format` definition, so it stays blocklisted — the original
        # reason `format` is in the blocklist is preserved.
        g = KnowledgeGraph()
        _add_file_node(g, "src/report.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/report.py", "build", 1, 20)

        parse_data = [
            FileParseData(
                file_path="src/report.py",
                language="python",
                parse_result=ParseResult(
                    calls=[CallInfo(name="format", line=5, receiver="template")],
                ),
            ),
        ]

        process_calls(parse_data, g)
        assert len(g.get_relationships_by_type(RelType.CALLS)) == 0

    def test_non_blocklisted_call_still_resolves(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/main.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/main.py", "caller", 1, 10)
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/main.py", "my_helper", 12, 20)

        parse_data = [
            FileParseData(
                file_path="src/main.py",
                language="python",
                parse_result=ParseResult(
                    calls=[CallInfo(name="my_helper", line=5)],
                ),
            ),
        ]

        process_calls(parse_data, g)
        calls_rels = g.get_relationships_by_type(RelType.CALLS)
        assert len(calls_rels) == 1


def _add_class_with_di(
    graph: KnowledgeGraph,
    file_path: str,
    name: str,
    start_line: int,
    end_line: int,
    di_fields: dict[str, str],
) -> str:
    """Add a CLASS node carrying a ``di_fields`` properties map."""
    node_id = generate_id(NodeLabel.CLASS, file_path, name)
    graph.add_node(
        GraphNode(
            id=node_id,
            label=NodeLabel.CLASS,
            name=name,
            file_path=file_path,
            start_line=start_line,
            end_line=end_line,
            properties={"di_fields": di_fields},
        )
    )
    file_id = generate_id(NodeLabel.FILE, file_path)
    graph.add_relationship(
        GraphRelationship(
            id=f"defines:{file_id}->{node_id}",
            type=RelType.DEFINES,
            source=file_id,
            target=node_id,
        )
    )
    return node_id


class TestResolveDiMemberCall:
    """``this.<injectedField>.<method>()`` resolves to the concrete service method.

    Mirrors the canonical NestJS shape: a controller/resolver method calling an
    injected service whose constructor parameter-property declared its type.
    """

    def _build_graph(self) -> KnowledgeGraph:
        g = KnowledgeGraph()

        # The injected service and its method, in a separate file.
        _add_file_node(g, "src/x.service.ts")
        _add_symbol_node(
            g, NodeLabel.CLASS, "src/x.service.ts", "XService", 1, 20
        )
        _add_symbol_node(
            g,
            NodeLabel.METHOD,
            "src/x.service.ts",
            "doWork",
            5,
            10,
            class_name="XService",
        )

        # The consumer class with a DI field ``x: XService`` and a method calling it.
        _add_file_node(g, "src/consumer.ts")
        _add_class_with_di(
            g, "src/consumer.ts", "Consumer", 1, 20, {"x": "XService"}
        )
        _add_symbol_node(
            g,
            NodeLabel.METHOD,
            "src/consumer.ts",
            "handle",
            3,
            12,
            class_name="Consumer",
        )
        return g

    def test_di_member_call_reaches_concrete_method(self) -> None:
        g = self._build_graph()

        parse_data = [
            FileParseData(
                file_path="src/consumer.ts",
                language="typescript",
                parse_result=ParseResult(
                    # this.x.doWork() inside Consumer.handle (lines 3-12)
                    calls=[CallInfo(name="doWork", line=6, receiver="this.x")],
                ),
            ),
        ]

        process_calls(parse_data, g)

        handle_id = generate_id(
            NodeLabel.METHOD, "src/consumer.ts", "Consumer.handle"
        )
        dowork_id = generate_id(
            NodeLabel.METHOD, "src/x.service.ts", "XService.doWork"
        )
        pairs = {
            (r.source, r.target): r.properties.get("confidence")
            for r in g.get_relationships_by_type(RelType.CALLS)
        }
        assert (handle_id, dowork_id) in pairs
        assert pairs[(handle_id, dowork_id)] == 0.8

    def test_di_member_call_chained_receiver(self) -> None:
        # this.x.user.doWork() — intermediate ``.user`` is ignored; first field wins.
        g = self._build_graph()

        parse_data = [
            FileParseData(
                file_path="src/consumer.ts",
                language="typescript",
                parse_result=ParseResult(
                    calls=[CallInfo(name="doWork", line=6, receiver="this.x.user")],
                ),
            ),
        ]

        process_calls(parse_data, g)

        handle_id = generate_id(
            NodeLabel.METHOD, "src/consumer.ts", "Consumer.handle"
        )
        dowork_id = generate_id(
            NodeLabel.METHOD, "src/x.service.ts", "XService.doWork"
        )
        pairs = {
            (r.source, r.target) for r in g.get_relationships_by_type(RelType.CALLS)
        }
        assert (handle_id, dowork_id) in pairs

    def test_unknown_di_field_creates_no_di_edge(self) -> None:
        # Receiver field not in di_fields → the DI path does not fire, so any
        # edge that exists comes from the pre-existing global-fuzzy fallback
        # (confidence 0.5), never the 0.8 DI path.
        g = self._build_graph()

        parse_data = [
            FileParseData(
                file_path="src/consumer.ts",
                language="typescript",
                parse_result=ParseResult(
                    calls=[CallInfo(name="doWork", line=6, receiver="this.unknown")],
                ),
            ),
        ]

        process_calls(parse_data, g)

        handle_id = generate_id(
            NodeLabel.METHOD, "src/consumer.ts", "Consumer.handle"
        )
        dowork_id = generate_id(
            NodeLabel.METHOD, "src/x.service.ts", "XService.doWork"
        )
        confidences = {
            (r.source, r.target): r.properties.get("confidence")
            for r in g.get_relationships_by_type(RelType.CALLS)
        }
        # No 0.8 DI edge — the unknown field has no DI mapping.
        assert confidences.get((handle_id, dowork_id)) != 0.8


def test_shadowed_receiver_param_does_not_link_to_module_const() -> None:
    """dogfood M04: a `client.query()` call where `client` is a LOCAL parameter must NOT
    create a CALLS edge to a same-named module-level const in another file. That bare-receiver
    link only ever resolved via the global-fuzzy fallback (0.5), which is almost always a
    shadowed local — the real method call is resolved separately."""
    g = KnowledgeGraph()
    # A module-level `client` const (arrow fn) in s3Client.ts — NOT imported by the caller.
    _add_file_node(g, "src/lib/s3Client.ts")
    client_id = _add_symbol_node(
        g, NodeLabel.FUNCTION, "src/lib/s3Client.ts", "client", 5, 8
    )
    # The caller: a method that calls `client.query(...)` on a LOCAL param named `client`.
    _add_file_node(g, "src/services/product.service.ts")
    _add_symbol_node(
        g,
        NodeLabel.METHOD,
        "src/services/product.service.ts",
        "publish",
        10,
        40,
        class_name="ProductService",
    )
    parse_data = [
        FileParseData(
            file_path="src/services/product.service.ts",
            language="typescript",
            parse_result=ParseResult(
                calls=[CallInfo(name="query", line=20, receiver="client")],
            ),
        ),
    ]
    process_calls(parse_data, g)
    targets = {r.target for r in g.get_relationships_by_type(RelType.CALLS)}
    assert client_id not in targets


class TestAmbiguousSameFileDispatch:
    """Dogfood cycle-3: a file with several same-named methods on DIFFERENT classes
    (serde's SeqDeserializer.end / MapDeserializer.end) resolved every `x.end()` to
    the FIRST candidate — the siblings never got an edge and were flagged dead."""

    def test_siblings_receive_low_confidence_edges(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/de.rs")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/de.rs", "visit_seq", 1, 10)
        seq_end = _add_symbol_node(
            g, NodeLabel.METHOD, "src/de.rs", "end", 20, 30, class_name="SeqDeserializer"
        )
        map_end = _add_symbol_node(
            g, NodeLabel.METHOD, "src/de.rs", "end", 40, 50, class_name="MapDeserializer"
        )

        parse_data = [
            FileParseData(
                file_path="src/de.rs",
                language="rust",
                parse_result=ParseResult(
                    calls=[CallInfo(name="end", line=5, receiver="seq_visitor")],
                ),
            ),
        ]
        process_calls(parse_data, g)
        rels = g.get_relationships_by_type(RelType.CALLS)
        targets = {r.target: r.properties.get("confidence") for r in rels}
        # BOTH same-file candidates are referenced; the primary at 1.0, the
        # ambiguous sibling at low confidence.
        assert seq_end in targets and map_end in targets
        assert 1.0 in targets.values()
        assert any(c is not None and c < 0.5 for c in targets.values())

    def test_no_sibling_edges_without_a_receiver(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/x.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/x.py", "caller", 1, 10)
        _add_symbol_node(g, NodeLabel.METHOD, "src/x.py", "run", 20, 30, class_name="A")
        _add_symbol_node(g, NodeLabel.METHOD, "src/x.py", "run", 40, 50, class_name="B")

        parse_data = [
            FileParseData(
                file_path="src/x.py",
                language="python",
                parse_result=ParseResult(calls=[CallInfo(name="run", line=5)]),
            ),
        ]
        process_calls(parse_data, g)
        rels = g.get_relationships_by_type(RelType.CALLS)
        # Bare-name call (no receiver): primary resolution only, no fan-out.
        assert len(rels) == 1


class TestCommonNameFuzzyHardening:
    """Global fuzzy resolution (0.5) is name-only guesswork — refused for
    method-ish / short / ubiquitous / many-file / cross-language names.
    Dogfood: `horus explain run` linked the TS CLI's `run` to Python
    source-host internals through a bare global name match."""

    def test_dot_then_does_not_cross_link_without_imports(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/promises.ts")
        then_id = _add_symbol_node(g, NodeLabel.FUNCTION, "src/promises.ts", "then", 1, 10)
        _add_file_node(g, "src/api.ts")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/api.ts", "fetchUsers", 1, 20)

        parse_data = [
            FileParseData(
                file_path="src/api.ts",
                language="typescript",
                parse_result=ParseResult(
                    calls=[CallInfo(name="then", line=5, receiver="response")],
                ),
            ),
        ]
        process_calls(parse_data, g)
        targets = {r.target for r in g.get_relationships_by_type(RelType.CALLS)}
        assert then_id not in targets

    def test_dot_run_does_not_cross_language(self) -> None:
        # TS `program.run()` must not link to a Python `run` function.
        g = KnowledgeGraph()
        _add_file_node(g, "hostpy/runtime.py")
        run_id = _add_symbol_node(g, NodeLabel.FUNCTION, "hostpy/runtime.py", "run", 1, 30)
        _add_file_node(g, "cli/src/index.ts")
        _add_symbol_node(g, NodeLabel.FUNCTION, "cli/src/index.ts", "main", 1, 40)

        parse_data = [
            FileParseData(
                file_path="cli/src/index.ts",
                language="typescript",
                parse_result=ParseResult(
                    calls=[CallInfo(name="run", line=10, receiver="program")],
                ),
            ),
        ]
        process_calls(parse_data, g)
        targets = {r.target for r in g.get_relationships_by_type(RelType.CALLS)}
        assert run_id not in targets

    def test_bare_ubiquitous_name_is_not_fuzzy_resolved(self) -> None:
        # Even receiver-less: `handle(x)` must not link to another file's
        # `handle` without import evidence.
        g = KnowledgeGraph()
        _add_file_node(g, "src/other.py")
        handle_id = _add_symbol_node(g, NodeLabel.FUNCTION, "src/other.py", "handle", 1, 10)
        _add_file_node(g, "src/app.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/app.py", "loop", 1, 20)

        parse_data = [
            FileParseData(
                file_path="src/app.py",
                language="python",
                parse_result=ParseResult(calls=[CallInfo(name="handle", line=5)]),
            ),
        ]
        process_calls(parse_data, g)
        targets = {r.target for r in g.get_relationships_by_type(RelType.CALLS)}
        assert handle_id not in targets

    def test_ubiquitous_name_still_resolves_with_import_evidence(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/other.py")
        handle_id = _add_symbol_node(g, NodeLabel.FUNCTION, "src/other.py", "handle", 1, 10)
        _add_file_node(g, "src/app.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/app.py", "loop", 1, 20)

        app_file_id = generate_id(NodeLabel.FILE, "src/app.py")
        other_file_id = generate_id(NodeLabel.FILE, "src/other.py")
        g.add_relationship(
            GraphRelationship(
                id=f"imports:{app_file_id}->{other_file_id}",
                type=RelType.IMPORTS,
                source=app_file_id,
                target=other_file_id,
                properties={"symbols": "handle"},
            )
        )

        index = build_name_index(g, _CALLABLE_LABELS)
        target_id, confidence = resolve_call(
            CallInfo(name="handle", line=5), "src/app.py", index, g
        )
        assert target_id == handle_id
        assert confidence == 1.0

    def test_ubiquitous_name_still_resolves_same_file(self) -> None:
        g = KnowledgeGraph()
        _add_file_node(g, "src/app.py")
        handle_id = _add_symbol_node(g, NodeLabel.FUNCTION, "src/app.py", "handle", 12, 20)
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/app.py", "loop", 1, 10)

        index = build_name_index(g, _CALLABLE_LABELS)
        target_id, confidence = resolve_call(
            CallInfo(name="handle", line=5), "src/app.py", index, g
        )
        assert target_id == handle_id
        assert confidence == 1.0

    def test_name_defined_in_many_files_is_ambiguous(self) -> None:
        # A distinctive name defined in >3 distinct files is ambiguous by
        # construction — no fuzzy edge.
        g = KnowledgeGraph()
        for i in range(4):
            path = f"src/mod{i}.py"
            _add_file_node(g, path)
            _add_symbol_node(g, NodeLabel.FUNCTION, path, "serialize_payload", 1, 10)
        _add_file_node(g, "src/app.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/app.py", "caller_fn", 1, 20)

        index = build_name_index(g, _CALLABLE_LABELS)
        target_id, confidence = resolve_call(
            CallInfo(name="serialize_payload", line=5), "src/app.py", index, g
        )
        assert target_id is None
        assert confidence == 0.0

    def test_distinctive_same_language_name_still_fuzzy_resolves(self) -> None:
        # The pre-existing behaviour (TestResolveCallGlobal) survives the
        # guard: distinctive name, single defining file, same language.
        g = KnowledgeGraph()
        _add_file_node(g, "src/auth.py")
        validate_id = _add_symbol_node(g, NodeLabel.FUNCTION, "src/auth.py", "validate_token", 1, 10)
        _add_file_node(g, "src/app.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "src/app.py", "login", 1, 20)

        index = build_name_index(g, _CALLABLE_LABELS)
        target_id, confidence = resolve_call(
            CallInfo(name="validate_token", line=5), "src/app.py", index, g
        )
        assert target_id == validate_id
        assert confidence == 0.5

    def test_bare_distinctive_name_does_not_cross_language(self) -> None:
        # A distinctive TS symbol is NOT the target of a bare Python call.
        g = KnowledgeGraph()
        _add_file_node(g, "web/src/telemetry.ts")
        ts_id = _add_symbol_node(
            g, NodeLabel.FUNCTION, "web/src/telemetry.ts", "flush_spans", 1, 10
        )
        _add_file_node(g, "worker/tasks.py")
        _add_symbol_node(g, NodeLabel.FUNCTION, "worker/tasks.py", "drain", 1, 20)

        index = build_name_index(g, _CALLABLE_LABELS)
        target_id, confidence = resolve_call(
            CallInfo(name="flush_spans", line=5), "worker/tasks.py", index, g
        )
        assert target_id is None
        assert confidence == 0.0


def test_module_scope_reference_falls_back_to_file_source() -> None:
    """Dogfood cycle-4 (lodash): `Hash.prototype.get = hashGet` at anonymous-IIFE /
    module scope has no containing symbol — the reference was dropped and hashGet
    read as dead. The FILE node is the honest edge source."""
    g = KnowledgeGraph()
    file_id = _add_file_node(g, "lodash.js")
    target = _add_symbol_node(g, NodeLabel.FUNCTION, "lodash.js", "hashGet", 10, 20)

    parse_data = [
        FileParseData(
            file_path="lodash.js",
            language="javascript",
            # line 500 is outside every symbol's range — module scope.
            parse_result=ParseResult(calls=[CallInfo(name="hashGet", line=500)]),
        ),
    ]
    process_calls(parse_data, g)
    rels = g.get_relationships_by_type(RelType.CALLS)
    assert any(r.source == file_id and r.target == target for r in rels)
