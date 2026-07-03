#!/usr/bin/env bash
# HOR-52 — Curl-installed Horus release smoke test
#
# Validates the public curl-installed release path end-to-end.
# This script is the repeatable release acceptance check for the exact path
# a new user runs. It does NOT duplicate the unit/process-level CLI tests
# from HOR-49 (smoke-test.sh handles those).
#
# Usage:
#   ./scripts/acceptance/release-smoke.sh            # assumes horus is on PATH
#   ./scripts/acceptance/release-smoke.sh --install  # curl-installs first, then verifies
#
# Environment variables:
#   INSTALL_URL              override the installer URL (default: https://horus.sh/install.sh)
#   HORUS_BIN                path to horus binary (overrides PATH lookup)
#   HORUS_INSTALL_UNSAFE=1   bypass the existing-binary safety check in --install mode
#   HORUS_EXPECTED_VERSION   if set, --version output must contain exactly this string
#
# Isolation note:
#   --install mode aborts if /usr/local/bin/horus or ~/.local/bin/horus already exists,
#   to avoid overwriting a developer's live binary. Run in a fresh container instead:
#     docker run --rm ubuntu:22.04 bash -c \
#       'apt-get install -y curl nodejs && curl -fsSL https://horus.sh/install.sh | bash && horus --version'
#
# Expected output (all lines should show ✓):
#   ✓ curl install exited 0                        (--install only)
#   ✓ installer output identifies the product as "horus"  (--install only)
#   ✓ horus is on PATH
#   ✓ --version exits 0
#   ✓ --version shows "horus"
#   ✓ --version shows semver
#   ✓ --version shows expected version (if HORUS_EXPECTED_VERSION is set)
#   ✓ --help exits 0
#   ✓ --help lists investigate
#   ✓ --help omits setup (merged into init)
#   ✓ --help omits index (merged into init)
#   ✓ --help lists connect
#   ✓ --help usage line names product 'horus'
#   ✓ setup --help exits 0 (hidden deprecation stub)
#   ✓ config loading: no babel.cjs error (HOR-83 regression guard)
#   ✓ config loading: doctor printed expected output
#   ✓ index --help exits 0 (hidden deprecation stub)
#   ✓ investigate --help exits 0
#   ✓ connect --help exits 0
#   ✓ hosts --help exits 0
#   ✓ stop --help exits 0
#   ✓ setup stub points to horus init and exits 1
#   ✓ index stub points to horus init and exits 1
#   ✓ init: created project in clean temp dir        (HOR-98 clean-env validation)
#   ✓ init: .horus/config.json exists                (HOR-98)
#   ✓ doctor: prints readiness header                (HOR-98)
#   ✓ doctor: reports CLI version                    (HOR-98)
#
# Any ✗ line is a release blocker. Fix before publishing.
#
# Prerequisites (minimum for the installed binary to function):
#   - Node.js 22+  (the CLI is a self-contained Node.js executable)
#   - curl         (only for --install mode)
#   - macOS 12+ or Linux x86_64/arm64
#   - Python 3.11+ with uv or pip is optional (enables source-intelligence features)

set -uo pipefail

INSTALL_URL="${INSTALL_URL:-https://horus.sh/install.sh}"
INSTALL_MODE=0

for arg in "$@"; do
  case "$arg" in
    --install) INSTALL_MODE=1 ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" | sed 's/^# //' | sed 's/^#//'
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$arg" >&2
      exit 1
      ;;
  esac
done

