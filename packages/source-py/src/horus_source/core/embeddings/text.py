"""Embedding text generation for graph nodes.

Converts a :class:`GraphNode` into a structured natural-language description
suitable for semantic embedding.  The description captures the node's identity,
signature, file location, and relevant graph context (callers, callees, type
references, class members, etc.).
"""

from __future__ import annotations

import re

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import GraphNode, NodeLabel, RelType

# nomic-embed-text-v1.5 supports 8192 tokens, but embedding quality degrades
# with very long inputs.  2048 tokens (~8192 chars at ~4 chars/token) is the
# sweet spot.
_MAX_TEXT_TOKENS = 2048

# Error/log code indexing (HOR-329)
# ---------------------------------
# Error-code constants such as ``E_FULFILLMENT_SYNC_ERROR_04`` are *not* their
# own graph nodes — they live inside a function body. A search for the bare
# identifier therefore never finds the function that raises/logs it: the FTS
# tokenizer shreds ``E_FULFILLMENT_SYNC_ERROR_04`` into ``e/fulfillment/sync/
# error/04`` and vector search has no intact token to latch onto. To make the
# raising function findable by its error code, we extract error-code-like
# identifiers from the function body and fold them — intact and verbatim — into
# the symbol's searchable text. The whole identifier then survives as a single
# token in the embedding input, ranking the raising function highly for a query
# of that code.

# An UPPER_SNAKE / E_*-style constant: starts with a letter, all caps + digits +
# underscores, at least 5 chars total (avoids matching short ALLCAPS like ``OK``,
# ``URL``, ``API``). Must contain a digit or an underscore so we don't sweep in
# plain ALLCAPS words (``ERROR``, ``TIMEOUT``) that aren't structured codes.
_ERROR_CODE_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")

# Members accessed off a code-carrier object, e.g. ``Logs.E_FOO_01``,
# ``Errors.NOT_FOUND``, ``Codes.SyncFailed``, ``ErrorCodes.BadInput``. The
# member name is captured even when it isn't UPPER_SNAKE, since carrier objects
# are an unambiguous signal that the member is an error/log code.
_CODE_CARRIER_RE = re.compile(
    r"\b(?:Logs?|Errors?|ErrorCodes?|Codes?|LogCodes?|ErrorCode|LogCode)"
    r"\.([A-Za-z_][A-Za-z0-9_]*)\b"
)

# Cap per function so a constants/enum file doesn't bloat one symbol's text and
# crowd out the rest of its description.
_MAX_ERROR_CODES = 12


def _extract_error_codes(content: str | None) -> list[str]:
    """Return distinct error/log-code identifiers referenced in *content*.

    Captures two conservative shapes:

    * structured UPPER_SNAKE / ``E_*``-style constants
      (``E_FULFILLMENT_SYNC_ERROR_04``, ``FOO_BAR_BAZ``); and
    * members accessed off a known code-carrier object
      (``Logs.E_FOO_01``, ``Errors.NOT_FOUND``, ``Codes.SyncFailed``).

    Order of first appearance is preserved and the result is capped at
    :data:`_MAX_ERROR_CODES` so unrelated symbols are not bloated.
    """
    if not content:
        return []

    seen: set[str] = set()
    ordered: list[str] = []

    def _add(code: str) -> bool:
        """Record *code*; return False once the cap is reached."""
        if code and code not in seen:
            seen.add(code)
            ordered.append(code)
        return len(ordered) < _MAX_ERROR_CODES

    for match in _CODE_CARRIER_RE.finditer(content):
        if not _add(match.group(1)):
            return ordered
    for match in _ERROR_CODE_RE.finditer(content):
        if not _add(match.group(0)):
            return ordered

    return ordered


def build_class_method_index(graph: KnowledgeGraph) -> dict[tuple[str, str], list[str]]:
    """Pre-build a mapping from (class_name, file_path) to sorted method names.

    Avoids O(classes × methods) scanning when generating text for each class.
    Keyed by (class_name, file_path) to avoid collisions between classes with
    the same name in different files.
    """
    index: dict[tuple[str, str], list[str]] = {}
    for method in graph.get_nodes_by_label(NodeLabel.METHOD):
        if method.class_name:
            key = (method.class_name, method.file_path)
            index.setdefault(key, []).append(method.name)
    for names in index.values():
        names.sort()
    return index

