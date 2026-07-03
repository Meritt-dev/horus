"""Horus source intelligence CLI — Graph-powered code intelligence engine."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Optional

import anyio
import typer
import uvicorn
from mcp.client.streamable_http import streamablehttp_client
from mcp.server.stdio import stdio_server
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, TextColumn

from horus_source import __version__
from horus_source.core.diff import diff_branches, format_diff
from horus_source.core.embeddings.embedder import _DEFAULT_MODEL, EMBEDDING_SCHEME_VERSION
from horus_source.core.ingestion.pipeline import PipelineResult, run_pipeline
from horus_source.core.ingestion.watcher import ensure_current_embeddings, watch_repo
from horus_source.core.memory.vector_store import MemoryVectorStore
from horus_source.core.storage.base import EMBEDDING_DIMENSIONS, StorageBackend
from horus_source.core.storage.factory import (
    STORE_FORMAT_VERSION,
    backend_name,
    create_backend,
    legacy_kuzu_store_exists,
    prune_legacy_kuzu_store,
    store_path,
)

if TYPE_CHECKING:
    from horus_source.core.graph.graph import KnowledgeGraph
from horus_source.mcp import tools as mcp_tools
from horus_source.mcp.server import main as mcp_main
from horus_source.mcp.server import set_lock, set_storage
from horus_source.runtime import HorusRuntime
from horus_source.web import app as web_app_module

console = Console()
logger = logging.getLogger(__name__)
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8420
DEFAULT_MANAGED_PORT = 8421


def _source_dir(repo_path: Path) -> Path:
    """Return .horus/source/."""
    return repo_path / ".horus" / "source"


def _source_dir_existing(repo_path: Path) -> Path | None:
    """Return .horus/source/ if it exists, else None."""
    source_dir = repo_path / ".horus" / "source"
    if source_dir.exists():
        return source_dir
    return None


def _global_source_dir() -> Path:
    """Return ~/.horus/source/."""
    return Path.home() / ".horus" / "source"


def _load_storage(repo_path: Path | None = None) -> StorageBackend:  # noqa: F821
    target = (repo_path or Path.cwd()).resolve()
    source_dir = _source_dir_existing(target)
    if source_dir is None:
        console.print(
            f"[red]Error:[/red] No index found at {target}. Run 'horus-source analyze' first."
        )
        raise typer.Exit(code=1)
    db_path = store_path(source_dir)
    if not db_path.exists():
        console.print(
            f"[red]Error:[/red] No index found at {target}. Run 'horus-source analyze' first."
        )
        raise typer.Exit(code=1)

    storage = create_backend()
    storage.initialize(db_path, read_only=True)
    return storage


def _has_index_metadata(source_dir: Path) -> bool:
    return (source_dir / "meta.json").exists()


def _has_index_database(db_path: Path) -> bool:
    # SQLite stores are a single file; KùzuDB stores are a directory.
    if db_path.is_dir():
        return any(db_path.iterdir())
    return db_path.exists()


def _has_existing_index(source_dir: Path, db_path: Path) -> bool:
    return _has_index_metadata(source_dir) and _has_index_database(db_path)


def _maybe_notify_update(invoked_subcommand: str | None) -> None:
    """No-op since the backend ships INSIDE the horus bundle (no PyPI release).

    The horus CLI owns updates now: `horus update` installs the wheel bundled
    with the CLI. Checking PyPI here would nag about the frozen 2.x packages
    forever. Kept as a stub so the callback wiring stays intact.
    """
    del invoked_subcommand


def _register_in_global_registry(meta: dict, repo_path: Path) -> None:
    """Write meta.json into ``~/.horus/source/repos/{slug}/`` for multi-repo discovery.

    Slug is ``{repo_name}`` if that slot is unclaimed or already belongs to
    this repo.  Falls back to ``{repo_name}-{sha256(path)[:8]}`` on collision.
    """
    registry_root = _global_source_dir() / "repos"
    repo_name = repo_path.name

    candidate = registry_root / repo_name
    slug = repo_name
    if candidate.exists():
        existing_meta_path = candidate / "meta.json"
        try:
            existing = json.loads(existing_meta_path.read_text())
            if existing.get("path") != str(repo_path):
                short_hash = hashlib.sha256(str(repo_path).encode()).hexdigest()[:8]
                slug = f"{repo_name}-{short_hash}"
        except (json.JSONDecodeError, OSError):
            shutil.rmtree(candidate, ignore_errors=True)  # Clean broken slot before claiming

    # Remove any stale entry for the same repo_path under a different slug.
    if registry_root.exists():
        for old_dir in registry_root.iterdir():
            if not old_dir.is_dir() or old_dir.name == slug:
                continue
            old_meta = old_dir / "meta.json"
            try:
                old_data = json.loads(old_meta.read_text())
                if old_data.get("path") == str(repo_path):
                    shutil.rmtree(old_dir, ignore_errors=True)
            except (json.JSONDecodeError, OSError):
                continue

    slot = registry_root / slug
    slot.mkdir(parents=True, exist_ok=True)

    registry_meta = dict(meta)
    registry_meta["slug"] = slug
    (slot / "meta.json").write_text(
        json.dumps(registry_meta, indent=2) + "\n", encoding="utf-8"
    )


def _build_meta(result: "PipelineResult", repo_path: Path) -> dict:  # noqa: F821
    return {
        "version": __version__,
        "name": repo_path.name,
        "path": str(repo_path),
        # Store-format stamp (HOR-433): records which storage backend + on-disk layout
        # wrote this index so a later host start can detect a legacy/mismatched store
        # (e.g. a kùzu-era index opened by the SQLite backend) and rebuild it instead of
        # serving an empty/unsearchable store that never self-heals.
        "store_backend": backend_name(),
        "store_format_version": STORE_FORMAT_VERSION,
        "embedding_model": _DEFAULT_MODEL,
        "embedding_dimensions": EMBEDDING_DIMENSIONS,
        "embedding_scheme_version": EMBEDDING_SCHEME_VERSION,
        "stats": {
            "files": result.files,
            "symbols": result.symbols,
            "relationships": result.relationships,
            "clusters": result.clusters,
            "flows": result.processes,
            "dead_code": result.dead_code,
            "coupled_pairs": result.coupled_pairs,
            "embeddings": result.embeddings,
        },
        # False until the (possibly background) embedding phase persists vectors — lets the next
        # host start detect an interrupted index and re-embed instead of serving FTS-only (HOR-375).
        "embeddings_complete": result.embeddings > 0,
        "last_indexed_at": datetime.now(tz=timezone.utc).isoformat(),
    }


def _host_meta_path(repo_path: Path) -> Path:
    return repo_path / ".horus" / "source" / "host.json"


def _host_lease_dir(repo_path: Path) -> Path:
    return repo_path / ".horus" / "source" / "host-leases"


def _display_host(host: str) -> str:
    return "127.0.0.1" if host in {"0.0.0.0", "::"} else host


def _port_is_free(port: int, bind: str) -> bool:
    """Return True if *port* can be bound on *bind* right now.

    No ``SO_REUSEADDR`` on purpose: we want a port that is actively being
    listened on by another host process to register as taken so we move on
    to the next candidate.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((bind, port))
        except OSError:
            return False
    return True


