"""Phase 5: Call tracing for Horus.

Takes FileParseData from the parser phase and resolves call expressions to
target symbol nodes, creating CALLS relationships with confidence scores.

Resolution priority:
1. Same-file exact match (confidence 1.0)
2. Import-resolved match (confidence 1.0)
3. Global fuzzy match (confidence 0.5)
4. Receiver method resolution (confidence 0.8)
5. DI member resolution (confidence 0.8) -- ``this.<injectedField>.<method>()``
   is rewritten through the enclosing class's ``di_fields`` map (captured by the
   parser from constructor parameter-properties / typed fields) to reach the
   concrete injected service's method.
"""

from __future__ import annotations

import logging
import os
from concurrent.futures import ThreadPoolExecutor

from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.core.graph.model import (
    GraphRelationship,
    NodeLabel,
    RelType,
    generate_id,
)
from horus_source.core.ingestion.parser_phase import FileParseData
from horus_source.core.ingestion.resolved import ResolvedEdge
from horus_source.core.ingestion.symbol_lookup import (
    FileSymbolIndex,
    build_file_symbol_index,
    build_name_index,
    find_containing_symbol,
)
from horus_source.core.parsers.base import CallInfo

logger = logging.getLogger(__name__)

_CALLABLE_LABELS: tuple[NodeLabel, ...] = (
    NodeLabel.FUNCTION,
    NodeLabel.METHOD,
    NodeLabel.CLASS,
)

_KIND_TO_LABEL: dict[str, NodeLabel] = {
    "function": NodeLabel.FUNCTION,
    "method": NodeLabel.METHOD,
    "class": NodeLabel.CLASS,
}

# Names that should never produce CALLS edges.  These are language builtins,
# stdlib utilities, framework hooks, and common JS/TS globals whose definitions
# do not exist in the user's codebase.  Filtering them before resolution
# prevents low-confidence global-fuzzy matches against short, common names.
_CALL_BLOCKLIST: frozenset[str] = frozenset({
    # Python builtins
    "print", "len", "range", "map", "filter", "sorted", "list", "dict",
    "set", "str", "int", "float", "bool", "type", "super", "isinstance",
    "issubclass", "hasattr", "getattr", "setattr", "open", "iter", "next",
    "zip", "enumerate", "any", "all", "min", "max", "sum", "abs", "round",
    "repr", "id", "hash", "dir", "vars", "input", "format", "tuple",
    "frozenset", "bytes", "bytearray", "memoryview", "object", "property",
    "classmethod", "staticmethod", "delattr", "callable", "compile", "eval",
    "exec", "globals", "locals", "breakpoint", "exit", "quit",
    # Python stdlib — common method names that collide with user-defined symbols
    "append", "extend", "update", "pop", "get", "items", "keys", "values",
    "split", "join", "strip", "replace", "startswith", "endswith", "lower",
    "upper", "encode", "decode", "read", "write", "close",
    # JS/TS built-in globals
    "console", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
    "JSON", "Array", "Object", "Promise", "Math", "Date", "Error", "Symbol",
    "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
    "decodeURIComponent", "fetch", "require", "exports", "module",
    "document", "window", "process", "Buffer", "URL",
    # JS/TS dotted method names extracted as bare call names
    "log", "error", "warn", "info", "debug",
    "parse", "stringify",
    "assign", "freeze",
    "isArray", "from", "of",
    "resolve", "reject", "race",
    "floor", "ceil", "random",
    # React hooks
    "useState", "useEffect", "useRef", "useCallback", "useMemo",
    "useContext", "useReducer", "useLayoutEffect", "useImperativeHandle",
    "useDebugValue", "useId", "useTransition", "useDeferredValue",
})

