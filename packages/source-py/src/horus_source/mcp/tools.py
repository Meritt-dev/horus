"""MCP tool handler implementations for Horus.

Each function accepts a storage backend and the tool-specific arguments,
performs the appropriate query, and returns a human-readable string suitable
for inclusion in an MCP ``TextContent`` response.
"""

from __future__ import annotations

import json
import logging
import re
from collections import deque
from pathlib import Path
from typing import Any

from horus_source.core.cypher_guard import is_read_only_sql
from horus_source.core.embeddings.embedder import embed_query
from horus_source.core.graph.model import RelType
from horus_source.core.ingestion.community import export_to_igraph
from horus_source.core.ingestion.dead_code import _is_test_file
from horus_source.core.search.hybrid import hybrid_search
from horus_source.core.storage.base import TRACE_REL_TYPES, EdgeNeighbor, StorageBackend
from horus_source.mcp.resources import get_dead_code_list

logger = logging.getLogger(__name__)

MAX_TRAVERSE_DEPTH = 10

_SAFE_PATH = re.compile(r"^[a-zA-Z0-9._/\-\s]+$")


def _confidence_tag(confidence: float) -> str:
    """Return a visual confidence indicator for edge display."""
    if confidence >= 0.9:
        return ""
    if confidence >= 0.5:
        return " (~)"
    return " (?)"


def _resolve_symbol(storage: StorageBackend, symbol: str) -> list:
    """Resolve a symbol name to search results, preferring exact name matches."""
    if hasattr(storage, "exact_name_search"):
        results = storage.exact_name_search(symbol, limit=1)
        if results:
            return results
    return storage.fts_search(symbol, limit=1)


def _resolve_symbol_ranked(
    storage: StorageBackend, symbol: str, limit: int = 5
) -> list:
    """Like :func:`_resolve_symbol` but returns the ranked candidate list.

    The extra candidates power the trace ambiguity guard: when the top match
    barely edges out its runner-up, the resolution is flagged rather than
    silently committing to a coin-flip.
    """
    if hasattr(storage, "exact_name_search"):
        results = storage.exact_name_search(symbol, limit=limit)
        if results:
            return results
    return storage.fts_search(symbol, limit=limit)


#: When the top match wins by less than this fraction of its own score, the
#: resolution is ambiguous enough to warn about.
_AMBIGUOUS_MARGIN = 0.10


def _ambiguity_note(role: str, query: str, results: list) -> str | None:
    """Warn when a symbol query resolved to a near-tie (ported guard).

    Returns a one-line note when the runner-up's score is within
    ``_AMBIGUOUS_MARGIN`` of the winner, else ``None``.
    """
    if len(results) < 2:
        return None
    top, runner = results[0].score, results[1].score
    if top > 0 and (top - runner) / top < _AMBIGUOUS_MARGIN:
        return (
            f"note: {role} '{query}' was ambiguous — matched "
            f"{results[0].node_name} ({results[0].file_path}); runner-up "
            f"{results[1].node_name} ({results[1].file_path}). "
            f"Pass a more specific name to disambiguate."
        )
    return None


def _resolve_rel_types(relations: list[str] | None) -> list[RelType]:
    """Map optional relation-name filters to :class:`RelType`, else the default set."""
    if not relations:
        return list(TRACE_REL_TYPES)
    by_value = {rt.value: rt for rt in RelType}
    chosen = [by_value[r.strip().lower()] for r in relations if r.strip().lower() in by_value]
    return chosen or list(TRACE_REL_TYPES)

def handle_list_repos(registry_dir: Path | None = None) -> str:
    """List indexed repositories from the global registry.

    Scans the global registry directory (defaults to ``~/.horus/source/repos``)
    for project metadata files and returns a formatted summary.

    Args:
        registry_dir: Directory containing repo metadata. If ``None``,
            defaults to ``~/.horus/source/repos``.

    Returns:
        Formatted list of indexed repositories with stats, or a message
        indicating none were found.
    """
    use_cwd_fallback = registry_dir is None
    if registry_dir is None:
        registry_dir = Path.home() / ".horus" / "source" / "repos"

    repos: list[dict[str, Any]] = []

    if registry_dir.exists():
        for meta_file in registry_dir.glob("*/meta.json"):
            try:
                data = json.loads(meta_file.read_text())
                repos.append(data)
            except (json.JSONDecodeError, OSError):
                continue

    if not repos and use_cwd_fallback:
        for cwd_meta in [
            Path.cwd() / ".horus" / "source" / "meta.json",
        ]:
            if cwd_meta.exists():
                try:
                    data = json.loads(cwd_meta.read_text())
                    repos.append(data)
                    break
                except (json.JSONDecodeError, OSError):
                    pass

    if not repos:
        return "No indexed repositories found. Run `horus-source analyze` on a project first."

    lines = [f"Indexed repositories ({len(repos)}):"]
    lines.append("")
    for i, repo in enumerate(repos, 1):
        name = repo.get("name", "unknown")
        path = repo.get("path", "")
        stats = repo.get("stats", {})
        files = stats.get("files", "?")
        symbols = stats.get("symbols", "?")
        relationships = stats.get("relationships", "?")
        lines.append(f"  {i}. {name}")
        lines.append(f"     Path: {path}")
        lines.append(f"     Files: {files}  Symbols: {symbols}  Relationships: {relationships}")
        lines.append("")

    return "\n".join(lines)

def _group_by_process(
    results: list,
    storage: StorageBackend,
) -> dict[str, list]:
    """Map search results to their parent execution processes."""
    if not results:
        return {}

    node_ids = [r.node_id for r in results]
    try:
        node_to_process = storage.get_process_memberships(node_ids)
    except AttributeError:
        return {}

    groups: dict[str, list] = {}
    for r in results:
        pname = node_to_process.get(r.node_id)
        if pname:
            groups.setdefault(pname, []).append(r)

    return groups


