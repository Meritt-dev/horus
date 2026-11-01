# source-py: the source-intelligence backend

This directory is the only source of the horus-source Python backend (tree-sitter source
intelligence: FastAPI host, SQLite + sqlite-vec + FTS5, local embeddings). It moved here
from the TypeScript repo, now archived as `Meritt-dev/horus-ts`, at commit `0a57a3a`.
Older history is in that repo. The standalone `Meritt-dev/horus-source` repo is archived
and PyPI releases are retired. Change the backend here only.

## How it ships

- Every release builds the wheel from this directory. `.github/build-setup.yml` stamps
  `pyproject.toml` and `uv.lock` to the release version, runs
  `scripts/release/build-source-wheel.sh` (frontend build, `uv build --wheel`,
  `scripts/verify_wheel.py`), and copies `dist/horus_source.whl` to
  `crates/cli/horus_source.whl`. dist packs it into every archive, and the npm and
  Homebrew packages carry it beside the binary.
- The CLI pins the backend to its own version (`PINNED_SOURCE_VERSION == HORUS_VERSION`).
  `horus init` and `horus update` install the bundled wheel with `uv tool install`. Its
  third-party dependencies still resolve from PyPI, as for any package install.
- MCP stays on the 1.x API. The shared-host stdio proxy uses `streamablehttp_client`,
  which MCP 2 removed. CI also installs this package into a fresh tool environment, so a
  dependency release outside `uv.lock` can't ship a backend that fails at startup.
- The backend has no update notifier of its own. The horus CLI owns updates.

## Working in here

```bash
cd packages/source-py
uv sync --extra dev
uv run pytest -q
uvx ruff check src/ tests/
```

CI (`.github/workflows/source-py.yml`) runs ruff, `uv lock --check`, the fresh-install
startup check and the full pytest suite on every pull request that touches this directory.
