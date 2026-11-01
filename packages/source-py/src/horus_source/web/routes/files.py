"""File tree and content routes."""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request

from horus_source.core.graph.model import NodeLabel
from horus_source.web.routes.graph import _serialize_node

logger = logging.getLogger(__name__)

router = APIRouter(tags=["files"])

_EXTENSION_LANGUAGE: dict[str, str] = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".php": "php",
    ".swift": "swift",
    ".kt": "kotlin",
    ".scala": "scala",
    ".sh": "bash",
    ".bash": "bash",
    ".zsh": "zsh",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".toml": "toml",
    ".xml": "xml",
    ".html": "html",
    ".css": "css",
    ".scss": "scss",
    ".sql": "sql",
    ".md": "markdown",
    ".txt": "text",
}


def _detect_language(file_path: str) -> str:
    suffix = Path(file_path).suffix.lower()
    return _EXTENSION_LANGUAGE.get(suffix, "")


@router.get("/tree")
def get_tree(request: Request) -> dict:
    """Build a nested folder tree from File and Folder nodes in the graph."""
    storage = request.app.state.storage

    try:
        file_rows = storage.get_file_nodes()
    except Exception:
        file_rows = []

    symbol_counts: dict[str, int] = {}
    try:
        symbol_counts = storage.get_symbol_counts_by_file()
    except Exception:
        pass

    root_children: dict[str, dict] = {}

    def _ensure_path(parts: list[str]) -> dict:
        """Walk the tree, creating folder nodes as needed, return the leaf parent."""
        current = root_children
        node = None
        for i, part in enumerate(parts[:-1]):
            if part not in current:
                folder_path = "/".join(parts[: i + 1])
                current[part] = {
                    "name": part,
                    "path": folder_path,
                    "type": "folder",
                    "language": None,
                    "symbolCount": 0,
                    "children": {},
                }
            node = current[part]
            current = node["children"]
        return current

    for row in file_rows or []:
        file_path = row[2] if len(row) > 2 else ""
        if not file_path:
            continue

        parts = file_path.split("/")
        language = row[3] if len(row) > 3 and row[3] else _detect_language(file_path)
        name = parts[-1] if parts else row[1]

        if len(parts) > 1:
            parent = _ensure_path(parts)
        else:
            parent = root_children

        parent[name] = {
            "name": name,
            "path": file_path,
            "type": "file",
            "language": language,
            "symbolCount": symbol_counts.get(file_path, 0),
            "children": {},
        }

    def _dict_to_list(children_dict: dict) -> list[dict]:
        result = []
        for node in sorted(children_dict.values(), key=lambda n: (n["type"] != "folder", n["name"])):
            entry = {
                "name": node["name"],
                "path": node["path"],
                "type": node["type"],
                "language": node.get("language"),
                "symbolCount": node.get("symbolCount", 0),
            }
            if node["children"]:
                entry["children"] = _dict_to_list(node["children"])
            elif node["type"] == "folder":
                entry["children"] = []
            result.append(entry)
        return result

    return {"tree": _dict_to_list(root_children)}


@router.get("/file")
def get_file(
    request: Request,
    path: str = Query(..., description="File path relative to repo root"),
) -> dict:
    """Read a file from the filesystem and return its content."""
    repo_path = request.app.state.repo_path
    if repo_path is None:
        raise HTTPException(status_code=400, detail="No repo_path configured")

    # Prevent path traversal — is_relative_to avoids the shared-prefix bypass
    # (e.g. /repo vs /repo-evil) that startswith() is vulnerable to.
    repo_root = Path(repo_path).resolve()
    resolved = (repo_root / path).resolve()
    if not resolved.is_relative_to(repo_root):
        raise HTTPException(status_code=400, detail="Path traversal not allowed")

    if not resolved.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    try:
        content = resolved.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {exc}") from exc

    return {
        "path": path,
        "content": content,
        "language": _detect_language(path),
    }


@router.get("/class-methods")
def get_class_methods(
    request: Request,
    file: str = Query(..., description="File path the class is defined in"),
    class_name: str = Query(..., alias="class", description="Class name to list methods for"),
) -> dict:
    """List the method symbols of *class* defined in *file*.

    Reuses :meth:`StorageBackend.get_symbols_in_file` and filters to method nodes
    whose ``class_name`` matches, ordered by ``start_line`` (the storage method's order).
    """
    storage = request.app.state.storage
    try:
        symbols = storage.get_symbols_in_file(file)
    except Exception as exc:
        logger.error("Class-methods query failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Class-methods query failed") from exc

    methods = [
        _serialize_node(sym)
        for sym in symbols
        if sym.label == NodeLabel.METHOD and sym.class_name == class_name
    ]
    return {"methods": methods}