def generate_text(
    node: GraphNode,
    graph: KnowledgeGraph,
    class_method_index: dict[tuple[str, str], list[str]] | None = None,
) -> str:
    """Produce a natural-language description of *node* using graph context.

    The returned string is intended for use as input to an embedding model.
    It captures the node's identity, location, signature, and relationships
    to other nodes in *graph*.

    Args:
        node: The graph node to describe.
        graph: The knowledge graph that *node* belongs to.
        class_method_index: Optional pre-built class→method names index.
            When provided, avoids O(N) scans for class text generation.

    Returns:
        A multi-line text description of the node.
    """
    label = node.label

    if label in (NodeLabel.FUNCTION, NodeLabel.METHOD):
        text = _text_for_callable(node, graph)
    elif label == NodeLabel.CLASS:
        text = _text_for_class(node, graph, class_method_index)
    elif label == NodeLabel.FILE:
        text = _text_for_file(node, graph)
    elif label == NodeLabel.FOLDER:
        text = _text_for_folder(node, graph)
    elif label in (NodeLabel.INTERFACE, NodeLabel.TYPE_ALIAS, NodeLabel.ENUM):
        text = _text_for_type_definition(node, graph)
    elif label == NodeLabel.COMMUNITY:
        text = _text_for_community(node, graph)
    elif label == NodeLabel.PROCESS:
        text = _text_for_process(node, graph)
    else:
        text = _header(node)

    # Enforce token budget — truncate if exceeding ~2048 tokens
    max_chars = _MAX_TEXT_TOKENS * 4
    if len(text) > max_chars:
        text = text[:max_chars]
    return text

def _text_for_callable(node: GraphNode, graph: KnowledgeGraph) -> str:
    """Build text for FUNCTION and METHOD nodes."""
    lines: list[str] = [_header(node)]

    if node.signature:
        lines.append(f"signature: {node.signature}")

    callee_names = _target_names(node.id, RelType.CALLS, graph)
    if callee_names:
        lines.append(f"calls: {', '.join(callee_names)}")

    caller_names = _source_names(node.id, RelType.CALLS, graph)
    if caller_names:
        lines.append(f"called by: {', '.join(caller_names)}")

    type_names = _target_names(node.id, RelType.USES_TYPE, graph)
    if type_names:
        lines.append(f"uses types: {', '.join(type_names)}")

    # Fold error/log codes referenced in the body so the raising function is
    # findable by its error code (HOR-329). Emitted as intact tokens so FTS and
    # vector search both retain the whole identifier.
    error_codes = _extract_error_codes(node.content)
    if error_codes:
        lines.append(f"error codes: {' '.join(error_codes)}")

    return "\n".join(lines)

def _text_for_class(
    node: GraphNode,
    graph: KnowledgeGraph,
    class_method_index: dict[tuple[str, str], list[str]] | None = None,
) -> str:
    """Build text for CLASS nodes."""
    lines: list[str] = [_header(node)]

    if class_method_index is not None:
        method_names = class_method_index.get((node.name, node.file_path), [])
    else:
        method_names = _class_method_names(node.name, graph)
    if method_names:
        lines.append(f"methods: {', '.join(method_names)}")

    base_names = _target_names(node.id, RelType.EXTENDS, graph)
    if base_names:
        lines.append(f"extends: {', '.join(base_names)}")

    iface_names = _target_names(node.id, RelType.IMPLEMENTS, graph)
    if iface_names:
        lines.append(f"implements: {', '.join(iface_names)}")

    return "\n".join(lines)

def _text_for_file(node: GraphNode, graph: KnowledgeGraph) -> str:
    """Build text for FILE nodes."""
    lines: list[str] = [_header(node)]

    defined_names = _target_names(node.id, RelType.DEFINES, graph)
    if defined_names:
        lines.append(f"defines: {', '.join(defined_names)}")

    import_names = _target_names(node.id, RelType.IMPORTS, graph)
    if import_names:
        lines.append(f"imports: {', '.join(import_names)}")

    return "\n".join(lines)

