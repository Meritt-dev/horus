"""D6: the durable index meta stamps the analysis-capability version.

The CLI/connector reads ``capability_version`` from ``.horus/source/meta.json`` to decide
whether a stale index needs a reindex (inheritance-aware blast radius). This locks the stamp
to the single source of truth in ``horus_source.capabilities`` so a bump can't silently drop
out of the written meta.
"""

from __future__ import annotations

from pathlib import Path

from horus_source.capabilities import INDEX_CAPABILITY_VERSION
from horus_source.cli.main import _build_meta
from horus_source.core.ingestion.pipeline import PipelineResult


def test_build_meta_stamps_capability_version(tmp_path: Path) -> None:
    result = PipelineResult(files=3, symbols=42, embeddings=42, embeddings_expected=42)
    meta = _build_meta(result, tmp_path)

    assert meta["capability_version"] == INDEX_CAPABILITY_VERSION
    # Current capability is inheritance-aware blast radius (v2); guards a silent regression.
    assert INDEX_CAPABILITY_VERSION >= 2
