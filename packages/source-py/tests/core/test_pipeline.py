from __future__ import annotations

import io
import re
from pathlib import Path
from unittest.mock import patch

import pytest

from horus_source.core.ingestion.pipeline import (
    PipelineResult,
    format_liveness_line,
    run_pipeline,
)
from horus_source.core.storage.kuzu_backend import KuzuBackend


@pytest.fixture()
def tmp_repo(tmp_path: Path) -> Path:
    """Create a small Python repository under a temporary directory.

    Layout::

        tmp_repo/
        +-- src/
            +-- main.py    (imports validate from auth, calls it)
            +-- auth.py    (imports helper from utils, calls it)
            +-- utils.py   (standalone helper function)
    """
    src = tmp_path / "src"
    src.mkdir()

    (src / "main.py").write_text(
        "from .auth import validate\n"
        "\n"
        "def main():\n"
        "    validate()\n",
        encoding="utf-8",
    )

    (src / "auth.py").write_text(
        "from .utils import helper\n"
        "\n"
        "def validate():\n"
        "    helper()\n",
        encoding="utf-8",
    )

    (src / "utils.py").write_text(
        "def helper():\n"
        "    pass\n",
        encoding="utf-8",
    )

    return tmp_path


@pytest.fixture()
def storage(tmp_path: Path) -> KuzuBackend:
    """Provide an initialised KuzuBackend for testing."""
    db_path = tmp_path / "test_db"
    backend = KuzuBackend()
    backend.initialize(db_path)
    yield backend
    backend.close()


