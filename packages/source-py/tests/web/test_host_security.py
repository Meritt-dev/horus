"""Host-header validation (DNS-rebinding defense) for the local web server.

A browser page on an attacker-controlled domain that resolves to 127.0.0.1
sends its own domain in the Host header. Rejecting non-loopback Host values
stops it from driving the API / the mounted /mcp transport, which have no auth.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from horus_source.core.graph.model import GraphNode, NodeLabel
from horus_source.core.storage.sqlite_backend import SqliteBackend
from horus_source.web.app import create_app


@pytest.fixture()
def db_path(tmp_path: Path) -> Path:
    p = tmp_path / "horus.db"
    b = SqliteBackend()
    b.initialize(p)
    b.add_nodes(
        [GraphNode(id="function:src/a.py:foo", label=NodeLabel.FUNCTION, name="foo", file_path="src/a.py")]
    )
    b.close()
    return p


def test_loopback_host_is_accepted(db_path: Path) -> None:
    app = create_app(db_path=db_path, mount_frontend=False)
    client = TestClient(app)  # default Host: testserver (allowed)
    assert client.get("/api/health").status_code == 200
    # An explicit loopback Host with a port is accepted too.
    r = client.get("/api/health", headers={"host": "127.0.0.1:8420"})
    assert r.status_code == 200


def test_foreign_host_is_rejected(db_path: Path) -> None:
    app = create_app(db_path=db_path, mount_frontend=False)
    client = TestClient(app)
    for evil in ("evil.com", "attacker.example", "169.254.169.254"):
        r = client.get("/api/health", headers={"host": evil})
        assert r.status_code == 400, f"{evil} should be rejected"


def test_public_bind_opt_out_allows_any_host(db_path: Path) -> None:
    # strict_host=False mirrors an explicit --bind 0.0.0.0 (operator opted into
    # LAN exposure); Host validation is relaxed so LAN clients can connect.
    app = create_app(db_path=db_path, mount_frontend=False, strict_host=False)
    client = TestClient(app)
    r = client.get("/api/health", headers={"host": "some-lan-box.local"})
    assert r.status_code == 200


def test_cors_does_not_allow_credentials(db_path: Path) -> None:
    app = create_app(db_path=db_path, mount_frontend=False)
    client = TestClient(app)
    r = client.get(
        "/api/health",
        headers={"host": "127.0.0.1", "origin": "http://localhost:5173"},
    )
    # The API uses no cookies/auth, so credentialed cross-origin calls must not
    # be blessed.
    assert r.headers.get("access-control-allow-credentials") != "true"