def _format_query_results(results: list, groups: dict[str, list]) -> str:
    """Format search results with process grouping.

    Results belonging to a process appear under a labelled section.
    Remaining results appear in an "Other results" section.
    """
    grouped_ids: set[str] = {r.node_id for group in groups.values() for r in group}
    ungrouped = [r for r in results if r.node_id not in grouped_ids]

    lines: list[str] = []
    counter = 1

    for process_name, proc_results in groups.items():
        lines.append(f"=== {process_name} ===")
        for r in proc_results:
            label = r.label.title() if r.label else "Unknown"
            lines.append(f"{counter}. {r.node_name} ({label}) -- {r.file_path}")
            if r.snippet:
                snippet = r.snippet[:200].replace("\n", " ").strip()
                lines.append(f"   {snippet}")
            counter += 1
        lines.append("")

    if ungrouped:
        if groups:
            lines.append("=== Other results ===")
        for r in ungrouped:
            label = r.label.title() if r.label else "Unknown"
            lines.append(f"{counter}. {r.node_name} ({label}) -- {r.file_path}")
            if r.snippet:
                snippet = r.snippet[:200].replace("\n", " ").strip()
                lines.append(f"   {snippet}")
            counter += 1
        lines.append("")

    lines.append("Next: Use context() on a specific symbol for the full picture.")
    return "\n".join(lines)


def handle_query(storage: StorageBackend, query: str, limit: int = 20) -> str:
    """Execute hybrid search and format results, grouped by execution process.

    Args:
        storage: The storage backend to search against.
        query: Text search query.
        limit: Maximum number of results (default 20, capped at 100).

    Returns:
        Formatted search results grouped by process, with file, name, label,
        and snippet for each result.
    """
    limit = max(1, min(limit, 100))

    query_embedding = embed_query(query)
    if query_embedding is None:
        logger.warning("embed_query returned None; falling back to FTS-only search")

    results = hybrid_search(query, storage, query_embedding=query_embedding, limit=limit)
    if not results:
        return f"No results found for '{query}'."

    groups = _group_by_process(results, storage)
    return _format_query_results(results, groups)

def handle_context(storage: StorageBackend, symbol: str) -> str:
    """Provide a 360-degree view of a symbol.

    Looks up the symbol by name via full-text search, then retrieves its
    callers, callees, and type references.

    Args:
        storage: The storage backend.
        symbol: The symbol name to look up.

    Returns:
        Formatted view including callers, callees, type refs, and guidance.
    """
    if not symbol or not symbol.strip():
        return "Error: 'symbol' parameter is required and cannot be empty."

    results = _resolve_symbol(storage, symbol)
    if not results:
        return f"Symbol '{symbol}' not found."

    node = storage.get_node(results[0].node_id)
    if not node:
        return f"Symbol '{symbol}' not found."

    label_display = node.label.value.title() if node.label else "Unknown"
    lines = [f"Symbol: {node.name} ({label_display})"]
    lines.append(f"File: {node.file_path}:{node.start_line}-{node.end_line}")

    if node.signature:
        lines.append(f"Signature: {node.signature}")

    if node.is_dead:
        lines.append("Status: DEAD CODE (unreachable)")

    try:
        callers_raw = storage.get_callers_with_confidence(node.id)
    except (AttributeError, TypeError):
        callers_raw = [(c, 1.0) for c in storage.get_callers(node.id)]

    if callers_raw:
        lines.append(f"\nCallers ({len(callers_raw)}):")
        for c, conf in callers_raw:
            tag = _confidence_tag(conf)
            lines.append(f"  -> {c.name}  {c.file_path}:{c.start_line}{tag}")

    try:
        callees_raw = storage.get_callees_with_confidence(node.id)
    except (AttributeError, TypeError):
        callees_raw = [(c, 1.0) for c in storage.get_callees(node.id)]

    if callees_raw:
        lines.append(f"\nCallees ({len(callees_raw)}):")
        for c, conf in callees_raw:
            tag = _confidence_tag(conf)
            lines.append(f"  -> {c.name}  {c.file_path}:{c.start_line}{tag}")

    type_refs = storage.get_type_refs(node.id)
    if type_refs:
        lines.append(f"\nType references ({len(type_refs)}):")
        for t in type_refs:
            lines.append(f"  -> {t.name}  {t.file_path}")

    heritage_rows = storage.get_heritage(node.id)
    if heritage_rows:
        lines.append(f"\nHeritage ({len(heritage_rows)}):")
        for row in heritage_rows:
            parent_name = row[0] or "?"
            parent_file = row[1] or "?"
            rel = row[2] or "?"
            lines.append(f"  -> {rel}: {parent_name}  {parent_file}")

    if node.file_path:
        importers = storage.get_file_importers(node.file_path)
        if importers:
            lines.append(f"\nImported by ({len(importers)}):")
            for imp in importers:
                lines.append(f"  -> {imp}")

    lines.append("")
    lines.append("Next: Use impact() if planning changes to this symbol.")
    return "\n".join(lines)

_DEPTH_LABELS: dict[int, str] = {
    1: "Direct callers (will break)",
    2: "Indirect (may break)",
}


