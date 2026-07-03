#!/usr/bin/env bash
# Regenerate homebrew-tap/Formula/horus.rb from the current version and the
# checksums produced by build-archives.sh.
#
# Usage:
#   ./scripts/homebrew/update-formula.sh [version]
#
# Must be run after build-archives.sh has created the .homebrew-archives/ files.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_PKG="$ROOT/apps/horus/package.json"

VERSION="${1:-$(node -e "const {version}=JSON.parse(require('fs').readFileSync('$APP_PKG','utf8')); process.stdout.write(version)")}"
TAG="v${VERSION}"
OUTDIR="$ROOT/.homebrew-archives"
FORMULA="$ROOT/homebrew-tap/Formula/horus.rb"
mkdir -p "$(dirname "$FORMULA")"   # Formula/ holds only this generated (gitignored) file

get_sha() {
  local file="$OUTDIR/horus-${TAG}-${1}.tar.gz.sha256"
  [ -f "$file" ] || { echo "Missing checksum file: $file" >&2; exit 1; }
  awk '{print $1}' "$file"
}

DARWIN_ARM64="$(get_sha darwin-arm64)"
DARWIN_X86="$(get_sha darwin-x86_64)"
LINUX_ARM64="$(get_sha linux-arm64)"
LINUX_X86="$(get_sha linux-x86_64)"

REPO="meritt-dev/horus"

cat > "$FORMULA" <<EOF
class Horus < Formula
  desc "Local-first, source-aware incident investigation engine"
  homepage "https://horus.sh"
  version "${VERSION}"
  license "MIT"

  depends_on "node"

  on_macos do
    on_arm do
      url "https://github.com/${REPO}/releases/download/${TAG}/horus-${TAG}-darwin-arm64.tar.gz"
      sha256 "${DARWIN_ARM64}"
    end
    on_intel do
      url "https://github.com/${REPO}/releases/download/${TAG}/horus-${TAG}-darwin-x86_64.tar.gz"
      sha256 "${DARWIN_X86}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/${REPO}/releases/download/${TAG}/horus-${TAG}-linux-arm64.tar.gz"
      sha256 "${LINUX_ARM64}"
    end
    on_intel do
      url "https://github.com/${REPO}/releases/download/${TAG}/horus-${TAG}-linux-x86_64.tar.gz"
      sha256 "${LINUX_X86}"
    end
  end

  def install
    # The binary loads pglite's WASM/FS assets via new URL('./pglite.wasm',
    # import.meta.url), which resolves relative to the binary's RESOLVED path. Install
    # the binary and its sibling assets together in libexec, then symlink into bin --
    # Node resolves the symlink before evaluating import.meta.url, so it finds the
    # siblings in libexec. (If the assets are absent, the CLI degrades to display-only.)
    libexec.install Dir["libexec/*"]
    bin.install_symlink libexec/"horus"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/horus --version")
    assert_match "Usage: horus", shell_output("#{bin}/horus --help")
  end
end
EOF

echo "Updated: $FORMULA"
echo "  version:       ${VERSION}"
echo "  darwin-arm64:  ${DARWIN_ARM64}"
echo "  darwin-x86_64: ${DARWIN_X86}"
echo "  linux-arm64:   ${LINUX_ARM64}"
echo "  linux-x86_64:  ${LINUX_X86}"
