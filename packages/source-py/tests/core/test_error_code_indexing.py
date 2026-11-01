"""Tests for error/log-code indexing (HOR-329).

Error-code constants such as ``E_FULFILLMENT_SYNC_ERROR_04`` are not their own
graph nodes — they live inside a function body. These tests prove that a
function which references such a code becomes findable by that code: the code
is extracted from the body and folded, intact, into the symbol's searchable
text (the text used for the embedding/keyword index).
"""

from __future__ import annotations

from horus_source.core.embeddings.text import (
    _MAX_ERROR_CODES,
    _extract_error_codes,
    generate_text,
)
from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import GraphNode, NodeLabel, generate_id


def _function(name: str, content: str, file_path: str = "src/order.service.ts") -> GraphNode:
    return GraphNode(
        id=generate_id(NodeLabel.FUNCTION, file_path, name),
        label=NodeLabel.FUNCTION,
        name=name,
        file_path=file_path,
        content=content,
    )


class TestExtractErrorCodes:
    def test_captures_member_off_logs_carrier(self) -> None:
        codes = _extract_error_codes(
            "this.logger.error(Logs.E_FULFILLMENT_SYNC_ERROR_04, { orderId });"
        )
        assert "E_FULFILLMENT_SYNC_ERROR_04" in codes

    def test_captures_bare_upper_snake_constant(self) -> None:
        codes = _extract_error_codes("throw new AppError(E_FULFILLMENT_SYNC_ERROR_04);")
        assert "E_FULFILLMENT_SYNC_ERROR_04" in codes

    def test_captures_errors_and_codes_carriers(self) -> None:
        codes = _extract_error_codes(
            "if (bad) return reject(Errors.NOT_FOUND); else throw Codes.SyncFailed;"
        )
        assert "NOT_FOUND" in codes
        assert "SyncFailed" in codes

    def test_ignores_plain_allcaps_and_common_words(self) -> None:
        # URL/API/OK/JSON are short ALLCAPS with no underscore/digit structure —
        # they are not error codes and must not be folded in.
        codes = _extract_error_codes(
            "const URL = API + OK; return JSON.stringify(payload);"
        )
        assert codes == []

    def test_ignores_normal_identifiers(self) -> None:
        codes = _extract_error_codes(
            "const orderId = order.id; await this.fulfillmentService.sync(orderId);"
        )
        assert codes == []

    def test_dedupes_and_preserves_first_seen_order(self) -> None:
        codes = _extract_error_codes(
            "log(Logs.E_FOO_01); log(BAR_BAZ_99); log(Logs.E_FOO_01);"
        )
        assert codes == ["E_FOO_01", "BAR_BAZ_99"]

    def test_caps_number_of_codes_per_function(self) -> None:
        body = " ".join(f"throw new Error(CODE_{i}_X);" for i in range(50))
        codes = _extract_error_codes(body)
        assert len(codes) == _MAX_ERROR_CODES

    def test_empty_or_none_content(self) -> None:
        assert _extract_error_codes("") == []
        assert _extract_error_codes(None) == []


class TestErrorCodeFoldedIntoSearchText:
    def test_raising_function_findable_by_error_code(self) -> None:
        """The core HOR-329 guarantee: a function that references E_SOME_CODE
        carries that code, intact, in its searchable text — so a search for the
        code ranks this function."""
        graph = KnowledgeGraph()
        fn = _function(
            "checkBrandOrderFulfillment",
            content=(
                "async checkBrandOrderFulfillment(orderId: string) {\n"
                "  const order = await this.orderRepo.find(orderId);\n"
                "  if (!order.fulfilled) {\n"
                "    this.logger.error(Logs.E_FULFILLMENT_SYNC_ERROR_04, { orderId });\n"
                "    throw new FulfillmentError(Logs.E_FULFILLMENT_SYNC_ERROR_04);\n"
                "  }\n"
                "}"
            ),
        )
        graph.add_node(fn)

        text = generate_text(fn, graph)

        # The function header is there...
        assert "function checkBrandOrderFulfillment" in text
        # ...and crucially the intact error code is in the searchable text.
        assert "E_FULFILLMENT_SYNC_ERROR_04" in text
        assert "error codes:" in text

    def test_function_without_error_code_has_no_codes_section(self) -> None:
        graph = KnowledgeGraph()
        fn = _function(
            "addTwoNumbers",
            content="function addTwoNumbers(a, b) { return a + b; }",
        )
        graph.add_node(fn)

        text = generate_text(fn, graph)

        assert "function addTwoNumbers" in text
        assert "error codes:" not in text

    def test_method_node_also_folds_error_codes(self) -> None:
        graph = KnowledgeGraph()
        method = GraphNode(
            id=generate_id(NodeLabel.METHOD, "src/order.service.ts", "OrderService.sync"),
            label=NodeLabel.METHOD,
            name="sync",
            class_name="OrderService",
            file_path="src/order.service.ts",
            content="sync() { throw new Error(Errors.E_SYNC_FAILED_07); }",
        )
        graph.add_node(method)

        text = generate_text(method, graph)

        assert "E_SYNC_FAILED_07" in text
        assert "error codes:" in text