def handle_impact(storage: StorageBackend, symbol: str, depth: int = 3) -> str:
    """Analyse the blast radius of changing a symbol, grouped by hop depth.

    Uses BFS traversal through CALLS edges to find all affected symbols
    up to the specified depth, then groups results by distance.

    Args:
        storage: The storage backend.
        symbol: The symbol name to analyse.
        depth: Maximum traversal depth (default 3).

    Returns:
        Formatted impact analysis with depth-grouped sections.
    """
    if not symbol or not symbol.strip():
        return "Error: 'symbol' parameter is required and cannot be empty."

    depth = max(1, min(depth, MAX_TRAVERSE_DEPTH))

    results = _resolve_symbol(storage, symbol)
    if not results:
        return f"Symbol '{symbol}' not found."

    start_node = storage.get_node(results[0].node_id)
    if not start_node:
        return f"Symbol '{symbol}' not found."

    affected_with_depth = storage.traverse_with_depth(
        start_node.id, depth, direction="callers"
    )
    if not affected_with_depth:
        return f"No upstream callers found for '{symbol}'."

    by_depth: dict[int, list] = {}
    for node, d in affected_with_depth:
        by_depth.setdefault(d, []).append(node)

    total = len(affected_with_depth)
    label_display = start_node.label.value.title()
    lines = [f"Impact analysis for: {start_node.name} ({label_display})"]
    lines.append(f"Depth: {depth} | Total: {total} symbols")

    conf_lookup = {
        node.id: conf for node, conf in storage.get_callers_with_confidence(start_node.id)
    }

    counter = 1
    for d in sorted(by_depth.keys()):
        depth_label = _DEPTH_LABELS.get(d, "Transitive (review)")
        lines.append(f"\nDepth {d} — {depth_label}:")
        for node in by_depth[d]:
            label = node.label.value.title() if node.label else "Unknown"
            conf = conf_lookup.get(node.id)
            tag = f"  (confidence: {conf:.2f})" if conf is not None else ""
            lines.append(
                f"  {counter}. {node.name} ({label}) -- "
                f"{node.file_path}:{node.start_line}{tag}"
            )
            counter += 1

    lines.append("")
    lines.append("Tip: Review each affected symbol before making changes.")
    return "\n".join(lines)

def handle_dead_code(storage: StorageBackend) -> str:
    """List all symbols marked as dead code.

    Delegates to :func:`~horus_source.mcp.resources.get_dead_code_list` for the
    shared query and formatting.

    Args:
        storage: The storage backend.

    Returns:
        Formatted list of dead code symbols grouped by file.
    """
    return get_dead_code_list(storage)

_DIFF_FILE_PATTERN = re.compile(r"^diff --git a/(.+?) b/(.+?)$", re.MULTILINE)
_DIFF_HUNK_PATTERN = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", re.MULTILINE)


def _parse_diff_files(diff: str) -> dict[str, list[tuple[int, int]]]:
    """Parse a git diff and return {file_path: [(start, end), ...]}."""
    changed_files: dict[str, list[tuple[int, int]]] = {}
    current_file: str | None = None

    for line in diff.split("\n"):
        file_match = _DIFF_FILE_PATTERN.match(line)
        if file_match:
            current_file = file_match.group(2)
            if current_file not in changed_files:
                changed_files[current_file] = []
            continue

        hunk_match = _DIFF_HUNK_PATTERN.match(line)
        if hunk_match and current_file is not None:
            start = int(hunk_match.group(1))
            count = max(1, int(hunk_match.group(2) or "1"))
            changed_files[current_file].append((start, start + count - 1))

    return changed_files


def handle_detect_changes(storage: StorageBackend, diff: str) -> str:
    """Map git diff output to affected symbols.

    Parses the diff to find changed files and line ranges, then queries
    the storage backend to identify which symbols those lines belong to.

    Args:
        storage: The storage backend.
        diff: Raw git diff output string.

    Returns:
        Formatted list of affected symbols per changed file.
    """
    if not diff.strip():
        return "Empty diff provided."

    changed_files = _parse_diff_files(diff)

    if not changed_files:
        return "Could not parse any changed files from the diff."

    lines = [f"Changed files: {len(changed_files)}"]
    lines.append("")
    total_affected = 0

    for file_path, ranges in changed_files.items():
        affected_symbols = []
        if not _SAFE_PATH.match(file_path):
            logger.warning("Skipping unsafe file path in diff: %r", file_path)
            lines.append(f"  {file_path}:")
            lines.append("    (skipped: path contains unsafe characters)")
            lines.append("")
            continue

        for node in storage.get_symbols_in_file(file_path):
            name = node.name or ""
            start_line = node.start_line or 0
            end_line = node.end_line or 0
            label_prefix = node.id.split(":", 1)[0] if node.id else ""
            for start, end in ranges:
                if start_line <= end and end_line >= start:
                    affected_symbols.append((name, label_prefix.title(), start_line, end_line))
                    break

        lines.append(f"  {file_path}:")
        if affected_symbols:
            for sym_name, label, s_line, e_line in affected_symbols:
                lines.append(f"    - {sym_name} ({label}) lines {s_line}-{e_line}")
                total_affected += 1
        else:
            lines.append("    (no indexed symbols in changed lines)")
        lines.append("")

    lines.append(f"Total affected symbols: {total_affected}")
    lines.append("")
    lines.append("Next: Use impact() on affected symbols to see downstream effects.")
    return "\n".join(lines)

def handle_cypher(storage: StorageBackend, query: str) -> str:
    """Execute a read-only SQL query and return formatted results.

    Since the kùzu→SQLite migration (HOR-392) the default backend is SQLite, so
    this console accepts read-only SQL (``SELECT``/``WITH``). Queries containing
    write/DDL keywords or multiple statements are rejected.

    Args:
        storage: The storage backend.
        query: The read-only SQL query string.

    Returns:
        Formatted query results, or an error message if execution fails.
    """
    if not is_read_only_sql(query):
        return (
            "Query rejected: only read-only SQL is allowed. The query must be a "
            "single SELECT/WITH statement; writes and DDL (INSERT, UPDATE, DELETE, "
            "DROP, CREATE, ALTER, PRAGMA, ...) are not permitted."
        )

    try:
        rows = storage.execute_raw(query)
    except Exception as exc:
        return f"Query failed: {exc}"

    if not rows:
        return "Query returned no results."

    lines = [f"Results ({len(rows)} rows):"]
    lines.append("")
    for i, row in enumerate(rows, 1):
        formatted_values = [str(v) for v in row]
        lines.append(f"  {i}. {' | '.join(formatted_values)}")

    return "\n".join(lines)