def resolve_call(
    call: CallInfo,
    file_path: str,
    call_index: dict[str, list[str]],
    graph: KnowledgeGraph,
    caller_class_name: str | None = None,
    import_cache: dict[str, set[str]] | None = None,
) -> tuple[str | None, float]:
    """Resolve a call expression to a target node ID and confidence score.

    Resolution strategy (tried in order):

    1. **Same-file exact match** (confidence 1.0) -- the called symbol is
       defined in the same file as the caller.
    2. **Import-resolved match** (confidence 1.0) -- the called name was
       imported into this file; find the symbol in the imported file.
    3. **Global fuzzy match** (confidence 0.5) -- any symbol with this name
       anywhere in the codebase.  If multiple matches exist, the one sharing
       the longest directory prefix with the caller is preferred.

    For method calls (``call.receiver`` is non-empty):
    - If the receiver is ``"self"`` or ``"this"``, look for a method with
      that name in the same class (same file, matching class_name).
    - Otherwise, try to resolve the method name globally.

    Args:
        call: The parsed call information.
        file_path: Path to the file containing the call.
        call_index: Mapping from symbol names to node IDs built by
            :func:`build_call_index`.
        graph: The knowledge graph.
        caller_class_name: Optional class name of the calling symbol,
            used to scope ``self``/``this`` method resolution.

    Returns:
        A tuple of ``(node_id, confidence)`` or ``(None, 0.0)`` if the
        call cannot be resolved.
    """
    name = call.name
    receiver = call.receiver

    if receiver in ("self", "this"):
        result = _resolve_self_method(name, file_path, call_index, graph, caller_class_name)
        if result is not None:
            return result, 1.0

    candidate_ids = call_index.get(name, [])
    if not candidate_ids:
        return None, 0.0

    for nid in candidate_ids:
        node = graph.get_node(nid)
        if node is not None and node.file_path == file_path:
            return nid, 1.0

    effective_cache = import_cache if import_cache is not None else _build_import_cache(file_path, graph)
    imported_target = _resolve_via_imports(name, candidate_ids, graph, effective_cache)
    if imported_target is not None:
        return imported_target, 1.0

    if len(candidate_ids) > 5:
        return None, 0.0
    return _pick_closest(candidate_ids, graph, caller_file_path=file_path), 0.5

def _resolve_self_method(
    method_name: str,
    file_path: str,
    call_index: dict[str, list[str]],
    graph: KnowledgeGraph,
    caller_class_name: str | None = None,
) -> str | None:
    """Find a method with *method_name* in the same file and class.

    When the receiver is ``self`` or ``this`` the target must be a Method
    node defined in the same file.  If *caller_class_name* is provided,
    candidates are further filtered to the same class.
    """
    fallback: str | None = None
    for nid in call_index.get(method_name, []):
        node = graph.get_node(nid)
        if (
            node is not None
            and node.label == NodeLabel.METHOD
            and node.file_path == file_path
        ):
            if caller_class_name and node.class_name == caller_class_name:
                return nid
            if fallback is None:
                fallback = nid
    return fallback

def _build_import_cache(
    file_path: str,
    graph: KnowledgeGraph,
) -> dict[str, set[str]]:
    """Build {symbol_name → set of imported file_paths} for a file.

    The special key ``"*"`` contains file paths from wildcard/full-module imports.
    """
    source_file_id = generate_id(NodeLabel.FILE, file_path)
    import_rels = graph.get_outgoing(source_file_id, RelType.IMPORTS)

    cache: dict[str, set[str]] = {}
    for rel in import_rels:
        target_node = graph.get_node(rel.target)
        if target_node is None:
            continue
        symbols_str = rel.properties.get("symbols", "")
        imported_names = {s.strip() for s in symbols_str.split(",") if s.strip()}
        if not imported_names:
            cache.setdefault("*", set()).add(target_node.file_path)
        else:
            for sym_name in imported_names:
                cache.setdefault(sym_name, set()).add(target_node.file_path)
    return cache


def _resolve_via_imports(
    name: str,
    candidate_ids: list[str],
    graph: KnowledgeGraph,
    import_cache: dict[str, set[str]],
) -> str | None:
    """Check if *name* was imported and resolve to the target using cached data.

    Uses the pre-built *import_cache* (from :func:`_build_import_cache`)
    to avoid re-scanning IMPORTS relationships for every call in the same file.
    """
    if not import_cache:
        return None

    imported_file_paths = import_cache.get(name, set()) | import_cache.get("*", set())
    if not imported_file_paths:
        return None

    for nid in candidate_ids:
        node = graph.get_node(nid)
        if node is not None and node.file_path in imported_file_paths:
            return nid

    return None

