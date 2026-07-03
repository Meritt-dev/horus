#!/usr/bin/env bash
# Horus release script — for local / emergency releases.
#
# In normal development, pushing to master triggers .github/workflows/release.yml
# which handles everything automatically. Use this script only when CI is
# unavailable or you need to release from a local machine.
#
# Release order:
#   0. Preflight (gh auth + clean working tree + remote reachability)
#   1. Sync versions (apps/horus/package.json + packages/core/src/version.ts)
#   2. Install deps
#   3. Typecheck
#   4. Build  (path-scoped: ./apps/horus to avoid race with root 'horus' package)
#   5. Smoke test
#   6. Commit + tag
#   7. Push commit + tag
#   8. Build platform archives (Homebrew)
#   9. Prepare release artifact + checksum (install.sh)
#  10. Create GitHub Release + upload all artifacts
#  11. Publish to npm
#  12. Update Homebrew formula + push to tap
#  13. Verify artifact reachability
#
# Usage:
#   ./scripts/release.sh [version]   # defaults to apps/horus/package.json version
#
# Prerequisites:
#   gh auth login
#   HOMEBREW_TAP_TOKEN env var (GitHub PAT with write access to meritt-dev/homebrew-tap)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HORUS_REPO="meritt-dev/horus"

bold()  { printf '\033[1m%s\033[0m' "$*"; }
dim()   { printf '\033[2m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
cyan()  { printf '\033[36m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
yellow(){ printf '\033[33m%s\033[0m' "$*"; }

info() { printf '  %s %s\n' "$(cyan '→')" "$*"; }
ok()   { printf '  %s %s\n' "$(green '✓')" "$*"; }
warn() { printf '  %s %s\n' "$(yellow '!')" "$*"; }
die()  { printf '\n  %s %s\n\n' "$(red '✗')" "$*" >&2; exit 1; }

sha256_file() {
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum &>/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    die "sha256 tool not found (need shasum or sha256sum)"
  fi
}

# Produce "HASH  basename" — the format install.sh expects when validating downloads.
sha256sum_named() {
  local file="$1" base
  base="$(basename "$file")"
  if command -v shasum &>/dev/null; then
    shasum -a 256 "$file" | awk -v n="$base" '{print $1 "  " n}'
  elif command -v sha256sum &>/dev/null; then
    sha256sum "$file" | awk -v n="$base" '{print $1 "  " n}'
  else
    die "sha256 tool not found (need shasum or sha256sum)"
  fi
}

APP_DIR="$ROOT/apps/horus"
APP_PKG="$APP_DIR/package.json"
VERSION_FILE="$ROOT/packages/core/src/version.ts"

# ── version ──────────────────────────────────────────────────────────────────

if [ -n "${1:-}" ]; then
  VERSION="$1"
else
  VERSION="$(node -e "const {version}=JSON.parse(require('fs').readFileSync('$APP_PKG','utf8')); process.stdout.write(version)")"
fi

TAG="v${VERSION}"

printf '\n  %s\n\n' "$(bold "⚡ Horus release: ${TAG}")"

# ── 0. preflight ──────────────────────────────────────────────────────────────

info "Running preflight checks"

command -v gh &>/dev/null \
  || die "gh (GitHub CLI) is not installed.
  Install from https://cli.github.com and run 'gh auth login', then re-run."
gh auth status &>/dev/null \
  || die "gh is not authenticated. Run 'gh auth login', then re-run."
ok "  gh authenticated"

[ -n "${HOMEBREW_TAP_TOKEN:-}" ] \
  || die "HOMEBREW_TAP_TOKEN is not set.
  Export a GitHub PAT with write access to meritt-dev/homebrew-tap and re-run."
ok "  HOMEBREW_TAP_TOKEN present"

git -C "$ROOT" diff --quiet HEAD \
  || die "Uncommitted changes in horus repo. Commit or stash before releasing."
[ -z "$(git -C "$ROOT" ls-files --others --exclude-standard)" ] \
  || die "Untracked files present. Stage or remove them before releasing."
ok "  Working tree clean"

git -C "$ROOT" ls-remote --exit-code origin &>/dev/null \
  || die "Cannot reach origin remote. Check network/credentials."
ok "  Remote access confirmed"

ok "Preflight passed"

# ── 1. version sync ───────────────────────────────────────────────────────────

info "Setting version ${VERSION}"

node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('$APP_PKG', 'utf8'));
  p.version = '$VERSION';
  fs.writeFileSync('$APP_PKG', JSON.stringify(p, null, 2) + '\n');
"
ok "  apps/horus/package.json → ${VERSION}"

# The backend ships inside the bundle — one bundle, one version. Stamp the
# python package (and its lockfile's self-version) with the same number.
SOURCE_PY="$ROOT/packages/source-py"
python3 - "$VERSION" "$SOURCE_PY" <<'PYEOF'
import re, sys
version = sys.argv[1]
src = sys.argv[2]
pp = f"{src}/pyproject.toml"
s = open(pp).read()
s, n = re.subn(r'^version = "[^"]+"', f'version = "{version}"', s, count=1, flags=re.M)
assert n == 1, "pyproject version line not found"
open(pp, "w").write(s)
lock = f"{src}/uv.lock"
s = open(lock).read()
s, n = re.subn(
    r'(name = "horus-source"\nversion = ")[^"]+(")',
    rf'\g<1>{version}\g<2>', s, count=1)
assert n == 1, "uv.lock horus-source entry not found"
open(lock, "w").write(s)
PYEOF
ok "  packages/source-py pyproject.toml + uv.lock → ${VERSION}"

# ── 2. install ────────────────────────────────────────────────────────────────

info "Installing dependencies"
pnpm install --frozen-lockfile

# ── 3. typecheck ──────────────────────────────────────────────────────────────

info "Type-checking (all workspace packages)"
pnpm typecheck

# ── 4. build ──────────────────────────────────────────────────────────────────

info "Building bundled source-intelligence wheel (frontend + uv build + verify)"
"$ROOT/scripts/release/build-source-wheel.sh"
ok "  Wheel staged: packages/source-py/dist/horus_source.whl"

info "Building self-contained binary: apps/horus/dist/index.cjs"
pnpm --filter ./apps/horus build

[ -f "$APP_DIR/dist/horus_source.whl" ] \
  || die "Bundled wheel missing from apps/horus/dist — tsup did not copy it."

DIST_FILE="$APP_DIR/dist/index.cjs"
[ -f "$DIST_FILE" ] || die "Build output not found: $DIST_FILE"
ok "Built: $DIST_FILE ($(du -sh "$DIST_FILE" | cut -f1))"

# ── 5. smoke test ─────────────────────────────────────────────────────────────

info "Running smoke test"
"$ROOT/scripts/smoke-test.sh" apps/horus/dist/index.cjs
ok "Smoke test passed"

# ── 6. commit + tag ───────────────────────────────────────────────────────────

info "Committing and tagging ${TAG}"

git -C "$ROOT" add apps/horus/package.json packages/source-py/pyproject.toml packages/source-py/uv.lock
git -C "$ROOT" commit -m "chore: release ${TAG}"
git -C "$ROOT" tag -a "$TAG" -m "Horus ${TAG}"
ok "  Committed and tagged ${TAG}"

# ── 7. push ───────────────────────────────────────────────────────────────────

info "Pushing to origin"
git -C "$ROOT" push origin master \
  || die "Failed to push master — aborting before GitHub Release creation."
git -C "$ROOT" push origin "$TAG" \
  || die "Failed to push tag ${TAG} — aborting before GitHub Release creation."
ok "  Pushed master + ${TAG}"

# ── 8. build platform archives ────────────────────────────────────────────────

info "Building platform archives for Homebrew"
"$ROOT/scripts/homebrew/build-archives.sh" "$VERSION" "$DIST_FILE"
ok "  Platform archives built in .homebrew-archives/"

# ── 9. prepare release artifact ───────────────────────────────────────────────

ARTIFACT_NAME="horus-${TAG}"
ARTIFACT_FILE="$APP_DIR/dist/${ARTIFACT_NAME}"
CHECKSUM_FILE="${ARTIFACT_FILE}.sha256"

cp "$DIST_FILE" "$ARTIFACT_FILE"
chmod +x "$ARTIFACT_FILE"
sha256sum_named "$ARTIFACT_FILE" > "$CHECKSUM_FILE"

ok "Artifact: ${ARTIFACT_FILE} ($(du -sh "$ARTIFACT_FILE" | cut -f1))"
ok "Checksum: $(cat "$CHECKSUM_FILE")"

# ── 10. create github release ─────────────────────────────────────────────────

info "Creating GitHub Release ${TAG}"

ARCHIVES_DIR="$ROOT/.homebrew-archives"

gh release create "$TAG" \
  --title "Horus ${TAG}" \
  --notes "## Install

\`\`\`bash
curl -fsSL https://horus.sh/install.sh | bash
\`\`\`

## Requirements

- Node.js 22+ (self-contained executable)
- Python 3.11+ with uv or pip (optional — source-intelligence features)

## Also available via

\`\`\`bash
npm install -g @merittdev/horus
brew install meritt-dev/tap/horus
\`\`\`

## Direct download (Linux / macOS)

\`\`\`bash
curl -fsSL https://github.com/${HORUS_REPO}/releases/download/${TAG}/horus-${TAG} -o horus
chmod +x horus && sudo mv horus /usr/local/bin/horus
horus --version
\`\`\`

## Checksum (sha256)

\`\`\`
$(cat "$CHECKSUM_FILE")  horus-${TAG}
\`\`\`" \
  "$ARTIFACT_FILE" \
  "$CHECKSUM_FILE" \
  "$APP_DIR/dist/horus_source.whl" \
  "${ARCHIVES_DIR}/horus-${TAG}-darwin-arm64.tar.gz" \
  "${ARCHIVES_DIR}/horus-${TAG}-darwin-arm64.tar.gz.sha256" \
  "${ARCHIVES_DIR}/horus-${TAG}-darwin-x86_64.tar.gz" \
  "${ARCHIVES_DIR}/horus-${TAG}-darwin-x86_64.tar.gz.sha256" \
  "${ARCHIVES_DIR}/horus-${TAG}-linux-arm64.tar.gz" \
  "${ARCHIVES_DIR}/horus-${TAG}-linux-arm64.tar.gz.sha256" \
  "${ARCHIVES_DIR}/horus-${TAG}-linux-x86_64.tar.gz" \
  "${ARCHIVES_DIR}/horus-${TAG}-linux-x86_64.tar.gz.sha256" \
  || die "gh release create failed — tag is pushed but Release was not created.
  Run 'gh release create ${TAG} ...' manually with the artifacts in $APP_DIR/dist/ and ${ARCHIVES_DIR}/"

ok "GitHub Release: https://github.com/${HORUS_REPO}/releases/tag/${TAG}"

# ── 11. publish to npm ────────────────────────────────────────────────────────

info "Publishing to npm"
(cd "$APP_DIR" && npm publish --access public) \
  || die "npm publish failed. Check npm credentials and re-run."
ok "Published @merittdev/horus@${VERSION} to npm"

# ── 12. update homebrew formula ───────────────────────────────────────────────

info "Updating Homebrew formula"
"$ROOT/scripts/homebrew/update-formula.sh" "$VERSION"
ok "  Formula updated: homebrew-tap/Formula/horus.rb"

info "Pushing Homebrew formula to tap"
TMPDIR_TAP="$(mktemp -d)"
git clone \
  "https://x-access-token:${HOMEBREW_TAP_TOKEN}@github.com/meritt-dev/homebrew-tap.git" \
  "$TMPDIR_TAP"
cp "$ROOT/homebrew-tap/Formula/horus.rb" "$TMPDIR_TAP/Formula/horus.rb"
git -C "$TMPDIR_TAP" config user.name "$(git -C "$ROOT" config user.name)"
git -C "$TMPDIR_TAP" config user.email "$(git -C "$ROOT" config user.email)"
git -C "$TMPDIR_TAP" add Formula/horus.rb
if ! git -C "$TMPDIR_TAP" diff --cached --quiet; then
  git -C "$TMPDIR_TAP" commit -m "chore: horus ${TAG}"
  git -C "$TMPDIR_TAP" push origin master
  ok "  Pushed formula to meritt-dev/homebrew-tap"
else
  ok "  Formula unchanged — nothing to push"
fi
rm -rf "$TMPDIR_TAP"

# ── 13. verify artifact reachability ──────────────────────────────────────────

info "Verifying release artifact is reachable"
RELEASE_URL="https://github.com/${HORUS_REPO}/releases/download/${TAG}/${ARTIFACT_NAME}"
VERIFIED=0
for attempt in 1 2 3; do
  HTTP_STATUS="$(curl -sIL -o /dev/null -w '%{http_code}' "${RELEASE_URL}" 2>/dev/null || true)"
  if [ "${HTTP_STATUS}" = "200" ]; then
    ok "Artifact reachable (attempt ${attempt}): ${RELEASE_URL}"
    VERIFIED=1
    break
  fi
  if [ "${attempt}" -lt 3 ]; then
    warn "Attempt ${attempt}: HTTP ${HTTP_STATUS} — waiting 10s before retry"
    sleep 10
  fi
done

[ "${VERIFIED}" -eq 1 ] \
  || die "Artifact not reachable after 3 attempts (HTTP ${HTTP_STATUS}).
  The release was created — verify manually:
    ${RELEASE_URL}"

# ── done ──────────────────────────────────────────────────────────────────────

printf '\n  %s\n\n' "$(green "$(bold "✓ Horus ${TAG} released")")"
printf '  %s\n' "GitHub:  https://github.com/${HORUS_REPO}/releases/tag/${TAG}"
printf '  %s\n' "npm:     https://www.npmjs.com/package/@merittdev/horus"
printf '  %s\n' "Install: curl -fsSL https://horus.sh/install.sh | bash"
printf '\n'