def handle_coupling(
    storage: StorageBackend, file_path: str, min_strength: float = 0.3
) -> str:
    """Query temporal coupling for a file and flag hidden dependencies."""
    if not file_path or not file_path.strip():
        return "Error: 'file_path' parameter is required and cannot be empty."

    file_path = file_path.strip()
    if not _SAFE_PATH.match(file_path):
        return "Error: file path contains unsafe characters."

    rows = storage.get_file_coupling(file_path)
    rows = [r for r in rows if (r[1] or 0) >= min_strength]

    if not rows:
        return f"No temporal coupling found for '{file_path}' (min strength: {min_strength})."

    imported_files = set(storage.get_file_imports(file_path))

    lines = [f"Temporal coupling for: {file_path}"]
    lines.append("=" * 48)
    lines.append("")

    for i, row in enumerate(rows, 1):
        coupled_path = row[0] or "?"
        strength = row[1] or 0.0
        co_changes = row[2] or 0
        has_import = coupled_path in imported_files
        import_flag = "imports: yes" if has_import else "imports: no \u26a0\ufe0f"
        lines.append(
            f"  {i}. {coupled_path}  strength: {strength:.2f}  "
            f"co_changes: {co_changes}  ({import_flag})"
        )

    lines.append("")
    hidden = [r[0] for r in rows if r[0] not in imported_files]
    if hidden:
        lines.append(
            f"\u26a0\ufe0f {len(hidden)} file(s) have hidden dependencies (no static import)."
        )
    return "\n".join(lines)


def handle_call_path(
    storage: StorageBackend, from_symbol: str, to_symbol: str, max_depth: int = 10
) -> str:
    """Find the shortest call chain between two symbols via BFS."""
    if not from_symbol or not from_symbol.strip():
        return "Error: 'from_symbol' parameter is required and cannot be empty."
    if not to_symbol or not to_symbol.strip():
        return "Error: 'to_symbol' parameter is required and cannot be empty."

    max_depth = max(1, min(max_depth, MAX_TRAVERSE_DEPTH))

    from_results = _resolve_symbol(storage, from_symbol)
    if not from_results:
        return f"Source symbol '{from_symbol}' not found."

    to_results = _resolve_symbol(storage, to_symbol)
    if not to_results:
        return f"Target symbol '{to_symbol}' not found."

    src_node = storage.get_node(from_results[0].node_id)
    tgt_node = storage.get_node(to_results[0].node_id)
    if not src_node or not tgt_node:
        return "Could not resolve one or both symbols."

    if src_node.id == tgt_node.id:
        return f"Source and target are the same symbol: {src_node.name}"

    parent: dict[str, str] = {}
    queue: deque[tuple[str, int]] = deque([(src_node.id, 0)])
    visited: set[str] = {src_node.id}

    found = False
    while queue:
        current_id, depth = queue.popleft()
        if depth >= max_depth:
            continue

        for callee in storage.get_callees(current_id):
            if callee.id in visited:
                continue
            visited.add(callee.id)
            parent[callee.id] = current_id

            if callee.id == tgt_node.id:
                found = True
                break

            queue.append((callee.id, depth + 1))

        if found:
            break

    if not found:
        return (
            f"No call path found from '{src_node.name}' to '{tgt_node.name}' "
            f"within {max_depth} hops."
        )

    path_ids: list[str] = []
    node_id = tgt_node.id
    while node_id is not None:
        path_ids.append(node_id)
        node_id = parent.get(node_id)
    path_ids.reverse()

    hop_count = len(path_ids) - 1
    path_names = []
    lines = []
    for i, nid in enumerate(path_ids, 1):
        node = storage.get_node(nid)
        if node:
            label = node.label.value.title() if node.label else "Unknown"
            path_names.append(node.name)
            lines.append(f"  {i}. {node.name} ({label}) — {node.file_path}:{node.start_line}")
        else:
            path_names.append(nid)
            lines.append(f"  {i}. {nid}")

    header = f"Call path: {' → '.join(path_names)} ({hop_count} hop{'s' if hop_count != 1 else ''})"
    return header + "\n\n" + "\n".join(lines)