def _common_prefix_len(a: str, b: str) -> int:
    """Return the length of the common directory prefix between two paths."""
    parts_a = a.split("/")
    parts_b = b.split("/")
    common = 0
    for pa, pb in zip(parts_a, parts_b):
        if pa == pb:
            common += 1
        else:
            break
    return common


def _pick_closest(
    candidate_ids: list[str],
    graph: KnowledgeGraph,
    caller_file_path: str = "",
) -> str | None:
    """Pick the candidate sharing the longest directory prefix with the caller.

    Falls back to shortest file path when no caller path is provided.
    Returns ``None`` if no candidates can be resolved to actual nodes.
    """
    best_id: str | None = None
    best_score: tuple[int, int] = (-1, 0)

    for nid in candidate_ids:
        node = graph.get_node(nid)
        if node is None:
            continue
        if caller_file_path:
            prefix = _common_prefix_len(caller_file_path, node.file_path)
            score = (prefix, -len(node.file_path))
        else:
            score = (0, -len(node.file_path))
        if score > best_score:
            best_score = score
            best_id = nid

    return best_id


def _make_edge(
    source_id: str,
    target_id: str,
    confidence: float,
    seen: set[str],
) -> ResolvedEdge | None:
    """Create a deduplicated ResolvedEdge, returning None if already seen."""
    rel_id = f"calls:{source_id}->{target_id}"
    if rel_id in seen:
        return None
    seen.add(rel_id)
    return ResolvedEdge(
        rel_id=rel_id,
        rel_type=RelType.CALLS,
        source=source_id,
        target=target_id,
        properties={"confidence": confidence},
    )


def _resolve_receiver_method(
    receiver: str,
    method_name: str,
    source_id: str,
    file_path: str,
    call_index: dict[str, list[str]],
    graph: KnowledgeGraph,
) -> ResolvedEdge | None:
    """Resolve ``Receiver.method()`` to the METHOD node and return a ResolvedEdge.

    Looks for a METHOD node whose ``name`` matches *method_name* and whose
    ``class_name`` matches *receiver*.  Searches same-file first, then
    globally.
    """
    same_file_match: str | None = None
    global_match: str | None = None

    for nid in call_index.get(method_name, []):
        node = graph.get_node(nid)
        if (
            node is not None
            and node.label == NodeLabel.METHOD
            and node.class_name == receiver
        ):
            if node.file_path == file_path:
                same_file_match = nid
                break
            elif global_match is None:
                global_match = nid
        if same_file_match is not None:
            break

    target = same_file_match or global_match
    if target is not None:
        return ResolvedEdge(
            rel_id=f"calls:{source_id}->{target}",
            rel_type=RelType.CALLS,
            source=source_id,
            target=target,
            properties={"confidence": 0.8},
        )
    return None


_DI_RECEIVER_PREFIXES: tuple[str, ...] = ("this.", "self.")


def _di_field_name(receiver: str) -> str | None:
    """Return the injected-field name from a ``this.<field>...`` receiver.

    ``this.prismaService.user`` -> ``prismaService``;
    ``self.repo`` -> ``repo``.  Returns ``None`` when the receiver is not a
    ``this.``/``self.`` member access (so non-DI receivers fall through to the
    existing resolution paths untouched).
    """
    for prefix in _DI_RECEIVER_PREFIXES:
        if receiver.startswith(prefix):
            rest = receiver[len(prefix) :]
            field = rest.split(".", 1)[0].strip()
            return field or None
    return None