class TestRunPipelineBasic:
    def test_run_pipeline_basic(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        _, result = run_pipeline(tmp_repo, storage)

        assert isinstance(result, PipelineResult)
        assert result.duration_seconds > 0.0


class TestRunPipelineFileCount:
    def test_run_pipeline_file_count(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        _, result = run_pipeline(tmp_repo, storage)

        assert result.files == 3


class TestRunPipelineFindsSymbols:
    def test_run_pipeline_finds_symbols(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        _, result = run_pipeline(tmp_repo, storage)

        assert result.symbols >= 3


class TestRunPipelineFindsRelationships:
    def test_run_pipeline_finds_relationships(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        _, result = run_pipeline(tmp_repo, storage)

        assert result.relationships > 0


class TestRunPipelineProgressCallback:
    def test_run_pipeline_progress_callback(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        calls: list[tuple[str, float]] = []

        def callback(phase: str, pct: float) -> None:
            calls.append((phase, pct))

        run_pipeline(tmp_repo, storage, progress_callback=callback)

        # At minimum, every phase should report start (0.0) and end (1.0).
        assert len(calls) >= 2

        phase_names = {name for name, _ in calls}
        assert "Walking files" in phase_names
        assert "Processing structure" in phase_names
        assert "Parsing code" in phase_names
        assert "Resolving imports" in phase_names
        assert "Resolving relationships" in phase_names
        assert "Loading to storage" in phase_names


class TestRunPipelineStructuralCallback:
    def test_on_structural_complete_fires_after_bulk_load(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        # B1.1: the hook must fire once, AFTER the structural graph is persisted
        # (bulk_load) but BEFORE the embedding phase — so a caller can serve
        # structural queries while embeddings warm. ``result.embeddings`` is still 0.
        captured: dict[str, object] = {}
        calls = {"n": 0}

        def hook(result: PipelineResult) -> None:
            calls["n"] += 1
            captured["symbols"] = result.symbols
            captured["embeddings"] = result.embeddings
            # The structural graph is already queryable in storage at hook time.
            captured["node"] = storage.get_node("file:src/main.py:")

        _, result = run_pipeline(
            tmp_repo, storage, embeddings=False, on_structural_complete=hook
        )

        assert calls["n"] == 1
        assert captured["symbols"] == result.symbols
        assert captured["symbols"] >= 3  # structural symbols present at hook time
        assert captured["embeddings"] == 0  # embeddings not yet counted
        assert captured["node"] is not None  # structural nodes already persisted

    def test_no_callback_when_storage_absent(self, tmp_repo: Path) -> None:
        # No storage → no bulk_load → the structural-complete hook never fires.
        calls = {"n": 0}

        def hook(_result: PipelineResult) -> None:
            calls["n"] += 1

        run_pipeline(tmp_repo, storage=None, on_structural_complete=hook)
        assert calls["n"] == 0


class TestLivenessLines:
    def test_format_liveness_line_shape(self) -> None:
        # Plain, non-Rich, single line carrying phase / files / elapsed (B1.3).
        line = format_liveness_line("Walking files", 0.5, 42, 3.14)
        assert line == "[horus-source] phase='Walking files' pct=50% files=42 elapsed=3.1s"
        # No ANSI / Rich markup — safe to surface verbatim from a non-tty stream.
        assert "\x1b" not in line
        assert "[/" not in line

    def test_liveness_stream_emits_plain_lines(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        # B1.3: analyze runs under execFile (non-tty) where the Rich transient bar
        # renders nothing. With a liveness_stream, run_pipeline must emit plain,
        # structured progress lines a TS caller can tail to see it is not hung.
        stream = io.StringIO()
        run_pipeline(
            tmp_repo, storage, embeddings=False, liveness_stream=stream
        )

        out = stream.getvalue()
        lines = [ln for ln in out.splitlines() if ln]
        assert lines, "expected at least one liveness line"

        # Every line matches the structured, plain shape (no Rich markup / ANSI).
        pattern = re.compile(
            r"^\[horus-source\] phase='.+' pct=\d+% files=\d+ elapsed=[\d.]+s$"
        )
        for ln in lines:
            assert pattern.match(ln), f"unexpected liveness line: {ln!r}"

        # Phase coverage — the structural phases are announced.
        joined = "\n".join(lines)
        assert "Walking files" in joined
        assert "Loading to storage" in joined

        # files-processed is surfaced once the walk completes (3 files in tmp_repo).
        assert "files=3" in joined

    def test_no_liveness_stream_emits_nothing_extra(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        # Back-compat: without a stream, the progress_callback path is unchanged.
        calls: list[tuple[str, float]] = []

        def callback(phase: str, pct: float) -> None:
            calls.append((phase, pct))

        run_pipeline(
            tmp_repo, storage, embeddings=False, progress_callback=callback
        )
        assert calls  # callback still fires as before

    def test_liveness_write_failure_never_aborts(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        # A closed pipe (TS caller stopped tailing) must not crash the pipeline.
        class _Broken(io.StringIO):
            def write(self, _s: str) -> int:  # type: ignore[override]
                raise BrokenPipeError("downstream gone")

        _, result = run_pipeline(
            tmp_repo, storage, embeddings=False, liveness_stream=_Broken()
        )
        assert result.symbols >= 3  # pipeline completed despite the broken stream


class TestRunPipelineLoadsToStorage:
    def test_run_pipeline_loads_to_storage(
        self, tmp_repo: Path, storage: KuzuBackend
    ) -> None:
        run_pipeline(tmp_repo, storage)

        # File nodes should be stored. The walker produces paths relative to
        # repo root, so "src/main.py" should exist as a File node.
        node = storage.get_node("file:src/main.py:")
        assert node is not None
        assert node.name == "main.py"


@pytest.fixture()
def rich_repo(tmp_path: Path) -> Path:
    """Create a repository with classes and type annotations for phases 7-11.

    Layout::

        rich_repo/
        +-- src/
            +-- models.py   (User class)
            +-- auth.py     (validate function using User type, calls check)
            +-- check.py    (check function, calls verify)
            +-- verify.py   (verify function -- standalone, no callers)
            +-- unused.py   (orphan function -- dead code candidate)
    """
    src = tmp_path / "src"
    src.mkdir()

    (src / "models.py").write_text(
        "class User:\n"
        "    def __init__(self, name: str):\n"
        "        self.name = name\n",
        encoding="utf-8",
    )

    (src / "auth.py").write_text(
        "from .models import User\n"
        "from .check import check\n"
        "\n"
        "def validate(user: User) -> bool:\n"
        "    return check(user)\n",
        encoding="utf-8",
    )

    (src / "check.py").write_text(
        "from .verify import verify\n"
        "\n"
        "def check(obj) -> bool:\n"
        "    return verify(obj)\n",
        encoding="utf-8",
    )

    (src / "verify.py").write_text(
        "def verify(obj) -> bool:\n"
        "    return obj is not None\n",
        encoding="utf-8",
    )

    (src / "unused.py").write_text(
        "def orphan_func():\n"
        "    pass\n",
        encoding="utf-8",
    )

    return tmp_path


@pytest.fixture()
def rich_storage(tmp_path: Path) -> KuzuBackend:
    """Provide an initialised KuzuBackend for the rich repo tests."""
    db_path = tmp_path / "rich_db"
    backend = KuzuBackend()
    backend.initialize(db_path)
    yield backend
    backend.close()


class TestRunPipelineFullPhases:
    def test_run_pipeline_full_phases(
        self, rich_repo: Path, rich_storage: KuzuBackend
    ) -> None:
        _, result = run_pipeline(rich_repo, rich_storage)

        # Basic sanity checks.
        assert isinstance(result, PipelineResult)
        assert result.files == 5
        assert result.symbols >= 5  # User, __init__, validate, check, verify, orphan_func
        assert result.relationships > 0
        assert result.duration_seconds > 0.0

        # Phase 8 (communities) and Phase 9 (processes) return ints >= 0.
        # The exact count depends on the graph structure, but they must be
        # non-negative integers.
        assert isinstance(result.clusters, int)
        assert result.clusters >= 0

        assert isinstance(result.processes, int)
        assert result.processes >= 0

        # Phase 10 (dead code): orphan_func has no callers and is not a
        # constructor, test function, or dunder -- it should be flagged.
        assert isinstance(result.dead_code, int)
        assert result.dead_code >= 1

        # Phase 11 (coupling): no git repo, so coupling should be 0.
        assert isinstance(result.coupled_pairs, int)
        assert result.coupled_pairs == 0


class TestRunPipelineProgressIncludesNewPhases:
    def test_run_pipeline_progress_includes_new_phases(
        self, rich_repo: Path, rich_storage: KuzuBackend
    ) -> None:
        calls: list[tuple[str, float]] = []

        def callback(phase: str, pct: float) -> None:
            calls.append((phase, pct))

        run_pipeline(rich_repo, rich_storage, progress_callback=callback)

        phase_names = {name for name, _ in calls}

        # Phases 1-4 (sequential).
        assert "Walking files" in phase_names
        assert "Processing structure" in phase_names
        assert "Parsing code" in phase_names
        assert "Resolving imports" in phase_names

        # Phases 5-7 (concurrent calls/heritage/types).
        assert "Resolving relationships" in phase_names

        # Phases 8-11 (global).
        assert "Detecting communities" in phase_names
        assert "Detecting execution flows" in phase_names
        assert "Finding dead code" in phase_names
        assert "Analyzing git history" in phase_names

        # Storage loading (always present).
        assert "Loading to storage" in phase_names

        # Every phase reports both start (0.0) and end (1.0).
        for phase_name in phase_names:
            phase_pcts = {pct for name, pct in calls if name == phase_name}
            assert 0.0 in phase_pcts, f"{phase_name} missing 0.0 progress"
            assert 1.0 in phase_pcts, f"{phase_name} missing 1.0 progress"


class TestRunPipelineEmbeddings:
    def test_embedding_phase_in_progress(
        self, rich_repo: Path, rich_storage: KuzuBackend
    ) -> None:
        calls: list[tuple[str, float]] = []

        def callback(phase: str, pct: float) -> None:
            calls.append((phase, pct))

        run_pipeline(rich_repo, rich_storage, progress_callback=callback)

        phase_names = {name for name, _ in calls}
        assert "Generating embeddings" in phase_names

    def test_result_symbols_set_even_if_embed_fails(
        self, rich_repo: Path, rich_storage: KuzuBackend
    ) -> None:
        with patch(
            "horus_source.core.ingestion.pipeline.embed_missing",
            side_effect=RuntimeError("model not found"),
        ):
            _, result = run_pipeline(rich_repo, rich_storage)

        # symbols and relationships are computed before the embedding step
        assert result.symbols >= 5
        assert result.relationships > 0
        assert result.embeddings == 0

    def test_no_storage_skips_embedding(self, rich_repo: Path) -> None:
        calls: list[tuple[str, float]] = []

        def callback(phase: str, pct: float) -> None:
            calls.append((phase, pct))

        _, result = run_pipeline(rich_repo, storage=None, progress_callback=callback)

        phase_names = {name for name, _ in calls}
        assert "Generating embeddings" not in phase_names
        assert result.embeddings == 0