def compute_trace(
    storage: StorageBackend,
    from_symbol: str,
    to_symbol: str,
    max_depth: int = 10,
    relations: list[str] | None = None,
) -> dict[str, Any]:
    """Shortest relationship path between two symbols as structured data.

    Shared core for both the MCP renderer (:func:`handle_trace`) and the HTTP
    read-path the CLI consumes. Walks every semantic code relationship (calls,
    imports, extends, implements, uses_type) in BOTH directions via
    :meth:`StorageBackend.get_edge_neighbors`, so it answers "how are A and B
    connected?" rather than only "does A call B?".

    Returns a dict with ``found`` and, on failure, an ``error`` string. On
    success: ``hops``, ``path`` (list of node dicts), ``segments`` (one per hop,
    each ``{rel_type, confidence, direction}``), and ``notes`` (ambiguity
    warnings). ``segments[i]`` describes the edge from ``path[i]`` to
    ``path[i+1]``; ``direction`` is ``"out"`` when it points forward along the
    path and ``"in"`` when the stored edge points backward.
    """
    if not from_symbol or not from_symbol.strip():
        return {"found": False, "error": "'from_symbol' is required and cannot be empty."}
    if not to_symbol or not to_symbol.strip():
        return {"found": False, "error": "'to_symbol' is required and cannot be empty."}

    max_depth = max(1, min(max_depth, MAX_TRAVERSE_DEPTH))
    rel_types = _resolve_rel_types(relations)

    from_results = _resolve_symbol_ranked(storage, from_symbol)
    if not from_results:
        return {"found": False, "error": f"Source symbol '{from_symbol}' not found."}
    to_results = _resolve_symbol_ranked(storage, to_symbol)
    if not to_results:
        return {"found": False, "error": f"Target symbol '{to_symbol}' not found."}

    src_node = storage.get_node(from_results[0].node_id)
    tgt_node = storage.get_node(to_results[0].node_id)
    if not src_node or not tgt_node:
        return {"found": False, "error": "Could not resolve one or both symbols."}
    if src_node.id == tgt_node.id:
        return {
            "found": False,
            "error": (
                f"'{from_symbol}' and '{to_symbol}' resolved to the same symbol "
                f"({src_node.name}). Use more specific names for a meaningful trace."
            ),
        }

    # BFS treating edges as undirected — get_edge_neighbors returns both in- and
    # out-edges — while recording the EdgeNeighbor used to reach each node so the
    # reconstructed path can be annotated with relation/direction/confidence.
    parent: dict[str, str] = {}
    via: dict[str, EdgeNeighbor] = {}
    visited: set[str] = {src_node.id}
    queue: deque[tuple[str, int]] = deque([(src_node.id, 0)])
    found = False
    while queue:
        current_id, depth = queue.popleft()
        if depth >= max_depth:
            continue
        for nb in storage.get_edge_neighbors(current_id, rel_types):
            if nb.node.id in visited:
                continue
            visited.add(nb.node.id)
            parent[nb.node.id] = current_id
            via[nb.node.id] = nb
            if nb.node.id == tgt_node.id:
                found = True
                break
            queue.append((nb.node.id, depth + 1))
        if found:
            break

    notes = [
        n
        for n in (
            _ambiguity_note("source", from_symbol, from_results),
            _ambiguity_note("target", to_symbol, to_results),
        )
        if n
    ]

    if not found:
        return {
            "found": False,
            "error": (
                f"No relationship path found from '{src_node.name}' to "
                f"'{tgt_node.name}' within {max_depth} hops."
            ),
            "notes": notes,
        }

    path_ids: list[str] = []
    node_id: str | None = tgt_node.id
    while node_id is not None:
        path_ids.append(node_id)
        node_id = parent.get(node_id)
    path_ids.reverse()

    def _node_for(nid: str):
        if nid == src_node.id:
            return src_node
        edge = via.get(nid)
        return edge.node if edge is not None else None

    path: list[dict[str, Any]] = []
    for nid in path_ids:
        node = _node_for(nid)
        if node is not None:
            path.append(
                {
                    "id": node.id,
                    "name": node.name,
                    "label": node.label.value if node.label else "unknown",
                    "file_path": node.file_path,
                    "start_line": node.start_line,
                }
            )
        else:
            path.append({"id": nid, "name": nid, "label": "unknown",
                         "file_path": "", "start_line": 0})

    segments: list[dict[str, Any]] = []
    for i in range(len(path_ids) - 1):
        edge = via[path_ids[i + 1]]
        segments.append(
            {
                "rel_type": edge.rel_type,
                "confidence": edge.confidence,
                "direction": edge.direction,
            }
        )

    return {
        "found": True,
        "hops": len(path_ids) - 1,
        "path": path,
        "segments": segments,
        "notes": notes,
    }


def handle_trace(
    storage: StorageBackend,
    from_symbol: str,
    to_symbol: str,
    max_depth: int = 10,
    relations: list[str] | None = None,
) -> str:
    """Render :func:`compute_trace` as a human-readable MCP response.

    Where :func:`handle_call_path` walks CALLS only, caller→callee, this walks
    every semantic code relationship in BOTH directions and annotates each hop
    with its relation, direction and confidence.
    """
    result = compute_trace(storage, from_symbol, to_symbol, max_depth, relations)
    if not result["found"]:
        out = str(result["error"])
        if result.get("notes"):
            out += "\n\n" + "\n".join(result["notes"])
        return out

    path = result["path"]
    segments = result["segments"]
    # Arrow chain: `caller --calls--> helper <--imports-- config`.
    chain = [path[0]["name"]]
    for i, seg in enumerate(segments):
        tag = _confidence_tag(seg["confidence"])
        nxt_name = path[i + 1]["name"]
        if seg["direction"] == "out":
            chain.append(f"--{seg['rel_type']}{tag}--> {nxt_name}")
        else:
            chain.append(f"<--{seg['rel_type']}{tag}-- {nxt_name}")

    hop_count = result["hops"]
    lines = [
        f"  {i}. {n['name']} ({n['label'].title()}) — {n['file_path']}:{n['start_line']}"
        for i, n in enumerate(path, 1)
    ]
    header = f"Trace: {' '.join(chain)} ({hop_count} hop{'s' if hop_count != 1 else ''})"
    out = header + "\n\n" + "\n".join(lines)
    if result.get("notes"):
        out += "\n\n" + "\n".join(result["notes"])
    return out