def _enclosing_class_di_fields(
    source_id: str,
    file_path: str,
    call_index: dict[str, list[str]],
    graph: KnowledgeGraph,
) -> dict[str, str]:
    """Return the ``di_fields`` map of the CLASS enclosing *source_id*.

    *source_id* is the symbol containing the call (usually a METHOD).  We read
    its ``class_name`` and find the same-file CLASS node carrying the
    ``di_fields`` property captured by the parser.  Returns ``{}`` when no class
    or DI map is available.
    """
    source_node = graph.get_node(source_id)
    if source_node is None:
        return {}

    class_name = source_node.class_name
    if not class_name and source_node.label == NodeLabel.CLASS:
        class_name = source_node.name
    if not class_name:
        return {}

    class_id = generate_id(NodeLabel.CLASS, file_path, class_name)
    class_node = graph.get_node(class_id)
    if class_node is None:
        # Fall back to a name lookup (class defined elsewhere / id mismatch).
        for nid in call_index.get(class_name, []):
            cand = graph.get_node(nid)
            if cand is not None and cand.label == NodeLabel.CLASS:
                class_node = cand
                break
    if class_node is None:
        return {}

    di_fields = class_node.properties.get("di_fields")
    return di_fields if isinstance(di_fields, dict) else {}


def _resolve_type_to_class(
    type_name: str,
    file_path: str,
    call_index: dict[str, list[str]],
    graph: KnowledgeGraph,
) -> str | None:
    """Resolve a type name to a CLASS node, preferring the closest file."""
    class_ids = [
        nid
        for nid in call_index.get(type_name, [])
        if (node := graph.get_node(nid)) is not None
        and node.label == NodeLabel.CLASS
    ]
    if not class_ids:
        return None
    return _pick_closest(class_ids, graph, caller_file_path=file_path)


def _resolve_di_member_call(
    receiver: str,
    method_name: str,
    source_id: str,
    file_path: str,
    call_index: dict[str, list[str]],
    graph: KnowledgeGraph,
) -> ResolvedEdge | None:
    """Resolve ``this.<injectedField>.<method>()`` to the concrete service method.

    Strips ``this.``/``self.``, reads the enclosing class's ``di_fields`` to map
    the field to its declared type, resolves that type to a CLASS node, then
    finds the ``method_name`` METHOD on that class.  Returns a CALLS edge at
    confidence 0.8, or ``None`` if any step fails (caller then falls back to the
    existing receiver resolution, so non-DI receivers are never regressed).
    """
    field = _di_field_name(receiver)
    if field is None:
        return None

    di_fields = _enclosing_class_di_fields(source_id, file_path, call_index, graph)
    type_name = di_fields.get(field)
    if not type_name:
        return None

    class_node_id = _resolve_type_to_class(type_name, file_path, call_index, graph)
    if class_node_id is None:
        return None

    class_node = graph.get_node(class_node_id)
    if class_node is None:
        return None

    return _resolve_receiver_method(
        type_name, method_name, source_id, class_node.file_path,
        call_index, graph,
    )


