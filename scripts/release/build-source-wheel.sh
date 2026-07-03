#!/usr/bin/env bash
# Build the source-intelligence backend wheel that ships INSIDE the horus bundle.
#
# One bundle, one version: the wheel is built from packages/source-py (the single
# source of truth — no PyPI, no separate repo) and staged at a fixed path,
# packages/source-py/dist/horus_source.whl, where apps/horus's tsup build copies
# it next to index.cjs. `horus update` / the installer install the backend from
# that bundled wheel.
#
#   1. Build the React frontend (its dist/ is git-ignored — must be rebuilt).
#   2. uv build --wheel
#   3. Verify contents (package code + built frontend) via verify_wheel.py.
#   4. Stage under the fixed name horus_source.whl.
#
# Usage: scripts/release/build-source-wheel.sh
# Requires: node/npm (frontend), uv, python3.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/packages/source-py"

echo "→ Building source-intelligence frontend"
(cd "$SRC/src/horus_source/web/frontend" && npm ci --silent && npm run build --silent)

echo "→ Building wheel"
rm -rf "$SRC/dist"
(cd "$SRC" && uv build --wheel --quiet)

echo "→ Verifying wheel contents"
python3 "$SRC/scripts/verify_wheel.py" "$SRC/dist"

WHL="$(ls "$SRC"/dist/horus_source-*.whl)"
cp "$WHL" "$SRC/dist/horus_source.whl"
echo "→ Staged $(basename "$WHL") as packages/source-py/dist/horus_source.whl"