def _os_assigned_port(bind: str) -> int:
    """Ask the OS for a free ephemeral port on *bind*."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((bind, 0))
        return sock.getsockname()[1]


def _find_free_port(preferred: int, bind: str, *, max_scan: int = 100) -> int:
    """Return a bindable TCP port, scanning upward from *preferred*.

    Concurrent per-repo hosts must coexist, so when the preferred port is
    already taken (another repo's host) we scan upward to the next free port
    instead of fighting over a single port forever. If the whole scan window
    is contended we fall back to an OS-assigned ephemeral port.
    """
    for candidate in range(preferred, preferred + max_scan):
        if _port_is_free(candidate, bind):
            return candidate
    return _os_assigned_port(bind)


def _bind_free_port(preferred: int, bind: str, *, max_scan: int = 100) -> socket.socket:
    """Bind and return a TCP socket on a free port, scanning upward from *preferred*.

    The returned socket is bound (held) but not yet listening — uvicorn calls
    ``listen()`` on it. Crucially, HOLDING the bound socket closes the
    check-then-release (TOCTOU) window in :func:`_find_free_port`: between
    selecting a free port and the server actually binding it, a concurrent host
    could otherwise grab that port. The host would then either crash or, worse,
    persist a ``host_url``/``port`` it never served while a DIFFERENT repo's host
    occupies the requested port — the cross-repo contamination this guards
    against. The actual bound port is read back from this socket and is the only
    port written to host.json (HOR-409).
    """
    last_err: OSError | None = None
    for candidate in range(preferred, preferred + max_scan):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            sock.bind((bind, candidate))
            return sock
        except OSError as exc:
            last_err = exc
            sock.close()
    # Whole scan window is contended — let the OS assign a free ephemeral port.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind((bind, 0))
    except OSError:
        sock.close()
        raise last_err if last_err is not None else OSError("no free port to bind")
    return sock


def _build_host_urls(host: str, port: int) -> tuple[str, str]:
    base = f"http://{_display_host(host)}:{port}"
    return base, f"{base}/mcp"


def _read_host_meta(repo_path: Path) -> dict | None:
    meta_path = _host_meta_path(repo_path)
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _write_host_meta(
    repo_path: Path,
    host_url: str,
    mcp_url: str,
    port: int,
    *,
    ui_enabled: bool,
) -> None:
    meta_path = _host_meta_path(repo_path)
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "pid": os.getpid(),
        "repo_path": str(repo_path),
        "host_url": host_url,
        "mcp_url": mcp_url,
        "port": port,
        "ui_enabled": ui_enabled,
        "leases_dir": str(_host_lease_dir(repo_path)),
    }
    meta_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _clear_host_meta(repo_path: Path) -> None:
    meta_path = _host_meta_path(repo_path)
    if meta_path.exists():
        meta_path.unlink(missing_ok=True)


def _create_host_lease(repo_path: Path, lease_type: str) -> Path:
    lease_dir = _host_lease_dir(repo_path)
    lease_dir.mkdir(parents=True, exist_ok=True)
    lease_path = lease_dir / f"{os.getpid()}-{uuid.uuid4().hex}.json"
    payload = {
        "pid": os.getpid(),
        "type": lease_type,
        "created_at": time.time(),
    }
    lease_path.write_text(json.dumps(payload), encoding="utf-8")
    return lease_path


def _remove_host_lease(lease_path: Path | None) -> None:
    if lease_path is not None:
        lease_path.unlink(missing_ok=True)


def _pid_is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _terminate_pid(pid: int, *, timeout: float = 5.0, poll_interval: float = 0.1) -> bool:
    """Terminate *pid*: SIGTERM first, then SIGKILL if it is still alive after *timeout*.

    Returns True once the process is gone (or was never alive). Escalating to
    SIGKILL is what finally reaps orphan hosts whose graceful uvicorn shutdown
    hangs on long-lived SSE (``/api/events``) connections — without it, ``stop``
    and ``--reap`` leave the process running and the user resorts to ``kill -9``
    (HOR-422).
    """
    if pid <= 0 or not _pid_is_alive(pid):
        return True

    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.kill(pid, sig)
        except OSError:
            return not _pid_is_alive(pid)
        deadline = time.time() + timeout
        while True:
            if not _pid_is_alive(pid):
                return True
            if time.time() >= deadline:
                break
            time.sleep(poll_interval)
    return not _pid_is_alive(pid)


def _port_from_url(url: str | None) -> int | None:
    if not url:
        return None
    try:
        return urllib.parse.urlsplit(url).port
    except ValueError:
        return None


def _process_is_horus_host(pid: int) -> bool:
    """Best-effort: does *pid*'s command line identify a horus-source host process?

    Used so port-based reaping only ever targets a Horus host — never an unrelated
    process that happens to hold the port.
    """
    try:
        result = subprocess.run(  # noqa: S603
            ["ps", "-p", str(pid), "-o", "command="],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=3.0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    command = result.stdout
    return "horus_source" in command or "horus-source" in command


def _pids_listening_on_port(port: int | None) -> list[int]:
    """Best-effort: pids of horus-source host processes LISTENING on *port* (via lsof).

    Returns ``[]`` when *port* is falsy, ``lsof`` is unavailable, or nothing matches.
    Results are filtered to actual horus-source hosts so an unrelated process that
    happens to occupy the port is never returned (and so never reaped). This lets the
    reaper terminate a fallback host by its ACTUAL bound port even when the recorded
    pid is stale (HOR-409).
    """
    if not port:
        return []
    try:
        result = subprocess.run(  # noqa: S603
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=3.0,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    pids: list[int] = []
    for token in result.stdout.split():
        try:
            pid = int(token)
        except ValueError:
            continue
        if pid == os.getpid() or pid in pids:
            continue
        if _process_is_horus_host(pid):
            pids.append(pid)
    return pids


def _serves_other_repo(host_url: str | None, repo_path: Path) -> bool:
    """True only when the host at *host_url* is reachable AND reports a DIFFERENT repo.

    A guard for port-based reaping: a record whose port now belongs to another repo's
    host (legacy/stale data) must never have that port reaped, or we would terminate a
    foreign repo's host — the exact contamination this work prevents (HOR-409). An
    unreachable host is NOT provably foreign, so this returns False and reaping proceeds
    (terminating an orphan that still holds the port).
    """
    if not host_url:
        return False
    try:
        with urllib.request.urlopen(f"{host_url}/api/host", timeout=1.0) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.URLError):
        return False
    served = payload.get("repoPath")
    return bool(served) and served != str(repo_path)


def _terminate_host_processes(meta: dict, repo_path: Path, *, timeout: float = 5.0) -> bool:
    """Terminate the host described by *meta*: the recorded server pid AND any horus host
    orphaned on its ACTUAL bound port.

    Targeting the actual bound port (read from ``host_url``) — never a requested/contended
    port — is what finally reaps a fallback host whose recorded pid went stale (the dogfood
    "N failed" hosts). Port-based reaping is skipped when that port is serving a DIFFERENT
    repo, so a foreign host is never killed (HOR-409). Returns True once every target is gone.
    """
    host_url = meta.get("host_url")
    pid = int(meta.get("pid", 0) or 0)
    targets: set[int] = set()
    if pid:
        targets.add(pid)
    port_pids = _pids_listening_on_port(_port_from_url(host_url))
    if port_pids and not _serves_other_repo(host_url, repo_path):
        targets.update(port_pids)
    return all(_terminate_pid(p, timeout=timeout) for p in targets) if targets else True


def _host_meta_is_consistent(meta: dict) -> bool:
    """An ownership record is consistent when its recorded port matches its host URL port.

    The HOR-422 symptom "Ownership record port (8420) does not match host URL
    port (8422)" is exactly this drift: the host re-bound to a scanned-up port
    but the recorded ``port`` field stayed at the original preference.
    """
    recorded = meta.get("port")
    url_port = _port_from_url(meta.get("host_url"))
    if recorded is None or url_port is None:
        return False
    try:
        return int(recorded) == int(url_port)
    except (TypeError, ValueError):
        return False


def _iter_registered_repo_paths() -> list[Path]:
    """Return every repo path known to the global registry (~/.horus/source/repos)."""
    registry_root = _global_source_dir() / "repos"
    if not registry_root.exists():
        return []
    paths: list[Path] = []
    for slot in registry_root.iterdir():
        if not slot.is_dir():
            continue
        try:
            data = json.loads((slot / "meta.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        repo_path = data.get("path")
        if repo_path:
            paths.append(Path(repo_path))
    return paths


def _stop_host(repo_path: Path, *, timeout: float = 5.0) -> str:
    """Terminate the host serving *repo_path* and deregister it.

    Returns ``"none"`` (no record), ``"stopped"``, or ``"failed"``. The host
    record is cleared regardless of whether a live process was found, so a stale
    ownership record never survives a stop (HOR-422).
    """
    meta = _read_host_meta(repo_path)
    if meta is None:
        return "none"
    terminated = _terminate_host_processes(meta, repo_path, timeout=timeout)
    _clear_host_meta(repo_path)
    return "stopped" if terminated else "failed"


def _reap_host_meta(repo_path: Path, *, timeout: float = 5.0) -> str:
    """Reconcile a host ownership record, clearing it when stale.

    A live, consistent record is left untouched (``"alive"``). A record whose
    pid is dead is simply removed. A record whose recorded port disagrees with
    its host URL port is treated as corrupt ownership: the (possibly orphaned)
    process is terminated and the record cleared so the next start re-binds
    cleanly (HOR-422). Returns ``"none"``, ``"alive"``, or ``"reaped"``.
    """
    meta = _read_host_meta(repo_path)
    if meta is None:
        return "none"
    pid = int(meta.get("pid", 0) or 0)
    alive = _pid_is_alive(pid) if pid else False
    consistent = _host_meta_is_consistent(meta)
    if alive and consistent:
        return "alive"
    # Stale or corrupt record: terminate the recorded server pid AND any orphan still
    # holding the actual bound port (never a foreign repo's host), then clear it so the
    # next start re-binds cleanly (HOR-409 / HOR-422).
    _terminate_host_processes(meta, repo_path, timeout=timeout)
    _clear_host_meta(repo_path)
    return "reaped"


def _count_live_host_leases(repo_path: Path) -> int:
    lease_dir = _host_lease_dir(repo_path)
    if not lease_dir.exists():
        return 0
    live = 0
    for lease_path in lease_dir.glob("*.json"):
        try:
            payload = json.loads(lease_path.read_text(encoding="utf-8"))
            pid = int(payload.get("pid", 0))
        except (ValueError, json.JSONDecodeError, OSError):
            lease_path.unlink(missing_ok=True)
            continue
        if _pid_is_alive(pid):
            live += 1
        else:
            lease_path.unlink(missing_ok=True)
    return live


def _is_host_alive(meta: dict, repo_path: Path) -> bool:
    host_url = meta.get("host_url")
    if not host_url:
        return False
    try:
        with urllib.request.urlopen(f"{host_url}/api/host", timeout=1.0) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode("utf-8"))
            return payload.get("repoPath") == str(repo_path)
    except (OSError, ValueError, urllib.error.URLError):
        return False


def _get_live_host_info(repo_path: Path) -> dict | None:
    meta = _read_host_meta(repo_path)
    if meta is None:
        return None
    if _is_host_alive(meta, repo_path):
        return meta
    return None


def _start_host_background(
    repo_path: Path,
    *,
    port: int = DEFAULT_PORT,
    bind: str = DEFAULT_HOST,
    watch: bool = True,
    managed: bool = False,
) -> None:
    """Start a detached shared host process in the background."""
    command = [
        sys.executable,
        "-m",
        "horus_source.cli.main",
        "host",
        "--port",
        str(port),
        "--bind",
        bind,
        "--no-open",
    ]
    if watch:
        command.append("--watch")
    else:
        command.append("--no-watch")
    if managed:
        command.append("--managed")
    with open(os.devnull, "wb") as devnull:
        subprocess.Popen(  # noqa: S603
            command,
            cwd=repo_path,
            stdout=devnull,
            stderr=devnull,
            start_new_session=True,
        )


def _ensure_host_running(
    repo_path: Path,
    *,
    port: int = DEFAULT_PORT,
    bind: str = DEFAULT_HOST,
    watch: bool = True,
    timeout_seconds: float = 10.0,
    managed: bool = False,
) -> dict:
    """Return live host metadata, starting the shared host if necessary."""
    live_host = _get_live_host_info(repo_path)
    if live_host is not None:
        return live_host

    _start_host_background(repo_path, port=port, bind=bind, watch=watch, managed=managed)
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        live_host = _get_live_host_info(repo_path)
        if live_host is not None:
            return live_host
        time.sleep(0.2)
    raise RuntimeError("Timed out waiting for source-intelligence host to start.")


app = typer.Typer(
    name="horus-source",
    help="Horus source intelligence — Graph-powered code intelligence engine.",
    no_args_is_help=True,
)

def _version_callback(value: bool) -> None:
    if value:
        console.print(f"Horus source intelligence v{__version__}")
        raise typer.Exit()

@app.callback()
def main(
    ctx: typer.Context,
    version: Optional[bool] = typer.Option(  # noqa: N803
        None,
        "--version",
        "-v",
        help="Show version and exit.",
        callback=_version_callback,
        is_eager=True,
    ),
) -> None:
    """Horus source intelligence — Graph-powered code intelligence engine."""
    _maybe_notify_update(ctx.invoked_subcommand)


def _initialize_writable_storage(
    repo_path: Path, *, auto_index: bool = True, defer_embeddings: bool = False,
) -> tuple[StorageBackend, Path, Path]:  # noqa: F821
    """Open the repo database in read-write mode.

    If *auto_index* is False and no index exists, raises typer.Exit instead of
    running the pipeline — callers like ``ui`` should tell the user to run
    ``horus-source analyze .`` themselves.

    A corrupt database is detected on open and recreated empty (then re-indexed)
    instead of crashing (HOR-409).

    When *defer_embeddings* is True the synchronous re-embed of an interrupted index
    is skipped so the host can start serving immediately; the caller is responsible
    for finishing embeddings in the background (see ``_run_shared_host``).
    """
    source_dir = _source_dir(repo_path)
    db_path = store_path(source_dir)

    if not auto_index and not _has_existing_index(source_dir, db_path):
        console.print(
            "[red]Error:[/red] No index found. Run [cyan]horus-source analyze .[/cyan] first to index this codebase."
        )
        raise typer.Exit(code=1)

    source_dir.mkdir(parents=True, exist_ok=True)

    storage = create_backend()
    storage.initialize(db_path, recover_corrupt=True)

    # A recreated-from-corruption database is empty, so its stale meta.json no longer
    # describes any indexed data — drop it and re-index from scratch.
    if storage.recreated_due_to_corruption:
        console.print(
            "[yellow]Index database was corrupt — rebuilding from source.[/yellow]"
        )
        meta_path = source_dir / "meta.json"
        try:
            meta_path.unlink()
        except OSError:
            pass

    if not _has_index_metadata(source_dir):
        console.print("[bold]Running initial index...[/bold]")
        _, result = run_pipeline(repo_path, storage)
        meta = _build_meta(result, repo_path)
        meta_path = source_dir / "meta.json"
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        try:
            _register_in_global_registry(meta, repo_path)
        except Exception:
            logger.debug("Failed to register repo in global registry", exc_info=True)
    elif not defer_embeddings:
        ensure_current_embeddings(storage, repo_path)

    return storage, source_dir, db_path


async def _proxy_stdio_to_http_mcp(mcp_url: str) -> None:
    """Bridge a local stdio MCP session to the shared HTTP MCP host."""
    async with stdio_server() as (local_read, local_write):
        async with streamablehttp_client(mcp_url) as (remote_read, remote_write, _):
            async def _forward(reader, writer) -> None:
                async with writer:
                    async for message in reader:
                        await writer.send(message)

            async with anyio.create_task_group() as tg:
                tg.start_soon(_forward, local_read, remote_write)
                tg.start_soon(_forward, remote_read, local_write)


def _run_shared_host(
    *,
    port: int,
    bind: str,
    no_open: bool,
    watch: bool,
    dev: bool,
    managed: bool,
    open_browser: bool,
    announce_ui: bool,
    announce_mcp: bool,
    expose_ui: bool,
    already_running_message: str,
    auto_index: bool = True,
) -> None:
    """Run the shared Horus host with configurable UX messaging."""
    repo_path = Path.cwd().resolve()
    live_host = _get_live_host_info(repo_path)
    if live_host is not None:
        console.print(already_running_message.format(url=live_host["host_url"]))
        if open_browser and not no_open:
            webbrowser.open(live_host["host_url"])
        return

    # Open the DB cheaply WITHOUT running the heavy index/embed work here: gating the
    # port bind on a fresh index or full re-embed of a large repo (e.g. reflex, ~18min)
    # exceeds the CLI health window, so the host never becomes reachable and the
    # contended-port loop reappears (HOR-409 / HOR-425). All heavy work is deferred to a
    # background thread below — the port binds and /api/host answers immediately (reporting
    # ``indexing`` until it lands), serving lexical/FTS search while semantic search warms up.
    storage, db_path, needs_index = _open_host_storage(repo_path, auto_index=auto_index)

    # Allocate a free port per host so concurrent per-repo hosts coexist. The
    # requested ``port`` is only a starting preference — if it is already taken
    # (another repo's host) we scan upward instead of looping on the same port.
    # We BIND and HOLD the socket here (not check-then-release), then read the
    # ACTUAL bound port back off it and hand the same socket to uvicorn below.
    # This closes the window where the requested port could be recorded but never
    # served (or grabbed by another repo's host between selection and bind): the
    # only port ever written to host.json / host_url is the one we truly hold —
    # so a repo's CLI can never be pointed at a stale host serving another repo
    # (the cross-repo contamination this fixes — HOR-409).
    sock = _bind_free_port(port, bind)
    port = sock.getsockname()[1]
    host_url, mcp_url = _build_host_urls(bind, port)

    # The host is the SOLE RW owner of the dedicated, code-graph-isolated memory
    # vector dir (``.horus/source/memory``). Opening it RW here keeps the
    # read_only=True invariant on every other surface (RO web/MCP/CLI fallbacks).
    # Best-effort: if it cannot be opened the host still serves code intelligence,
    # and the memory routes stay absent so the TS client degrades to lexical recall.
    memory_store: MemoryVectorStore | None = MemoryVectorStore()
    try:
        memory_store.initialize(MemoryVectorStore.db_path_for_repo(repo_path))
    except Exception:
        logger.warning("Memory vector store unavailable — semantic memory recall disabled", exc_info=True)
        memory_store = None

    lock = asyncio.Lock()
    runtime = HorusRuntime(
        storage=storage,
        repo_path=repo_path,
        watch=watch,
        lock=lock,
        host_url=host_url,
        mcp_url=mcp_url,
        owns_storage=True,
        memory_store=memory_store,
        # Heavy index/embed work runs in the background after bind (HOR-425). A fresh
        # index is always pending; an existing index may still need an interrupted
        # re-embed finished. ``_run_host_indexing`` clears this when the work lands.
        indexing=True,
    )
    set_storage(storage)
    set_lock(lock)

    is_loopback = bind in {"127.0.0.1", "::1", "localhost"}
    if not is_loopback:
        # A non-loopback bind exposes the API, the /mcp transport, and the SQL
        # console to the network. Say so loudly — don't let _display_host's
        # 127.0.0.1 rewrite hide it — and relax Host-header validation since the
        # operator has explicitly opted into non-localhost access.
        console.print(
            f"[bold yellow]⚠ Horus is bound to {bind} — reachable from the network, "
            f"not just this machine.[/bold yellow] The API, MCP endpoint, and SQL "
            f"console have no authentication. Bind 127.0.0.1 unless you intend LAN access."
        )

    web_app = web_app_module.create_app(
        db_path=db_path,
        repo_path=repo_path,
        watch=watch,
        dev=dev,
        runtime=runtime,
        mount_mcp=True,
        host_url=host_url,
        mcp_url=mcp_url,
        mount_frontend=expose_ui,
        strict_host=is_loopback,
    )

    if open_browser and not no_open:
        threading.Timer(1.0, lambda: webbrowser.open(host_url)).start()

    if announce_ui:
        console.print(f"[bold green]Horus UI[/bold green] running at {host_url}")
    if announce_mcp:
        console.print(f"[dim]HTTP MCP endpoint:[/dim] {mcp_url}")
    if watch:
        console.print("[dim]File watching enabled[/dim]")
    if dev:
        console.print("[dim]Dev mode — proxying to Vite on :5173[/dim]")

    _write_host_meta(repo_path, host_url, mcp_url, port, ui_enabled=expose_ui)

    # Run the (initial index and/or interrupted re-embed) in the background AFTER the
    # server below binds, so it never blocks the port bind or host health (HOR-425).
    # Shares the host's storage handle; KuzuBackend serializes access via its internal
    # lock, so concurrent request handlers stay correct (HOR-409).
    threading.Thread(
        target=_run_host_indexing,
        args=(storage, repo_path, needs_index, runtime),
        daemon=True,
    ).start()

    async def _run() -> None:
        config = uvicorn.Config(
            web_app,
            host=bind,
            port=port,
            log_level="warning",
        )
        server = uvicorn.Server(config)
        stop = asyncio.Event()

        async def _serve() -> None:
            # Serve on the pre-bound socket we are holding, so uvicorn listens on the
            # EXACT port already recorded in host.json — no re-bind, no second chance
            # for another host to take it (HOR-409).
            await server.serve(sockets=[sock])
            stop.set()

        async def _managed_shutdown() -> None:
            if not managed:
                return
            idle_started_at: float | None = None
            while not stop.is_set():
                live_leases = _count_live_host_leases(repo_path)
                if live_leases == 0:
                    if idle_started_at is None:
                        idle_started_at = time.time()
                    elif time.time() - idle_started_at >= 2.0:
                        server.should_exit = True
                        stop.set()
                        return
                else:
                    idle_started_at = None
                await asyncio.sleep(0.5)

        tasks = [_serve()]
        if watch:
            tasks.append(watch_repo(repo_path, storage, stop_event=stop, lock=lock))
        if managed:
            tasks.append(_managed_shutdown())
        await asyncio.gather(*tasks)

    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass
    finally:
        _clear_host_meta(repo_path)
        storage.close()
        if memory_store is not None:
            memory_store.close()
        # uvicorn closes the socket on shutdown; close again defensively in case we never
        # reached serve() (e.g. startup error). A double close is harmless.
        try:
            sock.close()
        except OSError:
            pass

def _run_startup_reembed(storage: StorageBackend, repo_path: Path) -> None:  # noqa: F821
    """Re-embed an interrupted/incomplete index off the host's startup path.

    Runs in a daemon thread so the host can become healthy immediately rather than
    gating health on a full re-embed of a large repo (HOR-409). ``ensure_current_embeddings``
    is a no-op when the index is already complete and up to date.
    """
    try:
        if ensure_current_embeddings(storage, repo_path):
            logger.info("Background re-embed complete — semantic search restored")
    except Exception:
        logger.warning(
            "Background re-embed failed — semantic search may be degraded", exc_info=True,
        )


def _read_source_meta(source_dir: Path) -> dict | None:
    """Read ``.horus/source/meta.json`` as a dict, or ``None`` if absent/unreadable."""
    meta_path = source_dir / "meta.json"
    if not meta_path.exists():
        return None
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        logger.debug("Failed to read meta.json at %s", meta_path, exc_info=True)
        return None


def _detect_stale_host_index(
    source_dir: Path, storage: StorageBackend, meta: dict | None,  # noqa: F821
) -> str | None:
    """Return a reason the existing index must be FULLY rebuilt on host start, else ``None``.

    Guards the 2.0 upgrade path (HOR-433). A pre-existing kùzu-era (or otherwise
    backend-mismatched) store leaves the active SQLite store empty / with 0 embeddings
    while meta still records symbols. The host would then serve an unsearchable index that
    never self-heals (only ``rm -rf .horus`` recovered it), because the embeddings-only
    refresh loads an empty graph and silently marks the index complete.

    Detection is conservative: a HEALTHY index (real symbols + embeddings, matching
    backend stamp, no legacy store) returns ``None`` and is NEVER rebuilt. Only genuinely
    stale/legacy/broken stores trigger a rebuild.
    """
    active = backend_name()

    # (a) A legacy KùzuDB store directory is present while the active backend is SQLite:
    #     the real graph lives in the kùzu store; the active store is empty/wrong.
    if legacy_kuzu_store_exists(source_dir):
        return "legacy KùzuDB store present"

    if meta is None:
        return None

    # (b) Store-backend stamp mismatch: meta was written by a DIFFERENT backend than the
    #     one we are opening (e.g. a "kuzu" stamp under the SQLite backend). An ABSENT
    #     stamp is a pre-HOR-433 index — only treated as stale when the store is ALSO
    #     unhealthy (caught by (c)); a healthy unstamped store is backfilled, not rebuilt.
    stamped = meta.get("store_backend")
    if stamped is not None and stamped != active:
        return f"store backend changed ({stamped} -> {active})"

    # (c) The store serves 0 embeddings while meta records symbols. The embeddings-only
    #     refresh cannot rebuild missing symbols, so force a full re-extract+re-embed.
    meta_symbols = int((meta.get("stats") or {}).get("symbols") or 0)
    if meta_symbols > 0:
        try:
            store_embeddings = storage.count_embeddings()
        except Exception:
            logger.debug("count_embeddings failed during staleness check", exc_info=True)
            return None
        if store_embeddings == 0:
            return f"store reports 0 embeddings but meta records {meta_symbols} symbols"

    return None


def _backfill_store_backend_stamp(source_dir: Path, meta: dict) -> None:
    """Add the missing ``store_backend``/``store_format_version`` stamp to a healthy index.

    A pre-HOR-433 index has no backend stamp but is otherwise fine — backfill the stamp so
    future host starts skip the staleness check WITHOUT a spurious re-index.
    """
    meta["store_backend"] = backend_name()
    meta.setdefault("store_format_version", STORE_FORMAT_VERSION)
    try:
        (source_dir / "meta.json").write_text(
            json.dumps(meta, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        logger.debug("Failed to backfill store_backend stamp", exc_info=True)


def _open_host_storage(
    repo_path: Path, *, auto_index: bool,
) -> tuple[StorageBackend, Path, bool]:  # noqa: F821
    """Open the repo DB for the shared host WITHOUT doing heavy index/embed work.

    Returns ``(storage, db_path, needs_index)``. ``needs_index`` is True when no
    index metadata exists yet (a fresh repo). The actual indexing and embedding
    is deferred to ``_run_host_indexing`` so the host binds its port and serves
    /api/host immediately rather than blocking startup for minutes (HOR-425).

    A corrupt database is detected on open and recreated empty (HOR-409); its
    stale meta.json is dropped so the repo is treated as needing a fresh index.
    """
    source_dir = _source_dir(repo_path)
    db_path = store_path(source_dir)

    if not auto_index and not _has_existing_index(source_dir, db_path):
        console.print(
            "[red]Error:[/red] No index found. Run "
            "[cyan]horus-source analyze .[/cyan] first to index this codebase."
        )
        raise typer.Exit(code=1)

    source_dir.mkdir(parents=True, exist_ok=True)

    storage = create_backend()
    storage.initialize(db_path, recover_corrupt=True)

    if storage.recreated_due_to_corruption:
        console.print(
            "[yellow]Index database was corrupt — rebuilding from source.[/yellow]"
        )
        try:
            (source_dir / "meta.json").unlink()
        except OSError:
            pass

    needs_index = not _has_index_metadata(source_dir)

    # HOR-433 upgrade self-heal: a pre-existing kùzu-era / backend-mismatched / broken
    # store can leave the active SQLite store empty or with 0 embeddings while meta still
    # records symbols. Detect that BEFORE deciding to reuse the index and force a FULL
    # re-extract+re-embed (run_pipeline) — not the embeddings-only refresh, which can't
    # rebuild missing symbols. A healthy index is left untouched (no spurious re-index);
    # a healthy-but-unstamped index just gets its store_backend stamp backfilled.
    if not needs_index:
        meta = _read_source_meta(source_dir)
        reason = _detect_stale_host_index(source_dir, storage, meta)
        if reason is not None:
            console.print(
                f"[yellow]Existing index is stale ({reason}) — re-indexing from source.[/yellow]"
            )
            logger.warning("Host start: rebuilding stale index — %s", reason)
            prune_legacy_kuzu_store(source_dir)
            try:
                (source_dir / "meta.json").unlink()
            except OSError:
                pass
            needs_index = True
        elif meta is not None and meta.get("store_backend") is None:
            _backfill_store_backend_stamp(source_dir, meta)

    return storage, db_path, needs_index


def _run_host_indexing(
    storage: StorageBackend,  # noqa: F821
    repo_path: Path,
    needs_index: bool,
    runtime: HorusRuntime,
) -> None:
    """Finish index/embed work after the host has bound its port (HOR-425).

    Runs in a daemon thread: a fresh repo gets its initial pipeline here, an
    existing-but-interrupted index gets its re-embed finished here. The host
    serves /api/host and lexical search throughout (with ``indexing=True``), and
    semantic search lights up once this lands. Clears ``runtime.indexing`` on the
    way out so clients stop reporting "indexing in progress".
    """
    try:
        if needs_index:
            _, result = run_pipeline(repo_path, storage)
            meta = _build_meta(result, repo_path)
            (_source_dir(repo_path) / "meta.json").write_text(
                json.dumps(meta, indent=2) + "\n", encoding="utf-8"
            )
            try:
                _register_in_global_registry(meta, repo_path)
            except Exception:
                logger.debug("Failed to register repo in global registry", exc_info=True)
            logger.info("Background initial index complete")
        elif ensure_current_embeddings(storage, repo_path):
            logger.info("Background re-embed complete — semantic search restored")
    except Exception:
        logger.warning(
            "Background host indexing failed — search may be degraded", exc_info=True,
        )
    finally:
        runtime.indexing = False


def _run_background_embeddings(
    graph: "KnowledgeGraph",
    db_path: Path,
    meta_path: Path,
    repo_path: Path,
) -> None:
    """Generate embeddings in a background thread with its own storage connection."""
    from horus_source.core.ingestion.pipeline import PipelineResult, _run_embedding_phase

    bg_storage = create_backend()
    bg_storage.initialize(db_path)
    try:
        bg_result = PipelineResult()
        _run_embedding_phase(graph, bg_storage, bg_result, lambda _phase, _pct: None)

        # Update meta.json with embedding count + mark complete (HOR-375) — the index is only
        # fully built once the background embeddings persist.
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["stats"]["embeddings"] = bg_result.embeddings
            meta["embeddings_complete"] = True
            meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        except Exception:
            logger.debug("Failed to update meta.json with embedding count", exc_info=True)

        if bg_result.embeddings > 0:
            console.print(
                f"[dim]Background embeddings complete: {bg_result.embeddings} vectors generated.[/dim]"
            )
    except Exception:
        logger.warning("Background embedding failed — semantic search unavailable", exc_info=True)
    finally:
        bg_storage.close()


@app.command()
def analyze(
    path: Path = typer.Argument(Path("."), help="Path to the repository to index."),
    no_embeddings: bool = typer.Option(False, "--no-embeddings", help="Skip vector embedding generation."),
    foreground_embeddings: bool = typer.Option(
        False, "--foreground-embeddings", help="Generate embeddings synchronously instead of in the background.",
    ),
) -> None:
    """Index a repository into a knowledge graph."""
    repo_path = path.resolve()
    if not repo_path.is_dir():
        console.print(f"[red]Error:[/red] {repo_path} is not a directory.")
        raise typer.Exit(code=1)

    console.print(f"[bold]Indexing[/bold] {repo_path}")

    source_dir = _source_dir(repo_path)
    source_dir.mkdir(parents=True, exist_ok=True)
    # Ignore + delete any legacy .horus/source/kuzu store (no lossy conversion):
    # a fresh analyze re-indexes and re-embeds into the SQLite store (HOR-392).
    if prune_legacy_kuzu_store(source_dir):
        console.print("[dim]Removed a legacy KùzuDB store; re-indexing into SQLite.[/dim]")
    db_path = store_path(source_dir)

    storage = create_backend()
    storage.initialize(db_path)

    # Run pipeline: skip embeddings here if we'll do them in the background.
    run_embeddings_inline = foreground_embeddings and not no_embeddings

    result: PipelineResult | None = None
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task("Starting...", total=None)

        def on_progress(phase: str, pct: float) -> None:
            progress.update(task, description=f"{phase} ({pct:.0%})")

        graph, result = run_pipeline(
            repo_path=repo_path,
            storage=storage,
            progress_callback=on_progress,
            embeddings=run_embeddings_inline,
        )

    meta = _build_meta(result, repo_path)
    meta_path = source_dir / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    try:
        _register_in_global_registry(meta, repo_path)
    except Exception:
        logger.debug("Failed to register repo in global registry", exc_info=True)

    storage.close()

    # Launch background embedding thread if needed.
    if not no_embeddings and not run_embeddings_inline:
        embed_thread = threading.Thread(
            target=_run_background_embeddings,
            args=(graph, db_path, meta_path, repo_path),
            daemon=True,
        )
        embed_thread.start()

    console.print()
    console.print("[bold green]Indexing complete.[/bold green]")
    console.print(f"  Files:          {result.files}")
    console.print(f"  Symbols:        {result.symbols}")
    console.print(f"  Relationships:  {result.relationships}")
    if result.clusters > 0:
        console.print(f"  Clusters:       {result.clusters}")
    if result.processes > 0:
        console.print(f"  Flows:          {result.processes}")
    if result.dead_code > 0:
        console.print(f"  Dead code:      {result.dead_code}")
    if result.coupled_pairs > 0:
        console.print(f"  Coupled pairs:  {result.coupled_pairs}")
    if run_embeddings_inline and result.embeddings > 0:
        console.print(f"  Embeddings:     {result.embeddings}")
    elif not no_embeddings and not run_embeddings_inline:
        console.print("  Embeddings:     [dim]generating in background...[/dim]")
    console.print(f"  Duration:       {result.duration_seconds:.2f}s")

    # Wait for background embeddings to finish before exiting.
    if not no_embeddings and not run_embeddings_inline:
        embed_thread.join()

@app.command()
def status() -> None:
    """Show index status for current repository."""
    repo_path = Path.cwd().resolve()
    source_dir = _source_dir_existing(repo_path)
    if source_dir is None:
        console.print(
            "[red]Error:[/red] No index found. Run [cyan]horus-source analyze .[/cyan] first to index this codebase."
        )
        raise typer.Exit(code=1)
    meta_path = source_dir / "meta.json"

    if not meta_path.exists():
        console.print(
            "[red]Error:[/red] No index found. Run [cyan]horus-source analyze .[/cyan] first to index this codebase."
        )
        raise typer.Exit(code=1)

    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    stats = meta.get("stats", {})

    console.print(f"[bold]Index status for[/bold] {repo_path}")
    console.print(f"  Version:        {meta.get('version', '?')}")
    console.print(f"  Last indexed:   {meta.get('last_indexed_at', '?')}")
    console.print(f"  Files:          {stats.get('files', '?')}")
    console.print(f"  Symbols:        {stats.get('symbols', '?')}")
    console.print(f"  Relationships:  {stats.get('relationships', '?')}")

    if stats.get("clusters", 0) > 0:
        console.print(f"  Clusters:       {stats['clusters']}")
    if stats.get("flows", 0) > 0:
        console.print(f"  Flows:          {stats['flows']}")
    if stats.get("dead_code", 0) > 0:
        console.print(f"  Dead code:      {stats['dead_code']}")
    if stats.get("coupled_pairs", 0) > 0:
        console.print(f"  Coupled pairs:  {stats['coupled_pairs']}")

@app.command(name="list")
def list_repos() -> None:
    """List all indexed repositories."""
    result = mcp_tools.handle_list_repos()
    console.print(result)

@app.command()
def clean(
    force: bool = typer.Option(False, "--force", "-f", help="Skip confirmation prompt."),
) -> None:
    """Delete index for current repository."""
    repo_path = Path.cwd().resolve()
    source_dir = _source_dir_existing(repo_path)

    if source_dir is None:
        console.print(
            f"[red]Error:[/red] No index found at {repo_path}. Nothing to clean."
        )
        raise typer.Exit(code=1)

    if not force:
        confirm = typer.confirm(f"Delete index at {source_dir}?")
        if not confirm:
            console.print("Aborted.")
            raise typer.Exit()

    shutil.rmtree(source_dir)
    console.print(f"[green]Deleted[/green] {source_dir}")

@app.command()
def query(
    q: str = typer.Argument(..., help="Search query for the knowledge graph."),
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum number of results."),
) -> None:
    """Search the knowledge graph."""
    storage = _load_storage()
    result = mcp_tools.handle_query(storage, q, limit=limit)
    console.print(result)
    storage.close()

@app.command()
def context(
    name: str = typer.Argument(..., help="Symbol name to inspect."),
) -> None:
    """Show 360-degree view of a symbol."""
    storage = _load_storage()
    result = mcp_tools.handle_context(storage, name)
    console.print(result)
    storage.close()

@app.command()
def impact(
    target: str = typer.Argument(..., help="Symbol to analyze blast radius for."),
    depth: int = typer.Option(3, "--depth", "-d", min=1, max=10, help="Traversal depth (1-10)."),
) -> None:
    """Show blast radius of changing a symbol."""
    storage = _load_storage()
    result = mcp_tools.handle_impact(storage, target, depth=depth)
    console.print(result)
    storage.close()

@app.command(name="dead-code")
def dead_code() -> None:
    """List all detected dead code."""
    storage = _load_storage()
    result = mcp_tools.handle_dead_code(storage)
    console.print(result)
    storage.close()

@app.command()
def cypher(
    query: str = typer.Argument(..., help="Raw Cypher query to execute."),
) -> None:
    """Execute raw Cypher against the knowledge graph."""
    storage = _load_storage()
    result = mcp_tools.handle_cypher(storage, query)
    console.print(result)
    storage.close()

@app.command()
def setup(
    claude: bool = typer.Option(False, "--claude", help="Configure MCP for Claude Code."),
    cursor: bool = typer.Option(False, "--cursor", help="Configure MCP for Cursor."),
) -> None:
    """Configure MCP for Claude Code / Cursor."""
    stdio_config = {
        "command": "horus-source",
        "args": ["serve", "--watch"],
    }

    if claude or (not claude and not cursor):
        console.print("[bold]Claude Code[/bold]")
        console.print("Add to your [cyan].mcp.json[/cyan] or [cyan]~/.claude.json[/cyan]:\n")
        console.print(json.dumps({"mcpServers": {"horus-source": stdio_config}}, indent=2))
        console.print("\nOr run directly:")
        console.print("[cyan]claude mcp add horus-source -- horus-source serve --watch[/cyan]")

    if cursor or (not claude and not cursor):
        console.print("[bold]Cursor[/bold]")
        console.print("Add to your MCP config:\n")
        console.print(json.dumps({"horus-source": stdio_config}, indent=2))

    console.print("\n[dim]Then index your codebase with:[/dim] [cyan]horus-source analyze .[/cyan]")

@app.command()
def watch() -> None:
    """Watch mode — re-index on file changes."""
    repo_path = Path.cwd().resolve()
    source_dir = _source_dir(repo_path)
    source_dir.mkdir(parents=True, exist_ok=True)
    db_path = store_path(source_dir)

    storage = create_backend()
    storage.initialize(db_path)

    if not (source_dir / "meta.json").exists():
        console.print("[bold]Running initial index...[/bold]")
        _, result = run_pipeline(repo_path, storage)
        meta = _build_meta(result, repo_path)
        meta_path = source_dir / "meta.json"
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
        try:
            _register_in_global_registry(meta, repo_path)
        except Exception:
            logger.debug("Failed to register repo in global registry", exc_info=True)
    else:
        ensure_current_embeddings(storage, repo_path)

    console.print(f"[bold]Watching[/bold] {repo_path} for changes (Ctrl+C to stop)")

    try:
        asyncio.run(watch_repo(repo_path, storage))
    except KeyboardInterrupt:
        console.print("\n[bold]Watch stopped.[/bold]")
    finally:
        storage.close()

@app.command()
def diff(
    branch_range: str = typer.Argument(..., help="Branch range for comparison (e.g. main..feature)."),
) -> None:
    """Structural branch comparison."""
    repo_path = Path.cwd().resolve()
    try:
        result = diff_branches(repo_path, branch_range)
    except (ValueError, RuntimeError) as exc:
        console.print(f"[red]Error:[/red] {exc}")
        raise typer.Exit(code=1) from exc

    console.print(format_diff(result))

@app.command()
def mcp() -> None:
    """Start MCP server (stdio transport)."""
    asyncio.run(mcp_main())


@app.command()
def host(
    port: int = typer.Option(DEFAULT_PORT, "--port", "-p", help="Port to serve UI and HTTP MCP on."),
    bind: str = typer.Option(DEFAULT_HOST, "--bind", help="Host interface to bind the shared host to."),
    no_open: bool = typer.Option(False, "--no-open", help="Don't auto-open browser."),
    watch: bool = typer.Option(True, "--watch/--no-watch", help="Enable file watching with auto-reindex."),
    dev: bool = typer.Option(False, "--dev", help="Proxy to Vite dev server for HMR."),
    managed: bool = typer.Option(False, "--managed", hidden=True),
) -> None:
    """Run the shared Horus host for UI and multi-session HTTP MCP clients."""
    _run_shared_host(
        port=port,
        bind=bind,
        no_open=no_open,
        watch=watch,
        dev=dev,
        managed=managed,
        open_browser=True,
        announce_ui=True,
        announce_mcp=True,
        expose_ui=not managed,
        already_running_message="[yellow]Source-intelligence host already running[/yellow] at {url}",
    )


@app.command()
def stop(
    all_hosts: bool = typer.Option(
        False, "--all", help="Stop every known running Horus host, not just this repo's."
    ),
) -> None:
    """Stop the running Horus host(s) and deregister them.

    Sends SIGTERM then escalates to SIGKILL after a short timeout so a host whose
    graceful shutdown hangs on long-lived connections is still reaped, and clears
    the ownership record so no orphan survives (HOR-422).
    """
    if all_hosts:
        repos = _iter_registered_repo_paths()
        cwd = Path.cwd().resolve()
        if cwd not in repos:
            repos.append(cwd)
        stopped = 0
        for repo_path in repos:
            status = _stop_host(repo_path)
            if status == "stopped":
                stopped += 1
                console.print(f"[green]Stopped[/green] host for {repo_path}")
            elif status == "failed":
                console.print(f"[red]Failed to stop[/red] host for {repo_path}")
        if stopped == 0:
            console.print("[dim]No running hosts found.[/dim]")
        return

    repo_path = Path.cwd().resolve()
    status = _stop_host(repo_path)
    if status == "none":
        console.print("[dim]No running host for this repo.[/dim]")
    elif status == "failed":
        console.print(f"[red]Failed to stop[/red] host for {repo_path}")
        raise typer.Exit(code=1)
    else:
        console.print(f"[green]Stopped[/green] host for {repo_path}")


@app.command()
def hosts(
    reap: bool = typer.Option(
        False, "--reap", help="Clear stale/orphaned host records (dead pid or port mismatch)."
    ),
) -> None:
    """List running Horus hosts, or reconcile stale ownership records with --reap."""
    repos = _iter_registered_repo_paths()
    cwd = Path.cwd().resolve()
    if cwd not in repos:
        repos.append(cwd)

    if reap:
        reaped = 0
        for repo_path in repos:
            if _reap_host_meta(repo_path) == "reaped":
                reaped += 1
                console.print(f"[yellow]Reaped[/yellow] stale host record for {repo_path}")
        console.print(f"[dim]Reaped {reaped} stale host record(s).[/dim]")
        return

    found = 0
    for repo_path in repos:
        meta = _read_host_meta(repo_path)
        if meta is None:
            continue
        found += 1
        pid = int(meta.get("pid", 0) or 0)
        alive = _pid_is_alive(pid) if pid else False
        if not alive:
            state = "stale"
        elif not _host_meta_is_consistent(meta):
            state = "port-mismatch"
        else:
            state = "running"
        console.print(
            f"{meta.get('host_url', '?')}  pid={pid}  state={state}  {repo_path}",
            markup=False,
        )
    if found == 0:
        console.print("[dim]No host records found.[/dim]")


@app.command()
def serve(
    watch: bool = typer.Option(False, "--watch", "-w", help="Enable file watching with auto-reindex."),
) -> None:
    """Start MCP server, optionally with live file watching."""
    if not watch:
        asyncio.run(mcp_main())
        return

    repo_path = Path.cwd().resolve()
    lease_path: Path | None = None
    try:
        live_host = _ensure_host_running(
            repo_path,
            port=DEFAULT_MANAGED_PORT,
            watch=True,
            managed=True,
        )
        lease_path = _create_host_lease(repo_path, "mcp")
    except RuntimeError as exc:
        console.print(f"[red]Error:[/red] {exc}")
        raise typer.Exit(code=1) from exc

    try:
        asyncio.run(_proxy_stdio_to_http_mcp(live_host["mcp_url"]))
    finally:
        _remove_host_lease(lease_path)


@app.command()
def ui(
    port: int = typer.Option(8420, "--port", "-p", help="Port to serve on."),
    no_open: bool = typer.Option(False, "--no-open", help="Don't auto-open browser."),
    watch_files: bool = typer.Option(False, "--watch", "-w", help="Enable live file watching."),
    dev: bool = typer.Option(False, "--dev", help="Proxy to Vite dev server for HMR."),
    direct: bool = typer.Option(
        False,
        "--direct",
        help="Force standalone UI mode even if a shared Horus host is already running.",
    ),
) -> None:
    """Launch the Horus web UI."""
    repo_path = Path.cwd().resolve()
    if not direct:
        live_host = _get_live_host_info(repo_path)
        if live_host is not None:
            if live_host.get("ui_enabled", True):
                console.print(
                    f"[bold green]Horus UI[/bold green] available at {live_host['host_url']}"
                )
                if not no_open:
                    webbrowser.open(live_host["host_url"])
                return

            proxy_app = web_app_module.create_ui_proxy_app(live_host["host_url"], dev=dev)
            console.print(
                f"[bold green]Horus UI[/bold green] running at http://{DEFAULT_HOST}:{port}"
            )
            if not no_open:
                webbrowser.open(f"http://{DEFAULT_HOST}:{port}")
            uvicorn.run(proxy_app, host=DEFAULT_HOST, port=port, log_level="warning")
            return

        _run_shared_host(
            port=port,
            bind=DEFAULT_HOST,
            no_open=no_open,
            watch=watch_files,
            dev=dev,
            managed=False,
            open_browser=True,
            announce_ui=True,
            announce_mcp=False,
            expose_ui=True,
            already_running_message="[bold green]Horus UI[/bold green] available at {url}",
            auto_index=False,
        )
        return

    storage, _, db_path = _initialize_writable_storage(repo_path, auto_index=False)
    runtime = HorusRuntime(
        storage=storage,
        repo_path=repo_path,
        watch=watch_files,
        owns_storage=True,
    )

    web_app = web_app_module.create_app(
        db_path=db_path,
        repo_path=repo_path,
        watch=watch_files,
        dev=dev,
        runtime=runtime,
    )

    if not no_open:
        url = f"http://localhost:{port}"
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()

    console.print(f"[bold green]Horus UI[/bold green] running at http://localhost:{port}")
    if watch_files:
        console.print("[dim]File watching enabled — graph updates on save[/dim]")
    if dev:
        console.print("[dim]Dev mode — proxying to Vite on :5173[/dim]")

    if watch_files:
        async def _run() -> None:
            config = uvicorn.Config(
                web_app, host="127.0.0.1", port=port, log_level="warning"
            )
            server = uvicorn.Server(config)
            stop = asyncio.Event()

            async def _serve() -> None:
                await server.serve()
                stop.set()

            await asyncio.gather(
                _serve(),
                watch_repo(repo_path, web_app.state.storage, stop_event=stop),
            )

        try:
            asyncio.run(_run())
        except KeyboardInterrupt:
            console.print("\n[bold]UI stopped.[/bold]")
    else:
        uvicorn.run(web_app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    app()