def _text_for_folder(node: GraphNode, graph: KnowledgeGraph) -> str:
    """Build text for FOLDER nodes."""
    lines: list[str] = [_header(node)]

    child_names = _target_names(node.id, RelType.CONTAINS, graph)
    if child_names:
        lines.append(f"contains: {', '.join(child_names)}")

    return "\n".join(lines)

def _text_for_type_definition(node: GraphNode, _graph: KnowledgeGraph) -> str:
    """Build text for INTERFACE, TYPE_ALIAS, and ENUM nodes."""
    lines: list[str] = [_header(node)]

    if node.signature:
        lines.append(f"signature: {node.signature}")

    return "\n".join(lines)

def _text_for_community(node: GraphNode, graph: KnowledgeGraph) -> str:
    """Build text for COMMUNITY nodes."""
    lines: list[str] = [_header(node)]

    member_names = _source_names(node.id, RelType.MEMBER_OF, graph)
    if member_names:
        lines.append(f"members: {', '.join(member_names)}")

    return "\n".join(lines)

def _text_for_process(node: GraphNode, graph: KnowledgeGraph) -> str:
    """Build text for PROCESS nodes."""
    lines: list[str] = [_header(node)]

    step_names = _source_names(node.id, RelType.STEP_IN_PROCESS, graph)
    if step_names:
        lines.append(f"steps: {', '.join(step_names)}")

    return "\n".join(lines)

# Split a programmer identifier into its natural-language words: camelCase humps,
# acronym→word boundaries, and snake/kebab/dotted separators (markDuplicateLead ->
# "mark duplicate lead", HTTPServer -> "http server", HTTP2Server -> "http2 server").
# The embedding model latches onto these word units far better than onto one compound
# token, so a query like "duplicate lead detection" can reach markDuplicateLead. Returns
# '' when humanizing adds nothing.
_IDENT_SPLIT_RE = re.compile(
    r"[_./\- ]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])"
)


def _humanize(identifier: str | None) -> str:
    if not identifier:
        return ""
    words = [w.lower() for w in _IDENT_SPLIT_RE.split(identifier) if w]
    humanized = " ".join(words)
    # Nothing gained if it's already a single lowercase word identical to the input.
    return humanized if humanized != identifier.lower() else ""


def _header(node: GraphNode) -> str:
    """Build the opening line(s): a humanized gloss of the name, then ``<label> <name>``.

    The humanized gloss leads so the natural-language words carry the most weight in the
    embedding; the structural ``<label> <name> in <file>`` line preserves exact tokens for
    lexical/FTS overlap.
    """
    lines: list[str] = []

    human = _humanize(node.name)
    if human:
        class_human = _humanize(node.class_name) if node.class_name else ""
        lines.append(f"{human} {class_human}".strip() if class_human else human)

    parts: list[str] = [f"{node.label.value} {node.name}"]
    if node.label == NodeLabel.METHOD and node.class_name:
        parts.append(f"of class {node.class_name}")
    if node.file_path:
        parts.append(f"in {node.file_path}")
    lines.append(" ".join(parts))

    return "\n".join(lines)

def _target_names(
    node_id: str, rel_type: RelType, graph: KnowledgeGraph
) -> list[str]:
    """Return sorted names of target nodes for outgoing edges of *rel_type*."""
    rels = graph.get_outgoing(node_id, rel_type=rel_type)
    names: list[str] = []
    for rel in rels:
        target = graph.get_node(rel.target)
        if target is not None:
            names.append(target.name)
    return sorted(names)

def _source_names(
    node_id: str, rel_type: RelType, graph: KnowledgeGraph
) -> list[str]:
    """Return sorted names of source nodes for incoming edges of *rel_type*."""
    rels = graph.get_incoming(node_id, rel_type=rel_type)
    names: list[str] = []
    for rel in rels:
        source = graph.get_node(rel.source)
        if source is not None:
            names.append(source.name)
    return sorted(names)

def _class_method_names(class_name: str, graph: KnowledgeGraph) -> list[str]:
    """Return sorted names of METHOD nodes whose ``class_name`` matches."""
    methods = graph.get_nodes_by_label(NodeLabel.METHOD)
    return sorted(m.name for m in methods if m.class_name == class_name)