bold()  { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
yellow(){ printf '\033[33m%s\033[0m' "$*"; }

fail=0

ok()   { printf '  %s %s\n' "$(green '✓')" "$*"; }
fail_check() { printf '  %s %s\n' "$(red '✗')" "$*"; fail=1; }
warn() { printf '  %s %s\n' "$(yellow '!')" "$*"; }

# ── 1. optional curl install ───────────────────────────────────────────────────

if [ "${INSTALL_MODE}" -eq 1 ]; then
  printf '\n  %s\n\n' "$(bold 'Step 1: curl install')"
  printf '  %s\n' "Installer: ${INSTALL_URL}"

  # Safety check: abort if an existing horus binary could be overwritten.
  # The installer places the binary in /usr/local/bin or $HOME/.local/bin.
  # Overwriting a developer's live binary without consent is not acceptable.
  # To bypass (e.g. in a fresh container): set HORUS_INSTALL_UNSAFE=1.
  # Preferred isolation: docker run --rm ubuntu:22.04 bash -c \
  #   'apt-get install -y curl nodejs && curl -fsSL <URL> | bash && horus --version'
  _existing_horus=""
  for _candidate in /usr/local/bin/horus "${HOME}/.local/bin/horus"; do
    if [ -f "${_candidate}" ]; then
      _existing_horus="${_candidate}"
      break
    fi
  done
  if [ -n "${_existing_horus}" ] && [ -z "${HORUS_INSTALL_UNSAFE:-}" ]; then
    fail_check "--install safety: ${_existing_horus} already exists"
    warn "The installer may overwrite this binary. Options:"
    warn "  1. Run in a fresh container (recommended):"
    warn "     docker run --rm ubuntu:22.04 bash -c 'apt-get install -y curl nodejs && curl -fsSL ${INSTALL_URL} | bash && horus --version'"
    warn "  2. Set HORUS_INSTALL_UNSAFE=1 to proceed anyway (overwrites ${_existing_horus})"
    printf '\n  %s\n\n' "$(red "$(bold 'FAIL — isolated environment required for --install mode')")"
    exit 1
  fi

  INSTALL_OUTPUT="$(mktemp)"
  if curl -fsSL "${INSTALL_URL}" | bash 2>&1 | tee "${INSTALL_OUTPUT}"; then
    ok "curl install exited 0"
  else
    fail_check "curl install failed (non-zero exit)"
  fi

  # Installer must identify the product being installed as "horus".
  if grep -qiE '\bhorus\b' "${INSTALL_OUTPUT}"; then
    ok "installer output identifies the product as 'horus'"
  else
    fail_check "installer output does not identify the product as 'horus' — branding leak"
    warn "  Output head: $(head -3 "${INSTALL_OUTPUT}")"
  fi

  rm -f "${INSTALL_OUTPUT}"
else
  printf '\n  %s\n\n' "$(bold 'Horus release smoke test')"
  warn "Skipping curl install — using existing PATH or HORUS_BIN"
  warn "Pass --install to test the full curl-install path"
  printf '\n'
fi

# ── 2. resolve the horus binary ───────────────────────────────────────────────

if [ -n "${HORUS_BIN:-}" ]; then
  if [ ! -f "${HORUS_BIN}" ]; then
    fail_check "HORUS_BIN=${HORUS_BIN} not found"
    exit 1
  fi
  HORUS=("node" "${HORUS_BIN}")
  ok "Using HORUS_BIN: ${HORUS_BIN}"
elif command -v horus &>/dev/null; then
  HORUS=("horus")
  ok "horus is on PATH: $(command -v horus)"
else
  fail_check "horus not found on PATH and HORUS_BIN is not set"
  printf '  %s\n' "Install with: curl -fsSL ${INSTALL_URL} | bash"
  printf '\n  %s\n\n' "$(red "$(bold 'FAIL — horus not installed')")"
  exit 1
fi

printf '\n  %s\n\n' "$(bold 'Step 2: command surface verification')"

# ── helpers ───────────────────────────────────────────────────────────────────

check_exit0() {
  local desc="$1"; shift
  if "${HORUS[@]}" "$@" >/dev/null 2>&1; then
    ok "${desc}"
  else
    fail_check "${desc} (non-zero exit)"
  fi
}

check_contains() {
  local desc="$1" needle="$2"; shift 2
  local out
  out="$("${HORUS[@]}" "$@" 2>&1 || true)"
  if printf '%s' "${out}" | grep -qF -- "${needle}"; then
    ok "${desc}"
  else
    fail_check "${desc}"
    printf '    expected to contain: %s\n' "${needle}"
    printf '    got:                 %s\n' "$(printf '%s' "${out}" | head -5)"
  fi
}

check_not_contains() {
  local desc="$1" needle="$2"; shift 2
  local out
  out="$("${HORUS[@]}" "$@" 2>&1 || true)"
  if ! printf '%s' "${out}" | grep -qi -- "${needle}"; then
    ok "${desc}"
  else
    fail_check "${desc}"
    printf '    must NOT contain:    %s\n' "${needle}"
    printf '    found in output:     %s\n' "$(printf '%s' "${out}" | grep -i "${needle}" | head -3)"
  fi
}

# ── 3. --version ──────────────────────────────────────────────────────────────

check_exit0       "--version exits 0"                            --version
check_contains    "--version shows 'horus'"        "horus"       --version
check_contains    "--version shows semver"          "0."          --version
# Optional: verify an exact version string (useful in CI after a release).
if [ -n "${HORUS_EXPECTED_VERSION:-}" ]; then
  check_contains "--version shows expected version (${HORUS_EXPECTED_VERSION})" \
    "${HORUS_EXPECTED_VERSION}" --version
fi

# ── 4. --help ────────────────────────────────────────────────────────────────

check_exit0       "--help exits 0"                               --help
check_contains    "--help lists investigate"  "investigate"      --help
check_contains    "--help lists init"         "init"             --help
# setup/index were merged into init — they are hidden deprecation stubs and must
# be ABSENT from the --help command list (anchored to the command-list indent so
# descriptions mentioning "index" don't false-positive).
check_not_contains "--help omits setup (merged into init)" "^  setup" --help
check_not_contains "--help omits index (merged into init)" "^  index" --help
check_contains    "--help lists connect"      "connect"          --help
# The usage line must name the installed CLI as "horus".
check_contains "--help usage line names product 'horus'" "Usage: horus" --help

# ── 5. sub-command help ──────────────────────────────────────────────────────

# setup/index are hidden deprecation stubs — their --help must still work.
check_exit0  "setup --help exits 0 (hidden deprecation stub)" setup --help
check_exit0  "index --help exits 0 (hidden deprecation stub)" index --help
check_exit0  "investigate --help exits 0" investigate --help
check_exit0  "connect --help exits 0"     connect     --help
check_exit0  "hosts --help exits 0"       hosts       --help
check_exit0  "stop --help exits 0"        stop        --help

# ── 6. config loading — HOR-83 regression guard (HOR-87) ────────────────────
#
# The built binary must load a minimal .js config without the babel.cjs crash.
# Previously: "Cannot find module '../dist/babel.cjs'" when loading any JS config.
# Approach: write a self-contained minimal config to a temp dir, then run
# `horus doctor --config <path>`. doctor prints "CLI version" even when the DB
# is unreachable, so we can verify the binary didn't crash silently.

_config_tmpdir="$(mktemp -d)"
_config_file="${_config_tmpdir}/horus.config.js"
cat > "${_config_file}" << 'HORUS_CONFIG_EOF'
export default {
  database: { url: "postgresql://localhost:5432/horus" },
  projects: [{
    name: "smoke-test",
    repositories: [{ name: "smoke-test", path: "/tmp/smoke-test" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
HORUS_CONFIG_EOF

_doctor_out="$("${HORUS[@]}" doctor --config "${_config_file}" 2>&1 || true)"

# Regression: must not crash with babel.cjs error
if printf '%s' "${_doctor_out}" | grep -qF 'babel.cjs'; then
  fail_check "config loading: babel.cjs crash (HOR-83 regression)"
  printf '    output: %s\n' "$(printf '%s' "${_doctor_out}" | head -3)"
else
  ok "config loading: no babel.cjs error"
fi

# Sanity: doctor must produce recognizable output (not a silent crash)
if printf '%s' "${_doctor_out}" | grep -qF 'CLI version'; then
  ok "config loading: doctor printed expected output"
else
  fail_check "config loading: doctor output missing 'CLI version'"
  printf '    got: %s\n' "$(printf '%s' "${_doctor_out}" | head -5)"
fi

rm -rf "${_config_tmpdir}"

# ── 7. deprecated setup/index stubs (merged into `horus init`) ────────────────

# `horus setup` and `horus index` were merged into `horus init`. The hidden
# stubs must print a single pointer to `horus init` and exit 1.
check_stub() {
  local desc="$1" cmd="$2"
  local out status
  out="$("${HORUS[@]}" "${cmd}" 2>&1)" && status=0 || status=$?
  if [ "${status}" -eq 1 ] && printf '%s' "${out}" | grep -qF 'has been merged into `horus init`'; then
    ok "${desc}"
  else
    fail_check "${desc}"
    printf '    expected: pointer to horus init + exit 1 (got exit %s)\n' "${status}"
    printf '    got:      %s\n' "$(printf '%s' "${out}" | head -3)"
  fi
}

check_stub "setup stub points to horus init and exits 1" setup
check_stub "index stub points to horus init and exits 1" index

# ── 8. horus init — clean temp directory (HOR-98) ────────────────────────────
#
# Run `horus init` in a fresh temp directory with no pre-existing .horus config.
# Verifies the command creates a config and exits non-zero only on genuine errors,
# not on normal "no source-intelligence host" state. We pass --path so the command doesn't
# scan up to the real monorepo root.

_init_tmpdir="$(mktemp -d)"

_init_out="$("${HORUS[@]}" init --path "${_init_tmpdir}" 2>&1 || true)"

if printf '%s' "${_init_out}" | grep -qF 'Initialized Horus project'; then
  ok "init: created project in clean temp dir"
elif printf '%s' "${_init_out}" | grep -qF '.horus/config.json'; then
  ok "init: created .horus/config.json in clean temp dir"
else
  fail_check "init: expected 'Initialized Horus project' in output"
  printf '    got: %s\n' "$(printf '%s' "${_init_out}" | head -5)"
fi

if [ -f "${_init_tmpdir}/.horus/config.json" ]; then
  ok "init: .horus/config.json exists"
else
  fail_check "init: .horus/config.json not found after init"
fi

rm -rf "${_init_tmpdir}"

# ── 9. horus doctor — standalone, no config (HOR-98) ─────────────────────────
#
# Run doctor without a config file (simulates a first-run user who has not yet
# created horus.config.js). Must print the "Horus readiness check" header and
# the CLI version line — it should not crash silently.

_doctor_standalone_out="$("${HORUS[@]}" doctor 2>&1 || true)"

if printf '%s' "${_doctor_standalone_out}" | grep -qF 'Horus readiness check'; then
  ok "doctor: prints readiness header"
else
  fail_check "doctor: expected 'Horus readiness check' header"
  printf '    got: %s\n' "$(printf '%s' "${_doctor_standalone_out}" | head -5)"
fi

if printf '%s' "${_doctor_standalone_out}" | grep -qF 'CLI version'; then
  ok "doctor: reports CLI version"
else
  fail_check "doctor: expected 'CLI version' line in output"
  printf '    got: %s\n' "$(printf '%s' "${_doctor_standalone_out}" | head -5)"
fi

# ── done ─────────────────────────────────────────────────────────────────────

printf '\n'
if [ "${fail}" -eq 0 ]; then
  printf '  %s\n\n' "$(green "$(bold 'PASS — release smoke clean')")"
  exit 0
else
  printf '  %s\n\n' "$(red "$(bold 'FAIL — one or more checks failed')")"
  printf '  %s\n\n' "Fix all ✗ items above before publishing this release."
  exit 1
fi