def compute_insights(
    storage: StorageBackend, hub_limit: int = 8, bridge_limit: int = 8,
) -> dict[str, Any]:
    """Graph-shape insights as structured data (shared by MCP + the HTTP read-path).

    Surfaces the graph's **hubs** (highest-degree symbols — the "god objects"
    everything leans on), its **surprising connections** (edges that bridge two
    detected communities — a subsystem reaching directly into another), and a few
    **suggested questions** derived deterministically from those findings.
    """
    hubs = storage.get_node_degrees(list(TRACE_REL_TYPES), hub_limit)
    bridges = storage.get_cross_community_edges(list(TRACE_REL_TYPES), bridge_limit)

    hub_list = [
        {
            "id": n.id,
            "name": n.name,
            "label": n.label.value if n.label else "unknown",
            "file_path": n.file_path,
            "start_line": n.start_line,
            "degree": deg,
        }
        for n, deg in hubs
    ]
    bridge_list = [
        {
            "source": s.name,
            "target": t.name,
            "rel_type": rel,
            "source_community": sc,
            "target_community": tc,
            "source_id": s.id,
            "target_id": t.id,
        }
        for s, t, rel, sc, tc in bridges
    ]

    questions: list[str] = []
    if hub_list:
        top = hub_list[0]["name"]
        questions.append(f'What is the blast radius of {top}?  (horus blast-radius "{top}")')
    if bridge_list:
        b = bridge_list[0]
        questions.append(
            f'How is {b["source"]} connected to {b["target"]}?  '
            f'(horus trace "{b["source"]}" "{b["target"]}")'
        )
    if len(hub_list) > 1:
        questions.append(
            f'Why is {hub_list[1]["name"]} so heavily connected — is it doing too much?'
        )

    return {"hubs": hub_list, "bridges": bridge_list, "questions": questions}


def handle_insights(
    storage: StorageBackend, hub_limit: int = 8, bridge_limit: int = 8,
) -> str:
    """Render :func:`compute_insights` as a human-readable MCP response."""
    r = compute_insights(storage, hub_limit, bridge_limit)
    lines = ["Graph insights", ""]

    if r["hubs"]:
        lines.append("Hubs — most-connected symbols (degree):")
        for h in r["hubs"]:
            label = str(h["label"]).title()
            lines.append(
                f"  {h['degree']:>3}  {h['name']} ({label}) — {h['file_path']}:{h['start_line']}"
            )
    else:
        lines.append("Hubs: none (empty or unindexed graph).")

    lines.append("")
    if r["bridges"]:
        lines.append("Surprising connections — edges bridging communities:")
        for b in r["bridges"]:
            lines.append(
                f"  {b['source']} --{b['rel_type']}--> {b['target']}  "
                f"[{b['source_community']} → {b['target_community']}]"
            )
    else:
        lines.append("Surprising connections: none detected (run community detection first).")

    if r["questions"]:
        lines.append("")
        lines.append("Suggested questions:")
        for q in r["questions"]:
            lines.append(f"  • {q}")

    return "\n".join(lines)


def handle_communities(
    storage: StorageBackend, community: str | None = None
) -> str:
    """List communities or drill into a specific one."""
    if community:
        rows = storage.get_community_members(community)

        if not rows:
            return f"Community '{community}' not found or has no members."

        lines = [f"Community: {community}"]
        lines.append(f"Members ({len(rows)}):")
        lines.append("")
        for row in rows:
            name = row[0] or "?"
            label = row[1] or "Unknown"
            file_path = row[2] or "?"
            start_line = row[3] or 0
            is_entry = row[4] if len(row) > 4 else False
            is_exported = row[5] if len(row) > 5 else False
            tags = []
            if is_entry:
                tags.append("entry point")
            if is_exported:
                tags.append("exported")
            tag_str = f"  [{', '.join(tags)}]" if tags else ""
            lines.append(f"  - {name} ({label}) — {file_path}:{start_line}{tag_str}")

        return "\n".join(lines)

    rows = storage.get_communities_summary()

    if not rows:
        return "No communities detected. Run indexing with community detection enabled."

    lines = [f"Communities ({len(rows)} detected):"]
    lines.append("")
    for i, row in enumerate(rows, 1):
        name = row[0] or "?"
        cohesion = row[1] or 0.0
        props_raw = row[2] or "{}"
        try:
            props = json.loads(props_raw) if isinstance(props_raw, str) else props_raw
        except (json.JSONDecodeError, TypeError):
            props = {}
        symbol_count = props.get("symbol_count", "?")
        lines.append(f"  {i}. {name}  (cohesion: {cohesion:.2f}, {symbol_count} symbols)")

    cross_procs = storage.get_cross_community_processes()

    if cross_procs:
        lines.append("")
        lines.append("Cross-community processes:")
        for row in cross_procs:
            proc_name = row[0] or "?"
            comms = row[1] if len(row) > 1 else []
            comm_str = " → ".join(comms) if isinstance(comms, list) else str(comms)
            lines.append(f"  - {proc_name} ({comm_str})")

    return "\n".join(lines)


def handle_explain(storage: StorageBackend, symbol: str) -> str:
    """Produce a narrative explanation of a symbol."""
    if not symbol or not symbol.strip():
        return "Error: 'symbol' parameter is required and cannot be empty."

    results = _resolve_symbol(storage, symbol)
    if not results:
        return f"Symbol '{symbol}' not found."

    node = storage.get_node(results[0].node_id)
    if not node:
        return f"Symbol '{symbol}' not found."

    label_display = node.label.value.title() if node.label else "Unknown"
    lines = [f"Explanation: {node.name} ({label_display})"]
    lines.append("=" * 48)
    lines.append("")

    roles = []
    if node.is_entry_point:
        roles.append("Entry point")
    if node.is_exported:
        roles.append("Exported")
    if node.is_dead:
        roles.append("Dead code (unreachable)")
    if roles:
        lines.append(f"Role: {', '.join(roles)}")

    lines.append(f"Location: {node.file_path}:{node.start_line}-{node.end_line}")

    if node.signature:
        lines.append(f"Signature: {node.signature}")

    comm_names = storage.get_node_communities(node.id)
    if comm_names:
        lines.append(f"Community: {comm_names[0] or '?'}")

    lines.append("")

    callers = storage.get_callers_with_confidence(node.id)
    callees = storage.get_callees_with_confidence(node.id)

    if callers:
        caller_names = ", ".join(c.name for c, _ in callers[:5])
        suffix = f" (+{len(callers) - 5} more)" if len(callers) > 5 else ""
        lines.append(f"Called by {len(callers)}: {caller_names}{suffix}")
    else:
        lines.append("Called by: nothing (root or dead)")

    if callees:
        callee_names = ", ".join(c.name for c, _ in callees[:5])
        suffix = f" (+{len(callees) - 5} more)" if len(callees) > 5 else ""
        lines.append(f"Calls {len(callees)}: {callee_names}{suffix}")
    else:
        lines.append("Calls: nothing (leaf)")

    proc_names = storage.get_node_processes(node.id)
    if proc_names:
        lines.append("")
        lines.append("Process flows through this symbol:")
        for proc_name in proc_names:
            lines.append(f"  - {proc_name or '?'}")

    return "\n".join(lines)


