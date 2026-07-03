#!/usr/bin/env bash
# Build per-platform Homebrew archives and SHA-256 checksums for Horus.
#
# Usage:
#   ./scripts/homebrew/build-archives.sh [version] [source-executable]
#
# Defaults:
#   version          -> apps/horus/package.json version
#   source-executable -> apps/horus/dist/index.cjs
#
# Output:
#   .homebrew-archives/horus-v<VERSION>-<OS>-<ARCH>.tar.gz
#   .homebrew-archives/horus-v<VERSION>-<OS>-<ARCH>.tar.gz.sha256

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_PKG="$ROOT/apps/horus/package.json"

VERSION="${1:-$(node -e "const {version}=JSON.parse(require('fs').readFileSync('$APP_PKG','utf8')); process.stdout.write(version)")}"
SOURCE="${2:-$ROOT/apps/horus/dist/index.cjs}"
OUTDIR="$ROOT/.homebrew-archives"

# pglite (the embedded local database) loads these WASM/FS assets at runtime via
# `new URL('./pglite.wasm', import.meta.url)`, which resolves relative to the RESOLVED
# path of the binary. We ship them as siblings of the binary inside the archive so the
# Homebrew layout (binary in libexec, symlinked from bin) finds them — see the formula's
# `libexec.install` + `bin.install_symlink`. Without these, the CLI falls back to
# display-only (openDb's graceful fallback), so a missing asset is not fatal.
SOURCE_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
PGLITE_ASSETS=(pglite.wasm pglite.data initdb.wasm)

if [ ! -f "$SOURCE" ]; then
  echo "Source executable not found: $SOURCE" >&2
  exit 1
fi

mkdir -p "$OUTDIR"

sha256_file() {
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "sha256 tool not found" >&2
    exit 1
  fi
}

for platform in darwin-arm64 darwin-x86_64 linux-arm64 linux-x86_64; do
  IFS='-' read -r OS ARCH <<< "$platform"
  ARTIFACT="horus-v${VERSION}-${platform}.tar.gz"
  ARTIFACT_PATH="$OUTDIR/$ARTIFACT"
  TMP=$(mktemp -d)

  # Lay out the binary and its sibling pglite assets together. The formula installs the
  # whole `libexec/` dir, then symlinks `bin/horus → libexec/horus`. Node resolves the
  # symlink before evaluating `import.meta.url`, so the binary's resolved path is the
  # libexec one and the assets sit right next to it.
  mkdir -p "$TMP/horus/libexec"
  cp "$SOURCE" "$TMP/horus/libexec/horus"
  chmod +x "$TMP/horus/libexec/horus"
  for asset in "${PGLITE_ASSETS[@]}"; do
    if [ -f "$SOURCE_DIR/$asset" ]; then
      cp "$SOURCE_DIR/$asset" "$TMP/horus/libexec/$asset"
    else
      echo "Warning: pglite asset not found, archive will fall back to display-only: $SOURCE_DIR/$asset" >&2
    fi
  done

  # The bundled source-intelligence wheel (one bundle, one version — no PyPI).
  # `horus update`/init install the backend from this sibling of the binary.
  if [ -f "$SOURCE_DIR/horus_source.whl" ]; then
    cp "$SOURCE_DIR/horus_source.whl" "$TMP/horus/libexec/horus_source.whl"
  else
    echo "Warning: bundled source wheel not found — backend install will point at the installer: $SOURCE_DIR/horus_source.whl" >&2
  fi

  tar -czf "$ARTIFACT_PATH" -C "$TMP" horus
  rm -rf "$TMP"

  CHECKSUM=$(sha256_file "$ARTIFACT_PATH")
  echo "${CHECKSUM}  ${ARTIFACT}" > "$ARTIFACT_PATH.sha256"

  echo "Built: $ARTIFACT_PATH"
  echo "Checksum: ${CHECKSUM}"
done
