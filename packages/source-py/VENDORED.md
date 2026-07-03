# source-py — the source-intelligence backend (canonical since HOR-450 step B)

This directory **IS the single source of truth** for the horus-source Python backend
(tree-sitter source intelligence: FastAPI host, SQLite+sqlite-vec+FTS5, local
embeddings). The standalone `Meritt-dev/horus-source` repo is **archived** and PyPI
releases are **retired** — do not edit or release from either.

## One bundle, one version, one codebase

- The backend ships **inside the horus release bundle**: `scripts/release/
  build-source-wheel.sh` builds the frontend + wheel from this directory, verifies it
  (`scripts/verify_wheel.py`), and stages `dist/horus_source.whl`, which the apps/horus
  tsup build copies next to `index.cjs`. It lands in the npm package, the Homebrew
  platform archives, and as a GitHub release asset for the curl installer.
- The wheel's version is stamped to the horus release version by `scripts/release.sh` /
  the Release workflow (`pyproject.toml` + `uv.lock` self-version). The CLI's
  `PINNED_SOURCE_VERSION` is `HORUS_VERSION` — the pin is "same bundle" by construction.
- `horus init` and `horus update` install the backend from the bundled wheel via
  `uv tool install` (the wheel's third-party dependencies still resolve from PyPI as a
  normal package install; that is dependency resolution, not a deployment of our code).
- The backend's own PyPI update notifier is removed — the horus CLI owns updates.

## Working in here

```bash
cd packages/source-py
uv sync --extra dev
uv run pytest -q
uvx ruff check src/ tests/
```

CI (`.github/workflows/ci.yml`, `source-py` job) gates every PR on ruff,
`uv lock --check`, and the full pytest suite.

## History

Step A (HOR-450) vendored the tree from the standalone repo while that repo remained
canonical. Step B (this state) made the vendored tree canonical, archived the standalone
repo, retired PyPI, and folded the backend into the horus release bundle — ending the
paired-version dance the HOR-436 pin guard existed to manage.
