from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.exceptions import Exit
from typer.testing import CliRunner

from horus_source import __version__
from horus_source.cli.main import (
    _bind_free_port,
    _find_free_port,
    _host_meta_is_consistent,
    _initialize_writable_storage,
    _open_host_storage,
    _port_is_free,
    _reap_host_meta,
    _register_in_global_registry,
    _run_host_indexing,
    _stop_host,
    _terminate_pid,
    app,
)

runner = CliRunner()


@pytest.fixture(autouse=True)
def suppress_update_notice(request):
    if request.node.get_closest_marker("allow_update_notice"):
        yield
        return
    with patch("horus_source.cli.main._maybe_notify_update"):
        yield


@pytest.fixture(autouse=True)
def no_real_port_kills():
    """Port-based reaping (HOR-409) shells out to ``lsof``/``ps``; stub it out by default so
    unit tests never inspect or terminate real processes. Tests that exercise port reaping
    patch ``_pids_listening_on_port`` locally to override this."""
    with patch("horus_source.cli.main._pids_listening_on_port", return_value=[]):
        yield


class TestVersion:
    def test_version_long_flag(self) -> None:
        result = runner.invoke(app, ["--version"])
        assert result.exit_code == 0


class TestUpdateNotifier:
    @pytest.mark.allow_update_notice
    def test_never_nags_about_updates(self) -> None:
        # The backend ships inside the horus bundle — `horus update` owns
        # updates, and PyPI is frozen. The notifier must stay silent.
        result = runner.invoke(app, ["list"])
        assert result.exit_code == 0
        assert "Update available" not in result.output

    def test_version_short_flag(self) -> None:
        result = runner.invoke(app, ["-v"])
        assert result.exit_code == 0
        assert f"Horus source intelligence v{__version__}" in result.output

    def test_version_exit_code(self) -> None:
        result = runner.invoke(app, ["--version"])
        assert result.exit_code == 0


class TestHelp:
    def test_help_exit_code(self) -> None:
        result = runner.invoke(app, ["--help"])
        assert result.exit_code == 0

    def test_help_shows_app_name(self) -> None:
        result = runner.invoke(app, ["--help"])
        assert "Horus" in result.output

    def test_help_lists_commands(self) -> None:
        result = runner.invoke(app, ["--help"])
        expected_commands = [
            "analyze",
            "status",
            "list",
            "clean",
            "query",
            "context",
            "impact",
            "dead-code",
            "cypher",
            "setup",
            "watch",
            "diff",
            "mcp",
            "host",
        ]
        for cmd in expected_commands:
            assert cmd in result.output, f"Command '{cmd}' not found in --help output"