def resolve_file_calls(
    fpd: FileParseData,
    call_index: dict[str, list[str]],
    file_sym_index: FileSymbolIndex,
    graph: KnowledgeGraph,
) -> list[ResolvedEdge]:
    """Resolve all call expressions in a single file to ResolvedEdge objects.

    This is a pure-ish function (reads from graph but does not mutate it)
    that can be called in parallel across files.
    """
    edges: list[ResolvedEdge] = []
    seen: set[str] = set()
    import_cache = _build_import_cache(fpd.file_path, graph)

    for call in fpd.parse_result.calls:
        is_di_receiver = _di_field_name(call.receiver) is not None
        if (
            call.name in _CALL_BLOCKLIST
            and call.receiver not in ("self", "this")
            and not is_di_receiver
        ):
            continue

        source_id = find_containing_symbol(
            call.line, fpd.file_path, file_sym_index
        )
        if source_id is None:
            # Module-scope reference (dogfood cycle-4, lodash): prototype wiring like
            # `Hash.prototype.get = hashGet` sits in an anonymous IIFE — no named
            # containing symbol, so the reference was dropped ENTIRELY and hashGet
            # read as dead. Fall back to the FILE node as the edge source: honest
            # ("referenced at module scope of lodash.js") and keeps aliveness intact.
            file_node = graph.get_node(generate_id(NodeLabel.FILE, fpd.file_path))
            if file_node is None:
                logger.debug(
                    "No containing symbol for call %s at line %d in %s",
                    call.name,
                    call.line,
                    fpd.file_path,
                )
                continue
            source_id = file_node.id

        caller_class_name: str | None = None
        if call.receiver in ("self", "this"):
            source_node = graph.get_node(source_id)
            if source_node is not None:
                caller_class_name = source_node.class_name

        # DI member calls (``this.<injectedField>.<method>()``) resolve through
        # the enclosing class's DI field map to the concrete injected service
        # method.  Resolve this FIRST: it is the canonical, higher-confidence
        # answer, and recording it before the generic bare-name resolution keeps
        # the lower-confidence global-fuzzy duplicate from winning (dedup is by
        # source->target, ignoring confidence).  When it succeeds we skip the
        # generic resolution of this call's bare method name entirely.
        di_resolved = False
        if is_di_receiver:
            di_edge = _resolve_di_member_call(
                call.receiver, call.name, source_id, fpd.file_path,
                call_index, graph,
            )
            if di_edge is not None and di_edge.rel_id not in seen:
                seen.add(di_edge.rel_id)
                edges.append(di_edge)
                di_resolved = True

        if not di_resolved:
            target_id, confidence = resolve_call(
                call, fpd.file_path, call_index, graph,
                caller_class_name=caller_class_name,
                import_cache=import_cache,
            )
            if target_id is not None:
                edge = _make_edge(source_id, target_id, confidence, seen)
                if edge is not None:
                    edges.append(edge)

            # Ambiguous same-file method dispatch (dogfood cycle-3): a file with
            # several same-named methods on DIFFERENT classes (serde's
            # SeqDeserializer.end / MapDeserializer.end / ...) resolved every
            # `x.end()` to the FIRST candidate only — the siblings never received
            # an edge and were flagged dead despite being called. Static analysis
            # can't type the receiver, so link the remaining same-file candidates
            # at low confidence: dead-code sees a reference; confidence-aware
            # consumers can discount it.
            if (
                target_id is not None
                and call.receiver
                and call.receiver not in ("self", "this")
            ):
                same_file_siblings = [
                    nid
                    for nid in call_index.get(call.name, [])
                    if nid != target_id
                    and (n := graph.get_node(nid)) is not None
                    and n.file_path == fpd.file_path
                    and n.label == NodeLabel.METHOD
                    and n.class_name
                ]
                if 0 < len(same_file_siblings) <= 5:
                    for nid in same_file_siblings:
                        sib_edge = _make_edge(source_id, nid, 0.4, seen)
                        if sib_edge is not None:
                            edges.append(sib_edge)

        for arg_name in call.arguments:
            if arg_name in _CALL_BLOCKLIST:
                continue
            arg_call = CallInfo(name=arg_name, line=call.line)
            arg_id, arg_conf = resolve_call(
                arg_call, fpd.file_path, call_index, graph,
                import_cache=import_cache,
            )
            if arg_id is not None:
                edge = _make_edge(source_id, arg_id, arg_conf * 0.8, seen)
                if edge is not None:
                    edges.append(edge)

        # DI member calls were handled above (``is_di_receiver``).  Here we only
        # cover plain object receivers (``foo.bar()``) — resolve both the
        # receiver symbol and the ``Receiver.method`` pairing.
        receiver = call.receiver
        if not is_di_receiver and receiver and receiver not in ("self", "this"):
            receiver_call = CallInfo(name=receiver, line=call.line)
            recv_id, recv_conf = resolve_call(
                receiver_call, fpd.file_path, call_index, graph,
                import_cache=import_cache,
            )
            # Only link the receiver itself when it resolves with HIGH confidence (same-file
            # or import-resolved). A GLOBAL-FUZZY receiver match (0.5) is usually a LOCAL
            # variable/parameter shadowing a same-named module symbol — e.g. a `client`
            # parameter (an Apollo client) in `client.query()` fuzzily matching a `const
            # client = …` in another file. That false edge polluted callees/flows; the method
            # call itself is still resolved above, so dropping it loses no real call.
            if recv_id is not None and recv_conf >= 0.9:
                edge = _make_edge(source_id, recv_id, recv_conf, seen)
                if edge is not None:
                    edges.append(edge)

            recv_method_edge = _resolve_receiver_method(
                receiver, call.name, source_id, fpd.file_path,
                call_index, graph,
            )
            if recv_method_edge is not None and recv_method_edge.rel_id not in seen:
                seen.add(recv_method_edge.rel_id)
                edges.append(recv_method_edge)

    for symbol in fpd.parse_result.symbols:
        if not symbol.decorators:
            continue

        symbol_name = (
            f"{symbol.class_name}.{symbol.name}"
            if symbol.kind == "method" and symbol.class_name
            else symbol.name
        )
        label = _KIND_TO_LABEL.get(symbol.kind)
        if label is None:
            continue
        source_id = generate_id(label, fpd.file_path, symbol_name)

        for dec_name in symbol.decorators:
            base_name = dec_name.rsplit(".", 1)[-1] if "." in dec_name else dec_name
            call_obj = CallInfo(name=base_name, line=symbol.start_line)
            target_id, confidence = resolve_call(
                call_obj, fpd.file_path, call_index, graph,
                import_cache=import_cache,
            )
            if target_id is None and "." in dec_name:
                call_obj = CallInfo(name=dec_name, line=symbol.start_line)
                target_id, confidence = resolve_call(
                    call_obj, fpd.file_path, call_index, graph,
                    import_cache=import_cache,
                )
            if target_id is not None:
                edge = _make_edge(source_id, target_id, confidence, seen)
                if edge is not None:
                    edges.append(edge)

    return edges


