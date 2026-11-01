"""Tests for the friendly frontend fallback (HOR-391).

When the frontend has not been built (``web/frontend/dist`` is absent — the
source / dev-install case), ``GET /`` must serve a helpful HTML page instead of
falling through to a bare ``{"detail":"Not Found"}`` 404.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from horus_source.runtime import HorusRuntime
from horus_source.web import app as app_module
from horus_source.web.app import create_app


def _app_no_dist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # Point FRONTEND_DIR at a path that does not exist so the StaticFiles mount
    # is skipped and the fallback route is registered instead.
    monkeypatch.setattr(app_module, "FRONTEND_DIR", tmp_path / "frontend" / "dist")
    runtime = HorusRuntime(storage=MagicMock(), repo_path=tmp_path, owns_storage=False)
    return create_app(db_path=tmp_path / "kuzu", runtime=runtime)


def test_root_serves_friendly_fallback_when_dist_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = _app_no_dist(tmp_path, monkeypatch)
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]
    body = response.text
    # Not a bare 404 payload.
    assert '"detail":"Not Found"' not in body
    # Helpful, actionable content.
    assert "/api/health" in body
    assert "/api/overview" in body
    assert "npm run build" in body
    assert "web/frontend" in body


def test_root_is_not_bare_404_when_dist_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = _app_no_dist(tmp_path, monkeypatch)
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code != 404