class TestStatus:
    def test_status_no_index(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["status"])
        assert result.exit_code == 1
        assert "No index found" in result.output

    def test_status_with_index(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        meta = {
            "version": "0.1.0",
            "stats": {
                "files": 10,
                "symbols": 42,
                "relationships": 100,
                "clusters": 3,
                "flows": 0,
                "dead_code": 5,
                "coupled_pairs": 0,
            },
            "last_indexed_at": "2025-01-15T10:00:00+00:00",
        }
        (source_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0
        assert "Index status for" in result.output
        assert "0.1.0" in result.output
        assert "10" in result.output  # files
        assert "42" in result.output  # symbols
        assert "100" in result.output  # relationships


class TestListRepos:
    def test_list_calls_handle_list_repos(self) -> None:
        with patch(
            "horus_source.mcp.tools.handle_list_repos",
            return_value="Indexed repositories (1):\n\n  1. my-project",
        ):
            result = runner.invoke(app, ["list"])
        assert result.exit_code == 0
        assert "my-project" in result.output

    def test_list_no_repos(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        with patch(
            "horus_source.mcp.tools.handle_list_repos",
            return_value="No indexed repositories found.",
        ):
            result = runner.invoke(app, ["list"])
        assert result.exit_code == 0
        assert "No indexed repositories found" in result.output


class TestClean:
    def test_clean_no_index(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["clean", "--force"])
        assert result.exit_code == 1
        assert "No index found" in result.output

    def test_clean_with_force(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text("{}", encoding="utf-8")

        result = runner.invoke(app, ["clean", "--force"])
        assert result.exit_code == 0
        assert "Deleted" in result.output
        assert not source_dir.exists()

    def test_clean_aborted(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text("{}", encoding="utf-8")

        result = runner.invoke(app, ["clean"], input="n\n")
        assert result.exit_code == 0
        assert source_dir.exists()  # Not deleted


class TestQuery:
    def test_query_no_index(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["query", "find classes"])
        assert result.exit_code == 1
        assert "No index found" in result.output

    def test_query_with_storage(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        mock_storage = MagicMock()
        with patch("horus_source.cli.main._load_storage", return_value=mock_storage):
            with patch(
                "horus_source.mcp.tools.handle_query",
                return_value="1. MyClass (Class) -- src/main.py",
            ):
                result = runner.invoke(app, ["query", "find classes"])
        assert result.exit_code == 0
        assert "MyClass" in result.output


class TestContext:
    def test_context_no_index(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["context", "MyClass"])
        assert result.exit_code == 1
        assert "No index found" in result.output

    def test_context_with_storage(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        mock_storage = MagicMock()
        with patch("horus_source.cli.main._load_storage", return_value=mock_storage):
            with patch(
                "horus_source.mcp.tools.handle_context",
                return_value="Symbol: MyClass (Class)\nFile: src/main.py:1-50",
            ):
                result = runner.invoke(app, ["context", "MyClass"])
        assert result.exit_code == 0
        assert "MyClass" in result.output


class TestImpact:
    def test_impact_no_index(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["impact", "MyClass.method"])
        assert result.exit_code == 1
        assert "No index found" in result.output

    def test_impact_with_storage(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        mock_storage = MagicMock()
        with patch("horus_source.cli.main._load_storage", return_value=mock_storage):
            with patch(
                "horus_source.mcp.tools.handle_impact",
                return_value="Impact analysis for: MyClass.method",
            ):
                result = runner.invoke(app, ["impact", "MyClass.method", "--depth", "5"])
        assert result.exit_code == 0
        assert "Impact analysis" in result.output

    def test_impact_default_depth(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        mock_storage = MagicMock()
        with patch("horus_source.cli.main._load_storage", return_value=mock_storage):
            with patch(
                "horus_source.mcp.tools.handle_impact",
                return_value="Impact analysis for: foo",
            ):
                result = runner.invoke(app, ["impact", "foo"])
        assert result.exit_code == 0


class TestDeadCode:
    def test_dead_code_no_index(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["dead-code"])
        assert result.exit_code == 1
        assert "No index found" in result.output

    def test_dead_code_with_storage(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        mock_storage = MagicMock()
        with patch("horus_source.cli.main._load_storage", return_value=mock_storage):
            with patch(
                "horus_source.mcp.tools.handle_dead_code",
                return_value="No dead code detected.",
            ):
                result = runner.invoke(app, ["dead-code"])
        assert result.exit_code == 0
        assert "No dead code detected" in result.output


class TestCypher:
    def test_cypher_no_index(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["cypher", "MATCH (n) RETURN n"])
        assert result.exit_code == 1
        assert "No index found" in result.output

    def test_cypher_with_storage(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        mock_storage = MagicMock()
        with patch("horus_source.cli.main._load_storage", return_value=mock_storage):
            with patch(
                "horus_source.mcp.tools.handle_cypher",
                return_value="Results (3 rows):\n\n  1. foo",
            ):
                result = runner.invoke(app, ["cypher", "MATCH (n) RETURN n"])
        assert result.exit_code == 0
        assert "Results" in result.output


class TestSetup:
    def test_setup_no_flags_shows_both(self) -> None:
        result = runner.invoke(app, ["setup"])
        assert result.exit_code == 0
        assert "Claude Code" in result.output
        assert "Cursor" in result.output
        assert '"horus-source"' in result.output
        assert '"serve"' in result.output

    def test_setup_claude_only(self) -> None:
        result = runner.invoke(app, ["setup", "--claude"])
        assert result.exit_code == 0
        assert "Claude Code" in result.output
        assert "Cursor" not in result.output

    def test_setup_cursor_only(self) -> None:
        result = runner.invoke(app, ["setup", "--cursor"])
        assert result.exit_code == 0
        assert "Cursor" in result.output
        assert "Claude Code" not in result.output

    def test_setup_both_flags(self) -> None:
        result = runner.invoke(app, ["setup", "--claude", "--cursor"])
        assert result.exit_code == 0
        assert "Claude Code" in result.output
        assert "Cursor" in result.output


class TestMcp:
    def test_mcp_command_exists(self) -> None:
        result = runner.invoke(app, ["mcp", "--help"])
        assert result.exit_code == 0
        assert "MCP server" in result.output or "stdio" in result.output.lower()

    def test_mcp_calls_server_main(self) -> None:
        import asyncio as real_asyncio

        with patch.object(real_asyncio, "run") as mock_run:
            result = runner.invoke(app, ["mcp"])
        assert result.exit_code == 0
        mock_run.assert_called_once()


class TestServe:
    def test_serve_command_exists(self) -> None:
        result = runner.invoke(app, ["serve", "--help"])
        assert result.exit_code == 0
        assert "watch" in result.output.lower()

    def test_serve_without_watch_delegates_to_mcp(self) -> None:
        import asyncio as real_asyncio

        with patch.object(real_asyncio, "run") as mock_run:
            result = runner.invoke(app, ["serve"])
        assert result.exit_code == 0
        mock_run.assert_called_once()

    def test_serve_with_watch_proxies_to_host(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        import asyncio as real_asyncio

        monkeypatch.chdir(tmp_path)
        with patch(
            "horus_source.cli.main._ensure_host_running",
            return_value={"host_url": "http://127.0.0.1:8420", "mcp_url": "http://127.0.0.1:8420/mcp"},
        ) as mock_ensure:
            with patch.object(real_asyncio, "run") as mock_run:
                result = runner.invoke(app, ["serve", "--watch"])
        assert result.exit_code == 0
        mock_ensure.assert_called_once()
        mock_run.assert_called_once()


class TestHost:
    def test_host_command_exists(self) -> None:
        result = runner.invoke(app, ["host", "--help"])
        assert result.exit_code == 0
        assert "HTTP MCP" in result.output or "shared" in result.output.lower()


class TestFreePortSelection:
    def test_picks_next_port_when_preferred_is_occupied(self) -> None:
        import socket

        bind = "127.0.0.1"
        # Occupy the preferred port with a real listening socket so it reads as taken.
        occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        occupied.bind((bind, 0))
        occupied.listen(1)
        try:
            preferred = occupied.getsockname()[1]
            assert not _port_is_free(preferred, bind)

            chosen = _find_free_port(preferred, bind)

            # Must not loop on the contended port; it must hand back a different,
            # actually-bindable port so concurrent hosts coexist.
            assert chosen != preferred
            assert _port_is_free(chosen, bind)
        finally:
            occupied.close()

    def test_returns_preferred_when_free(self) -> None:
        from horus_source.cli.main import _os_assigned_port

        bind = "127.0.0.1"
        # An ephemeral port we just released is overwhelmingly likely to be free.
        preferred = _os_assigned_port(bind)
        assert _find_free_port(preferred, bind) == preferred

    def test_falls_back_to_os_assigned_when_window_contended(self) -> None:
        bind = "127.0.0.1"
        with patch("horus_source.cli.main._port_is_free", return_value=False):
            with patch(
                "horus_source.cli.main._os_assigned_port", return_value=54321
            ) as mock_os_port:
                chosen = _find_free_port(8420, bind, max_scan=5)
        assert chosen == 54321
        mock_os_port.assert_called_once_with(bind)


class TestBindFreePort:
    def test_returns_socket_bound_to_the_actual_port_it_holds(self) -> None:
        bind = "127.0.0.1"
        sock = _bind_free_port(8420, bind)
        try:
            actual = sock.getsockname()[1]
            assert actual > 0
            # We HOLD the port — a check-then-release probe must see it as taken, proving the
            # returned port is genuinely bound (no TOCTOU window before the server binds).
            assert not _port_is_free(actual, bind)
        finally:
            sock.close()

    def test_falls_back_to_a_free_port_when_preferred_is_occupied(self) -> None:
        import socket

        bind = "127.0.0.1"
        occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        occupied.bind((bind, 0))
        occupied.listen(1)
        try:
            preferred = occupied.getsockname()[1]
            sock = _bind_free_port(preferred, bind)
            try:
                # The bound socket must hold a DIFFERENT, actual port — never the contended one.
                assert sock.getsockname()[1] != preferred
            finally:
                sock.close()
        finally:
            occupied.close()


class TestRunSharedHostBinding:
    def test_persists_the_actual_bound_port_not_the_requested_one(
        self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch"
    ) -> None:
        import socket

        from horus_source.cli.main import _run_shared_host

        monkeypatch.chdir(tmp_path)
        bind = "127.0.0.1"
        # A real socket bound to an OS-assigned (definitely-not-8420) fallback port, standing
        # in for "the requested 8420 was taken, so the host fell back to a free port".
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind((bind, 0))
        fallback_port = sock.getsockname()[1]

        def _consume(coro: object) -> None:
            # asyncio.run is stubbed; close the unused coroutine so it never serves.
            getattr(coro, "close", lambda: None)()

        mock_storage = MagicMock()
        db_path = tmp_path / ".horus" / "source" / "kuzu"
        with patch("horus_source.cli.main._get_live_host_info", return_value=None), patch(
            "horus_source.cli.main._open_host_storage",
            return_value=(mock_storage, db_path, False),
        ), patch("horus_source.cli.main._bind_free_port", return_value=sock), patch(
            "horus_source.cli.main.MemoryVectorStore"
        ), patch(
            "horus_source.cli.main.web_app_module.create_app", return_value=MagicMock()
        ), patch("horus_source.cli.main.threading.Thread"), patch(
            "horus_source.cli.main.asyncio.run", side_effect=_consume
        ), patch("horus_source.cli.main._clear_host_meta"), patch(
            "horus_source.cli.main._write_host_meta"
        ) as mock_write:
            _run_shared_host(
                port=8420,
                bind=bind,
                no_open=True,
                watch=False,
                dev=False,
                managed=False,
                open_browser=False,
                announce_ui=False,
                announce_mcp=False,
                expose_ui=False,
                already_running_message="{url}",
            )

        # host.json must record the port we ACTUALLY bound — never the requested 8420 (which a
        # different repo's host may be occupying). This is the contamination fix (HOR-409).
        assert mock_write.called
        # _write_host_meta(repo_path, host_url, mcp_url, port, *, ui_enabled=...)
        host_url = mock_write.call_args.args[1]
        port_arg = mock_write.call_args.args[3]
        assert port_arg == fallback_port
        assert f":{fallback_port}" in host_url
        assert ":8420" not in host_url


class TestUi:
    def test_ui_attaches_to_running_host(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        with patch(
            "horus_source.cli.main._get_live_host_info",
            return_value={"host_url": "http://127.0.0.1:8420", "mcp_url": "http://127.0.0.1:8420/mcp"},
        ):
            with patch("webbrowser.open") as mock_open:
                result = runner.invoke(app, ["ui"])
        assert result.exit_code == 0
        assert "http://127.0.0.1:8420" in result.output
        mock_open.assert_called_once_with("http://127.0.0.1:8420")

    def test_ui_direct_skips_host_attach(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        mock_storage = MagicMock()
        with patch("horus_source.cli.main._get_live_host_info") as mock_host_info:
            with patch(
                "horus_source.cli.main._initialize_writable_storage",
                return_value=(mock_storage, tmp_path / ".horus" / "source", tmp_path / ".horus" / "source" / "kuzu"),
            ):
                with patch("horus_source.web.app.create_app") as mock_create_app:
                    with patch("uvicorn.run") as mock_run:
                        result = runner.invoke(app, ["ui", "--direct", "--no-open"])
        assert result.exit_code == 0
        mock_host_info.assert_not_called()
        mock_create_app.assert_called_once()
        mock_run.assert_called_once()


class TestWritableStorageInitialization:
    def test_requires_database_when_auto_index_disabled(self, tmp_path: Path) -> None:
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text("{}", encoding="utf-8")

        with pytest.raises(Exit):
            _initialize_writable_storage(tmp_path, auto_index=False)

    def test_runs_embedding_migration_for_existing_index(self, tmp_path: Path) -> None:
        # An existing index opens in read-write mode and runs embedding migration.
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        db_path = source_dir / "horus.db"
        db_path.write_text("", encoding="utf-8")
        (source_dir / "meta.json").write_text("{}", encoding="utf-8")

        new_dir = tmp_path / ".horus" / "source"
        new_db_path = new_dir / "horus.db"

        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            with patch("horus_source.cli.main.ensure_current_embeddings") as mock_migrate:
                storage, returned_source_dir, returned_db_path = _initialize_writable_storage(
                    tmp_path,
                    auto_index=False,
                )

        assert storage is mock_storage
        assert returned_source_dir == new_dir
        assert returned_db_path == new_db_path
        mock_storage.initialize.assert_called_once_with(new_db_path, recover_corrupt=True)
        mock_migrate.assert_called_once_with(mock_storage, tmp_path)

    def test_defer_embeddings_skips_synchronous_reembed(self, tmp_path: Path) -> None:
        # HOR-409: the host path defers the re-embed so host start is never gated on a
        # full re-embed of a large index (which can exceed the health window).
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        db_path = source_dir / "horus.db"
        db_path.write_text("", encoding="utf-8")
        (source_dir / "meta.json").write_text("{}", encoding="utf-8")

        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            with patch("horus_source.cli.main.ensure_current_embeddings") as mock_migrate:
                _initialize_writable_storage(
                    tmp_path, auto_index=False, defer_embeddings=True,
                )

        mock_migrate.assert_not_called()

    def test_corrupt_db_recreation_triggers_reindex(self, tmp_path: Path) -> None:
        # HOR-409: a database recreated from corruption is empty, so its stale meta.json is
        # dropped and the repo is re-indexed instead of the migration/no-op path running.
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        db_path = source_dir / "horus.db"
        db_path.write_text("", encoding="utf-8")
        meta_path = source_dir / "meta.json"
        meta_path.write_text("{}", encoding="utf-8")

        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = True

        from horus_source.core.ingestion.pipeline import PipelineResult

        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            with patch(
                "horus_source.cli.main.run_pipeline",
                return_value=(MagicMock(), PipelineResult()),
            ) as mock_pipeline:
                with patch("horus_source.cli.main.ensure_current_embeddings") as mock_migrate:
                    with patch("horus_source.cli.main._register_in_global_registry"):
                        _initialize_writable_storage(tmp_path, auto_index=True)

        mock_pipeline.assert_called_once()
        mock_migrate.assert_not_called()
        assert meta_path.exists()  # rewritten by the re-index

    def test_startup_reembed_runs_ensure_current_embeddings(self, tmp_path: Path) -> None:
        # HOR-409: the background helper finishes embeddings off the health path.
        from horus_source.cli.main import _run_startup_reembed

        mock_storage = MagicMock()
        with patch(
            "horus_source.cli.main.ensure_current_embeddings", return_value=True,
        ) as mock_migrate:
            _run_startup_reembed(mock_storage, tmp_path)

        mock_migrate.assert_called_once_with(mock_storage, tmp_path)

    def test_startup_reembed_swallows_errors(self, tmp_path: Path) -> None:
        # A failed background re-embed must not crash the host thread.
        from horus_source.cli.main import _run_startup_reembed

        mock_storage = MagicMock()
        with patch(
            "horus_source.cli.main.ensure_current_embeddings",
            side_effect=RuntimeError("boom"),
        ):
            _run_startup_reembed(mock_storage, tmp_path)  # must not raise


class TestWatch:
    def test_watch_command_exists(self) -> None:
        result = runner.invoke(app, ["watch", "--help"])
        assert result.exit_code == 0
        assert "Watch mode" in result.output or "re-index" in result.output.lower()

    def test_diff_command_exists(self) -> None:
        result = runner.invoke(app, ["diff", "--help"])
        assert result.exit_code == 0
        assert "branch" in result.output.lower()


# Multi-repo registry


class TestRegisterInGlobalRegistry:
    def test_first_registration(self, tmp_path: Path) -> None:
        repo_path = tmp_path / "my-project"
        repo_path.mkdir()

        meta = {"name": "my-project", "path": str(repo_path), "stats": {}}

        with patch("horus_source.cli.main.Path.home", return_value=tmp_path):
            _register_in_global_registry(meta, repo_path)

        slot = tmp_path / ".horus" / "source" / "repos" / "my-project"
        assert slot.exists()
        written = json.loads((slot / "meta.json").read_text())
        assert written["name"] == "my-project"
        assert written["slug"] == "my-project"
        assert written["path"] == str(repo_path)

    def test_same_repo_re_registered(self, tmp_path: Path) -> None:
        repo_path = tmp_path / "my-project"
        repo_path.mkdir()
        meta = {"name": "my-project", "path": str(repo_path), "stats": {}}

        with patch("horus_source.cli.main.Path.home", return_value=tmp_path):
            _register_in_global_registry(meta, repo_path)
            _register_in_global_registry(meta, repo_path)

        # Only one directory should exist
        registry = tmp_path / ".horus" / "source" / "repos"
        entries = list(registry.iterdir())
        assert len(entries) == 1
        assert entries[0].name == "my-project"

    def test_name_collision_different_repos(self, tmp_path: Path) -> None:
        repo_a = tmp_path / "workspace-a" / "myapp"
        repo_b = tmp_path / "workspace-b" / "myapp"
        repo_a.mkdir(parents=True)
        repo_b.mkdir(parents=True)

        meta_a = {"name": "myapp", "path": str(repo_a), "stats": {}}
        meta_b = {"name": "myapp", "path": str(repo_b), "stats": {}}

        with patch("horus_source.cli.main.Path.home", return_value=tmp_path):
            _register_in_global_registry(meta_a, repo_a)
            _register_in_global_registry(meta_b, repo_b)

        registry = tmp_path / ".horus" / "source" / "repos"
        entries = sorted([e.name for e in registry.iterdir()])
        assert len(entries) == 2
        # One should be "myapp", the other "myapp-<hash>"
        assert entries[0] == "myapp"
        assert entries[1].startswith("myapp-")

    def test_stale_entry_cleanup(self, tmp_path: Path) -> None:
        repo_path = tmp_path / "myapp"
        repo_path.mkdir()

        # Manually create a stale entry under a hash slug
        registry = tmp_path / ".horus" / "source" / "repos"
        stale = registry / "myapp-abcd1234"
        stale.mkdir(parents=True)
        stale_meta = {"name": "myapp", "path": str(repo_path)}
        (stale / "meta.json").write_text(json.dumps(stale_meta))

        meta = {"name": "myapp", "path": str(repo_path), "stats": {}}
        with patch("horus_source.cli.main.Path.home", return_value=tmp_path):
            _register_in_global_registry(meta, repo_path)

        # Stale entry should be cleaned up
        assert not stale.exists()
        # New entry under bare name should exist
        assert (registry / "myapp" / "meta.json").exists()

    def test_corrupt_existing_meta_json(self, tmp_path: Path) -> None:
        registry = tmp_path / ".horus" / "source" / "repos" / "myapp"
        registry.mkdir(parents=True)
        (registry / "meta.json").write_text("not valid json!")

        repo_path = tmp_path / "myapp"
        repo_path.mkdir()
        meta = {"name": "myapp", "path": str(repo_path), "stats": {}}

        with patch("horus_source.cli.main.Path.home", return_value=tmp_path):
            _register_in_global_registry(meta, repo_path)

        # Should claim the slot (no crash)
        written = json.loads((registry / "meta.json").read_text())
        assert written["path"] == str(repo_path)

    def test_registry_dir_created_if_missing(self, tmp_path: Path) -> None:
        repo_path = tmp_path / "myapp"
        repo_path.mkdir()
        meta = {"name": "myapp", "path": str(repo_path), "stats": {}}

        # Ensure no .horus dir exists
        assert not (tmp_path / ".horus").exists()

        with patch("horus_source.cli.main.Path.home", return_value=tmp_path):
            _register_in_global_registry(meta, repo_path)

        assert (tmp_path / ".horus" / "source" / "repos" / "myapp" / "meta.json").exists()


# HOR-422: terminating + reaping orphan hosts


def _write_host_json(repo_path: Path, *, pid: int, port: int, url_port: int | None = None) -> Path:
    source_dir = repo_path / ".horus" / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    host_json = source_dir / "host.json"
    host_json.write_text(
        json.dumps(
            {
                "pid": pid,
                "repo_path": str(repo_path),
                "host_url": f"http://127.0.0.1:{url_port if url_port is not None else port}",
                "mcp_url": "http://127.0.0.1/mcp",
                "port": port,
            }
        ),
        encoding="utf-8",
    )
    return host_json


class TestTerminatePid:
    def test_no_op_when_already_dead(self) -> None:
        with patch("horus_source.cli.main._pid_is_alive", return_value=False):
            with patch("horus_source.cli.main.os.kill") as mock_kill:
                assert _terminate_pid(4321) is True
        mock_kill.assert_not_called()

    def test_zero_pid_is_noop(self) -> None:
        with patch("horus_source.cli.main.os.kill") as mock_kill:
            assert _terminate_pid(0) is True
        mock_kill.assert_not_called()

    def test_sigterm_succeeds_without_sigkill(self) -> None:
        import signal as _signal

        # Alive for the initial guard, then dies right after SIGTERM.
        alive = iter([True, False])
        with patch("horus_source.cli.main._pid_is_alive", side_effect=lambda _pid: next(alive)):
            with patch("horus_source.cli.main.os.kill") as mock_kill:
                assert _terminate_pid(999, timeout=1.0, poll_interval=0.0) is True
        sent = [c.args[1] for c in mock_kill.call_args_list]
        assert _signal.SIGTERM in sent
        assert _signal.SIGKILL not in sent

    def test_escalates_to_sigkill_when_sigterm_ignored(self) -> None:
        import signal as _signal

        # Stays alive through the SIGTERM window, then dies after SIGKILL.
        states = iter([True, True, True, False])
        with patch("horus_source.cli.main._pid_is_alive", side_effect=lambda _pid: next(states)):
            with patch("horus_source.cli.main.os.kill") as mock_kill:
                assert _terminate_pid(999, timeout=0.0, poll_interval=0.0) is True
        sent = [c.args[1] for c in mock_kill.call_args_list]
        assert _signal.SIGTERM in sent
        assert _signal.SIGKILL in sent


class TestHostMetaConsistency:
    def test_consistent_when_ports_match(self) -> None:
        assert _host_meta_is_consistent(
            {"port": 8420, "host_url": "http://127.0.0.1:8420"}
        )

    def test_inconsistent_when_recorded_port_differs_from_url(self) -> None:
        # The HOR-422 symptom: recorded 8420 vs actually-bound 8422.
        assert not _host_meta_is_consistent(
            {"port": 8420, "host_url": "http://127.0.0.1:8422"}
        )

    def test_inconsistent_when_url_missing(self) -> None:
        assert not _host_meta_is_consistent({"port": 8420, "host_url": None})


class TestStopHost:
    def test_none_when_no_record(self, tmp_path: Path) -> None:
        assert _stop_host(tmp_path) == "none"

    def test_terminates_and_clears_record(self, tmp_path: Path) -> None:
        host_json = _write_host_json(tmp_path, pid=4242, port=8420)
        with patch("horus_source.cli.main._terminate_pid", return_value=True) as mock_term:
            assert _stop_host(tmp_path) == "stopped"
        mock_term.assert_called_once()
        assert mock_term.call_args.args[0] == 4242
        assert not host_json.exists()  # deregistered

    def test_clears_record_even_when_terminate_fails(self, tmp_path: Path) -> None:
        host_json = _write_host_json(tmp_path, pid=4242, port=8420)
        with patch("horus_source.cli.main._terminate_pid", return_value=False):
            assert _stop_host(tmp_path) == "failed"
        assert not host_json.exists()

    def test_reaps_orphan_listening_on_the_actual_fallback_port(self, tmp_path: Path) -> None:
        # host.json records the ACTUAL fallback port (8421); a host is orphaned on it under a
        # pid (9999) different from the recorded one (4242). Both must be terminated — the
        # recorded server pid AND whatever still holds the actual bound port (HOR-409).
        _write_host_json(tmp_path, pid=4242, port=8421)
        killed: list[int] = []
        with patch("horus_source.cli.main._pids_listening_on_port", return_value=[9999]):
            with patch("horus_source.cli.main._serves_other_repo", return_value=False):
                with patch(
                    "horus_source.cli.main._terminate_pid",
                    side_effect=lambda p, **_: killed.append(p) or True,
                ):
                    assert _stop_host(tmp_path) == "stopped"
        assert 4242 in killed
        assert 9999 in killed

    def test_never_reaps_a_foreign_repos_host_on_the_recorded_port(self, tmp_path: Path) -> None:
        # The recorded port now serves a DIFFERENT repo (legacy/stale record) — its pid must
        # NEVER be killed, but our own recorded server pid is still terminated.
        _write_host_json(tmp_path, pid=4242, port=8421)
        killed: list[int] = []
        with patch("horus_source.cli.main._pids_listening_on_port", return_value=[9999]):
            with patch("horus_source.cli.main._serves_other_repo", return_value=True):
                with patch(
                    "horus_source.cli.main._terminate_pid",
                    side_effect=lambda p, **_: killed.append(p) or True,
                ):
                    assert _stop_host(tmp_path) == "stopped"
        assert 4242 in killed
        assert 9999 not in killed  # foreign host left untouched


class TestReapHostMeta:
    def test_alive_and_consistent_is_left_untouched(self, tmp_path: Path) -> None:
        host_json = _write_host_json(tmp_path, pid=4242, port=8420)
        with patch("horus_source.cli.main._pid_is_alive", return_value=True):
            assert _reap_host_meta(tmp_path) == "alive"
        assert host_json.exists()

    def test_dead_pid_is_reaped(self, tmp_path: Path) -> None:
        host_json = _write_host_json(tmp_path, pid=4242, port=8420)
        with patch("horus_source.cli.main._pid_is_alive", return_value=False):
            assert _reap_host_meta(tmp_path) == "reaped"
        assert not host_json.exists()

    def test_port_mismatch_terminates_and_reaps(self, tmp_path: Path) -> None:
        host_json = _write_host_json(tmp_path, pid=4242, port=8420, url_port=8422)
        with patch("horus_source.cli.main._pid_is_alive", return_value=True):
            with patch("horus_source.cli.main._terminate_pid", return_value=True) as mock_term:
                assert _reap_host_meta(tmp_path) == "reaped"
        mock_term.assert_called_once()
        assert not host_json.exists()


class TestStopCommand:
    def test_stop_no_running_host(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        result = runner.invoke(app, ["stop"])
        assert result.exit_code == 0
        assert "No running host" in result.output

    def test_stop_all_iterates_registry(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        repo_a = tmp_path / "a"
        repo_a.mkdir()
        _write_host_json(repo_a, pid=11, port=8420)
        with patch("horus_source.cli.main._iter_registered_repo_paths", return_value=[repo_a]):
            with patch("horus_source.cli.main._terminate_pid", return_value=True):
                result = runner.invoke(app, ["stop", "--all"])
        assert result.exit_code == 0
        assert "Stopped" in result.output


class TestHostsCommand:
    def test_hosts_lists_records(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        repo_a = tmp_path / "a"
        repo_a.mkdir()
        _write_host_json(repo_a, pid=11, port=8420)
        with patch("horus_source.cli.main._iter_registered_repo_paths", return_value=[repo_a]):
            with patch("horus_source.cli.main._pid_is_alive", return_value=True):
                result = runner.invoke(app, ["hosts"])
        assert result.exit_code == 0
        assert "running" in result.output

    def test_hosts_reap_clears_stale(self, tmp_path: Path, monkeypatch: "pytest.MonkeyPatch") -> None:
        monkeypatch.chdir(tmp_path)
        repo_a = tmp_path / "a"
        repo_a.mkdir()
        host_json = _write_host_json(repo_a, pid=11, port=8420)
        with patch("horus_source.cli.main._iter_registered_repo_paths", return_value=[repo_a]):
            with patch("horus_source.cli.main._pid_is_alive", return_value=False):
                result = runner.invoke(app, ["hosts", "--reap"])
        assert result.exit_code == 0
        assert "Reaped" in result.output
        assert not host_json.exists()


# HOR-425: bind the port first, run index/embed in the background


class TestOpenHostStorage:
    def test_fresh_repo_needs_index(self, tmp_path: Path) -> None:
        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            storage, db_path, needs_index = _open_host_storage(tmp_path, auto_index=True)
        assert storage is mock_storage
        assert needs_index is True

    def test_existing_index_does_not_need_index(self, tmp_path: Path) -> None:
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text("{}", encoding="utf-8")
        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            _, _, needs_index = _open_host_storage(tmp_path, auto_index=True)
        assert needs_index is False

    def test_does_not_run_pipeline_or_embeddings(self, tmp_path: Path) -> None:
        # The whole point of HOR-425: the bind path must not do heavy work.
        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            with patch("horus_source.cli.main.run_pipeline") as mock_pipeline:
                with patch("horus_source.cli.main.ensure_current_embeddings") as mock_embed:
                    _open_host_storage(tmp_path, auto_index=True)
        mock_pipeline.assert_not_called()
        mock_embed.assert_not_called()

    # ---- HOR-433: upgrade self-heal of a stale/legacy/broken index on host start ----

    def test_legacy_kuzu_dir_forces_reindex_and_prunes(self, tmp_path: Path) -> None:
        # A leftover kùzu-era store under .horus/source/kuzu means the active SQLite store
        # is empty/wrong — rebuild from source (prune + needs_index) instead of serving it.
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text(
            json.dumps({"store_backend": "sqlite", "stats": {"symbols": 50}}) + "\n",
            encoding="utf-8",
        )
        legacy = source_dir / "kuzu"
        legacy.mkdir()
        (legacy / "data.kz").write_text("x", encoding="utf-8")

        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        # Even an embeddings count that looks fine must not win over a legacy store.
        mock_storage.count_embeddings.return_value = 5
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            with patch("horus_source.cli.main.prune_legacy_kuzu_store") as mock_prune:
                _, _, needs_index = _open_host_storage(tmp_path, auto_index=True)

        assert needs_index is True
        mock_prune.assert_called_once()
        assert not (source_dir / "meta.json").exists()

    def test_store_backend_mismatch_forces_reindex(self, tmp_path: Path) -> None:
        # meta stamped by a DIFFERENT backend than the one we open → rebuild from source.
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text(
            json.dumps({"store_backend": "kuzu", "stats": {"symbols": 50}}) + "\n",
            encoding="utf-8",
        )
        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        mock_storage.count_embeddings.return_value = 99
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            _, _, needs_index = _open_host_storage(tmp_path, auto_index=True)

        assert needs_index is True
        assert not (source_dir / "meta.json").exists()

    def test_zero_embeddings_with_symbols_forces_reindex(self, tmp_path: Path) -> None:
        # Store serves 0 embeddings while meta records symbols → unsearchable → rebuild.
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text(
            json.dumps({"store_backend": "sqlite", "stats": {"symbols": 50}}) + "\n",
            encoding="utf-8",
        )
        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        mock_storage.count_embeddings.return_value = 0
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            _, _, needs_index = _open_host_storage(tmp_path, auto_index=True)

        assert needs_index is True
        mock_storage.count_embeddings.assert_called()
        assert not (source_dir / "meta.json").exists()

    def test_healthy_index_not_reindexed(self, tmp_path: Path) -> None:
        # A healthy, stamped index must NEVER be spuriously re-indexed (the key non-goal).
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text(
            json.dumps(
                {
                    "store_backend": "sqlite",
                    "store_format_version": 1,
                    "stats": {"symbols": 50},
                }
            )
            + "\n",
            encoding="utf-8",
        )
        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        mock_storage.count_embeddings.return_value = 50
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            _, _, needs_index = _open_host_storage(tmp_path, auto_index=True)

        assert needs_index is False
        assert (source_dir / "meta.json").exists()

    def test_healthy_unstamped_index_backfills_stamp_without_reindex(
        self, tmp_path: Path
    ) -> None:
        # A pre-HOR-433 (unstamped) but healthy index gets its store_backend stamp
        # backfilled WITHOUT a re-index.
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        (source_dir / "meta.json").write_text(
            json.dumps({"stats": {"symbols": 50}}) + "\n", encoding="utf-8"
        )
        mock_storage = MagicMock()
        mock_storage.recreated_due_to_corruption = False
        mock_storage.count_embeddings.return_value = 50
        with patch("horus_source.cli.main.create_backend", return_value=mock_storage):
            _, _, needs_index = _open_host_storage(tmp_path, auto_index=True)

        assert needs_index is False
        meta = json.loads((source_dir / "meta.json").read_text(encoding="utf-8"))
        assert meta["store_backend"] == "sqlite"
        assert meta["store_format_version"] == 1


class TestRunHostIndexing:
    def test_runs_pipeline_for_fresh_repo_and_clears_flag(self, tmp_path: Path) -> None:
        from horus_source.core.ingestion.pipeline import PipelineResult
        from horus_source.runtime import HorusRuntime

        runtime = HorusRuntime(storage=MagicMock(), repo_path=tmp_path, indexing=True)
        source_dir = tmp_path / ".horus" / "source"
        source_dir.mkdir(parents=True)
        with patch(
            "horus_source.cli.main.run_pipeline",
            return_value=(MagicMock(), PipelineResult()),
        ) as mock_pipeline:
            with patch("horus_source.cli.main._register_in_global_registry"):
                _run_host_indexing(MagicMock(), tmp_path, True, runtime)
        mock_pipeline.assert_called_once()
        assert (source_dir / "meta.json").exists()
        assert runtime.indexing is False

    def test_reembed_path_when_index_exists(self, tmp_path: Path) -> None:
        from horus_source.runtime import HorusRuntime

        runtime = HorusRuntime(storage=MagicMock(), repo_path=tmp_path, indexing=True)
        with patch("horus_source.cli.main.run_pipeline") as mock_pipeline:
            with patch(
                "horus_source.cli.main.ensure_current_embeddings", return_value=True
            ) as mock_embed:
                _run_host_indexing(MagicMock(), tmp_path, False, runtime)
        mock_pipeline.assert_not_called()
        mock_embed.assert_called_once()
        assert runtime.indexing is False

    def test_clears_flag_even_on_failure(self, tmp_path: Path) -> None:
        from horus_source.runtime import HorusRuntime

        runtime = HorusRuntime(storage=MagicMock(), repo_path=tmp_path, indexing=True)
        with patch(
            "horus_source.cli.main.run_pipeline", side_effect=RuntimeError("boom")
        ):
            _run_host_indexing(MagicMock(), tmp_path, True, runtime)  # must not raise
        assert runtime.indexing is False