def process_calls(
    parse_data: list[FileParseData],
    graph: KnowledgeGraph,
    name_index: dict[str, list[str]] | None = None,
    *,
    parallel: bool = False,
    collect: bool = False,
) -> list[ResolvedEdge] | None:
    """Resolve call expressions and create CALLS relationships in the graph.

    For each call expression in the parse data:

    1. Determine which symbol in the file *contains* the call (by line
       number range).
    2. Resolve the call to a target symbol node.
    3. Create a CALLS relationship from the containing symbol to the
       target, with a ``confidence`` property.

    Args:
        parse_data: File parse results from the parser phase.
        graph: The knowledge graph to populate with CALLS relationships.
        name_index: Optional pre-built name index; built automatically if None.
        parallel: When True, resolve files using a thread pool.
        collect: When True, return the list of ResolvedEdge objects instead
            of writing them to the graph.

    Returns:
        A list of ResolvedEdge when *collect* is True, otherwise None.
    """
    call_index = name_index if name_index is not None else build_name_index(graph, _CALLABLE_LABELS)
    file_sym_index = build_file_symbol_index(graph, _CALLABLE_LABELS)

    if parallel and len(parse_data) > 1:
        workers = min(os.cpu_count() or 4, 8, len(parse_data))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [
                pool.submit(resolve_file_calls, fpd, call_index, file_sym_index, graph)
                for fpd in parse_data
            ]
            per_file_edges = [f.result() for f in futures]
    else:
        per_file_edges = [
            resolve_file_calls(fpd, call_index, file_sym_index, graph)
            for fpd in parse_data
        ]

    seen: set[str] = set()
    deduped: list[ResolvedEdge] = []
    for file_edges in per_file_edges:
        for edge in file_edges:
            if edge.rel_id not in seen:
                seen.add(edge.rel_id)
                deduped.append(edge)

    if collect:
        return deduped

    for edge in deduped:
        graph.add_relationship(
            GraphRelationship(
                id=edge.rel_id,
                type=edge.rel_type,
                source=edge.source,
                target=edge.target,
                properties=edge.properties,
            )
        )
    return None