def handle_review_risk(storage: StorageBackend, diff: str) -> str:
    """Assess PR risk by synthesizing multiple graph signals."""
    if not diff.strip():
        return "Empty diff provided."

    changed_files = _parse_diff_files(diff)
    if not changed_files:
        return "Could not parse any changed files from the diff."

    changed_file_set = set(changed_files.keys())
    all_affected_symbols: list[tuple[str, str, str, int]] = []
    entry_points_hit = 0
    total_dependents = 0

    for file_path, ranges in changed_files.items():
        if not _SAFE_PATH.match(file_path):
            continue
        for node in storage.get_symbols_in_file(file_path):
            node_id = node.id or ""
            name = node.name or ""
            start_line = node.start_line or 0
            end_line = node.end_line or 0
            label_prefix = node_id.split(":", 1)[0].title() if node_id else ""

            hit = any(start_line <= end and end_line >= start for start, end in ranges)
            if not hit:
                continue

            dep_count = len(storage.traverse_with_depth(node_id, 2, direction="callers"))
            if node.is_entry_point:
                entry_points_hit += 1

            total_dependents += dep_count
            all_affected_symbols.append((name, label_prefix, file_path, dep_count))

    missing_cochange: list[tuple[str, str, float]] = []
    for file_path in changed_files:
        if not _SAFE_PATH.match(file_path):
            continue
        for coupled_file, strength, _co_changes in storage.get_file_coupling(file_path):
            if strength >= 0.5 and coupled_file not in changed_file_set:
                missing_cochange.append((coupled_file, file_path, strength))

    communities_touched: set[str] = set()
    for name, label, file_path, _ in all_affected_symbols:
        node_id = f"{label.lower()}:{file_path}:{name}"
        for comm_name in storage.get_node_communities(node_id):
            if comm_name:
                communities_touched.add(comm_name)

    score = entry_points_hit + len(missing_cochange) + total_dependents // 10
    if len(communities_touched) > 1:
        score += 2
    score = min(score, 10)

    if score <= 3:
        level = "LOW"
    elif score <= 6:
        level = "MEDIUM"
    else:
        level = "HIGH"

    lines = ["PR Risk Assessment"]
    lines.append("=" * 48)
    lines.append(f"Risk: {level} (score: {score}/10)")
    lines.append("")

    if all_affected_symbols:
        lines.append(f"Changed symbols ({len(all_affected_symbols)}):")
        for name, label, fp, deps in all_affected_symbols:
            tags = []
            if deps > 0:
                tags.append(f"{deps} downstream dependents")
            tag_str = f"  [{', '.join(tags)}]" if tags else ""
            lines.append(f"  - {name} ({label}) — {fp}{tag_str}")
    else:
        lines.append("No indexed symbols in changed lines.")

    if missing_cochange:
        lines.append("")
        lines.append("⚠️ Missing co-change files (usually change together):")
        for missing, coupled_with, strength in missing_cochange:
            lines.append(f"  - {missing} (strength: {strength:.2f} with {coupled_with})")

    if len(communities_touched) > 1:
        lines.append("")
        lines.append(f"Community boundary crossings: {len(communities_touched)}")
        lines.append(f"  Spans: {', '.join(sorted(communities_touched))}")

    return "\n".join(lines)


def handle_file_context(storage: StorageBackend, file_path: str) -> str:
    """Provide comprehensive context for a single file."""
    if not file_path or not file_path.strip():
        return "Error: 'file_path' parameter is required and cannot be empty."

    file_path = file_path.strip()
    if not _SAFE_PATH.match(file_path):
        return "Error: file path contains unsafe characters."

    sym_nodes = storage.get_symbols_in_file(file_path)
    imports_out = storage.get_file_imports(file_path)
    imports_in = storage.get_file_importers(file_path)
    coupling_rows = storage.get_file_coupling(file_path)[:5]
    dead_nodes = [n for n in sym_nodes if n.is_dead]
    comm_rows = storage.get_file_community_counts(file_path)

    if not sym_nodes and not imports_out and not imports_in:
        return f"No data found for file '{file_path}'. Is it indexed?"

    lines = [f"File: {file_path}"]
    lines.append("=" * 48)

    if sym_nodes:
        lines.append("")
        lines.append(f"Symbols ({len(sym_nodes)}):")
        for node in sym_nodes:
            name = node.name or "?"
            label = node.label.value if node.label else "Unknown"
            tags = []
            if node.is_entry_point:
                tags.append("entry point")
            if node.is_exported:
                tags.append("exported")
            if node.is_dead:
                tags.append("dead")
            tag_str = f"  [{', '.join(tags)}]" if tags else ""
            lines.append(f"  - {name} ({label}) line {node.start_line}{tag_str}")

    if imports_out:
        lines.append("")
        lines.append(f"Imports ({len(imports_out)}): {', '.join(imports_out)}")

    if imports_in:
        lines.append(f"Imported by ({len(imports_in)}): {', '.join(imports_in)}")

    if coupling_rows:
        lines.append("")
        lines.append(f"Coupled files ({len(coupling_rows)}):")
        for coupled_path, strength, co_changes in coupling_rows:
            lines.append(
                f"  - {coupled_path or '?'}  strength: {strength:.2f}  co_changes: {co_changes}"
            )

    if dead_nodes:
        lines.append("")
        lines.append(f"Dead code ({len(dead_nodes)}):")
        for node in dead_nodes:
            label = node.label.value if node.label else "Unknown"
            lines.append(f"  - {node.name or '?'} ({label}) line {node.start_line}")

    if comm_rows:
        lines.append("")
        comm_parts = [f"{name} ({count} symbols)" for name, count in comm_rows if name]
        lines.append(f"Communities: {', '.join(comm_parts)}")

    return "\n".join(lines)


def handle_cycles(storage: StorageBackend, min_size: int = 2) -> str:
    """Detect circular dependencies using strongly connected components."""
    min_size = max(2, min_size)

    try:
        graph = storage.load_graph()
    except Exception as exc:
        return f"Error loading graph: {exc}"

    ig_graph, index_to_node_id = export_to_igraph(graph)

    if ig_graph.vcount() == 0:
        return "No symbols in the graph to analyze."

    sccs = ig_graph.connected_components(mode="strong")

    cycles = [
        list(component)
        for component in sccs
        if len(component) >= min_size
    ]

    if not cycles:
        return "No circular dependencies detected."

    cycles.sort(key=len, reverse=True)

    lines = [f"Circular Dependencies ({len(cycles)} groups)"]
    lines.append("=" * 48)

    for i, component in enumerate(cycles, 1):
        node_ids = [index_to_node_id[idx] for idx in component if idx in index_to_node_id]
        nodes = [graph.get_node(nid) for nid in node_ids]
        nodes = [n for n in nodes if n is not None]

        severity = "CRITICAL" if len(nodes) >= 5 else ""
        size_label = f" — {severity}" if severity else ""
        lines.append(f"\nCycle {i} ({len(nodes)} symbols){size_label}:")
        for node in nodes:
            label = node.label.value.title() if node.label else "Unknown"
            lines.append(
                f"  - {node.name} ({label}) — "
                f"{node.file_path}:{node.start_line}"
            )

    return "\n".join(lines)


def handle_test_impact(
    storage: StorageBackend,
    diff: str = "",
    symbols: list[str] | None = None,
) -> str:
    """Find tests likely affected by code changes."""
    changed_symbol_ids: list[tuple[str, str]] = []

    if diff and diff.strip():
        changed_files = _parse_diff_files(diff)
        for file_path, ranges in changed_files.items():
            if not _SAFE_PATH.match(file_path):
                continue
            for node in storage.get_symbols_in_file(file_path):
                start_line = node.start_line or 0
                end_line = node.end_line or 0
                hit = any(start_line <= end and end_line >= start for start, end in ranges)
                if hit:
                    changed_symbol_ids.append((node.id or "", node.name or ""))

    elif symbols:
        for sym_name in symbols:
            results = _resolve_symbol(storage, sym_name)
            if results:
                node = storage.get_node(results[0].node_id)
                if node:
                    changed_symbol_ids.append((node.id, node.name))

    else:
        return "Error: provide either 'diff' or 'symbols' parameter."

    if not changed_symbol_ids:
        return "No changed symbols found."

    test_hits: dict[str, list[tuple[str, str, int]]] = {}

    for sym_id, sym_name in changed_symbol_ids:
        for caller, depth in storage.traverse_with_depth(sym_id, 4, direction="callers"):
            if _is_test_file(caller.file_path):
                test_hits.setdefault(caller.file_path, []).append(
                    (caller.name, sym_name, depth)
                )

    if not test_hits:
        return (
            f"No test files found in the call graph of {len(changed_symbol_ids)} "
            f"changed symbol(s). Tests may not directly call these symbols."
        )

    lines = ["Test Impact Analysis"]
    lines.append("=" * 48)
    lines.append(f"Changed symbols: {len(changed_symbol_ids)}")
    lines.append("")

    direct_files: dict[str, list[tuple[str, str, int]]] = {}
    transitive_files: dict[str, list[tuple[str, str, int]]] = {}

    for test_file, hits in sorted(test_hits.items()):
        for test_name, source_sym, depth in hits:
            if depth <= 2:
                direct_files.setdefault(test_file, []).append((test_name, source_sym, depth))
            else:
                transitive_files.setdefault(test_file, []).append((test_name, source_sym, depth))

    total_tests = sum(len(v) for v in test_hits.values())

    if direct_files:
        lines.append(f"Affected tests ({total_tests}):")
        for test_file, hits in sorted(direct_files.items()):
            lines.append(f"  {test_file}:")
            seen = set()
            for test_name, source_sym, depth in hits:
                key = (test_name, source_sym)
                if key not in seen:
                    seen.add(key)
                    lines.append(f"    - {test_name} (calls: {source_sym})")
        lines.append("")

    if transitive_files:
        lines.append("Tests with indirect coverage (depth 3+):")
        for test_file, hits in sorted(transitive_files.items()):
            lines.append(f"  {test_file}:")
            seen = set()
            for test_name, source_sym, depth in hits:
                key = (test_name, source_sym)
                if key not in seen:
                    seen.add(key)
                    lines.append(f"    - {test_name} (transitive via: {source_sym})")

    return "\n".join(lines)
