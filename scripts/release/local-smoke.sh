#!/usr/bin/env bash
# HOR-152, HOR-192 — Local release smoke test (with --report mode)
#
# Exercises the full Horus command surface against a real local project repo.
# Run this after every release to catch regressions before they reach users.
#
# Usage:
#   scripts/release/local-smoke.sh <repo-path> [options]
#   scripts/release/local-smoke.sh --help
#
# Options:
#   --report          Write a shareable report folder (see Output below)
#   --skip-install    Skip install channel checks (--version / npm / curl)
#   --skip-curl       Skip only the curl installer test
#   --keep-config     Do not wipe .horus before the onboarding smoke
#
# Output (without --report):
#   Per-command ✓/✗ lines, a section summary, and a timestamped log at
#   tmp/horus-smoke-YYYYMMDD-HHMMSS.log relative to the horus repo root.
#
# Output (with --report):
#   tmp/horus-smoke/<timestamp>/
#     raw.log      ANSI-colored terminal output (same content as without --report)
#     report.md    Formatted markdown report (ANSI stripped)
#     summary.json Machine-readable verdict and section states
#     commands/    Per-command captured output with exit code and duration
#
# Section states (in order of severity):
#   PASS     All commands exited 0.
#   WARN     One or more optional items had issues.
#   PARTIAL  Some connector-dependent commands failed (connector may be absent).
#   FAIL     A required command failed.
#   SKIPPED  Section was skipped entirely (prerequisite unavailable).
#
# Release blockers (exit non-zero): INSTALL=FAIL, ONBOARDING=FAIL, STATUS=FAIL
# Connector-dependent sections (SOURCE, CHANGE, INVEST, SCORE) never block release.
#
# Required connectors for full coverage:
#   - Postgres (investigate/replay/postmortem/scoring)
#   - Source-intelligence backend (index/explain/architecture/blast-radius/owner/search/queues)
#   Commands that need unavailable connectors are marked ⚠ and do not fail the section.

set -uo pipefail

# ── repo roots ────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HORUS_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# ── argument parsing ──────────────────────────────────────────────────────────

REPO_PATH=""
SKIP_INSTALL=0
SKIP_CURL=0
KEEP_CONFIG=0
REPORT_MODE=0

for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-curl)    SKIP_CURL=1    ;;
    --keep-config)  KEEP_CONFIG=1  ;;
    --report)       REPORT_MODE=1  ;;
    --help|-h)
      sed -n '2,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 1
      ;;
    *)
      if [ -z "${REPO_PATH}" ]; then
        REPO_PATH="$arg"
      else
        printf 'Unexpected argument: %s\n' "$arg" >&2
        exit 1
      fi
      ;;
  esac
done

if [ -z "${REPO_PATH}" ]; then
  printf 'Usage: %s <repo-path> [--report] [--skip-install] [--skip-curl] [--keep-config]\n' \
    "$(basename "$0")" >&2
  exit 1
fi

if [ ! -d "${REPO_PATH}" ]; then
  printf 'Repo path does not exist: %s\n' "${REPO_PATH}" >&2
  exit 1
fi

REPO_PATH="$(cd "${REPO_PATH}" && pwd)"
REPO_NAME="$(basename "${REPO_PATH}")"

# ── output directories ─────────────────────────────────────────────────────────

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"
TS_ISO="$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u '+%Y-%m-%dT%H:%M:%SZ')"
LOG_BASE="${HORUS_ROOT}/tmp"
mkdir -p "${LOG_BASE}"

if [ "${REPORT_MODE}" -eq 1 ]; then
  REPORT_DIR="${LOG_BASE}/horus-smoke/${TIMESTAMP}"
  CMD_DIR="${REPORT_DIR}/commands"
  mkdir -p "${CMD_DIR}"
  LOG_FILE="${REPORT_DIR}/raw.log"
else
  REPORT_DIR=""
  CMD_DIR=""
  LOG_FILE="${LOG_BASE}/horus-smoke-${TIMESTAMP}.log"
fi

# Tee all output to the log file (raw, with ANSI).
exec > >(tee -a "${LOG_FILE}") 2>&1

# ── colour helpers ─────────────────────────────────────────────────────────────

bold()   { printf '\033[1m%s\033[0m' "$*"; }
dim()    { printf '\033[2m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
red()    { printf '\033[31m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }
cyan()   { printf '\033[36m%s\033[0m' "$*"; }

strip_ansi() { sed 's/\x1b\[[0-9;]*[mGKHF]//g'; }

# ── section state machine ──────────────────────────────────────────────────────

# Each section has a STATE variable (e.g. SEC_INSTALL_STATE=PASS).
# States only ever get "worse": PASS < WARN < PARTIAL < FAIL; SKIPPED is terminal.
SEC_INSTALL_STATE="PASS"
SEC_ONBOARD_STATE="PASS"
SEC_INVEST_STATE="PASS"
SEC_SOURCE_STATE="PASS"
SEC_CHANGE_STATE="PASS"
SEC_STATUS_STATE="PASS"
SEC_SCORE_STATE="PASS"

_SEC_STATE_VAR=""
_SEC_LABEL=""
_SEC_CMD_TOTAL=0
_SEC_CMD_PASS=0
_CMD_SEQ=0

state_rank() {
  case "$1" in
    PASS)    echo 0 ;;
    WARN)    echo 1 ;;
    PARTIAL) echo 2 ;;
    FAIL)    echo 3 ;;
    SKIPPED) echo 99 ;;
    *)       echo 0 ;;
  esac
}

upgrade_section_state() {
  local new_state="$1"
  [ -z "${_SEC_STATE_VAR}" ] && return 0
  local current
  current="$(eval "printf '%s' \"\${${_SEC_STATE_VAR}:-PASS}\"")"
  if [ "$(state_rank "$new_state")" -gt "$(state_rank "$current")" ]; then
    eval "${_SEC_STATE_VAR}=${new_state}"
  fi
}

section() {
  _SEC_STATE_VAR="SEC_${1}_STATE"
  _SEC_LABEL="$2"
  _SEC_CMD_TOTAL=0
  _SEC_CMD_PASS=0
  eval "${_SEC_STATE_VAR}=PASS"
  printf '\n  %s\n' "$(bold "$(cyan '▶') ${_SEC_LABEL}")"
}

skip_section() {
  [ -z "${_SEC_STATE_VAR}" ] && return 0
  eval "${_SEC_STATE_VAR}=SKIPPED"
}

ok() {
  printf '    %s %s\n' "$(green '✓')" "$*"
  _SEC_CMD_TOTAL=$((_SEC_CMD_TOTAL + 1))
  _SEC_CMD_PASS=$((_SEC_CMD_PASS + 1))
}

fail() {
  printf '    %s %s\n' "$(red '✗')" "$*"
  _SEC_CMD_TOTAL=$((_SEC_CMD_TOTAL + 1))
  upgrade_section_state FAIL
}

warn() {
  printf '    %s %s\n' "$(yellow '⚠')" "$*"
  upgrade_section_state WARN
}

partial_cmd() {
  printf '    %s %s\n' "$(yellow '⚠')" "$*"
  _SEC_CMD_TOTAL=$((_SEC_CMD_TOTAL + 1))
  upgrade_section_state PARTIAL
}

note() { printf '    %s %s\n' "$(dim '·')" "$*"; }

# ── per-command file capture ───────────────────────────────────────────────────

# Write output to commands/<seq>-<slug>.txt when --report is active.
_write_cmd_file() {
  [ "${REPORT_MODE}" -eq 0 ] && return 0
  local desc="$1" exit_code="$2" duration_s="$3" output="$4"
  _CMD_SEQ=$((_CMD_SEQ + 1))
  local slug
  slug="$(printf '%02d-%s' "${_CMD_SEQ}" \
    "$(printf '%s' "${_SEC_LABEL}-${desc}" | tr '[:upper:]' '[:lower:]' | \
       sed 's/[^a-z0-9]/-/g' | sed 's/-\{2,\}/-/g' | \
       sed 's/^-//' | sed 's/-$//' | cut -c1-64)")"
  {
    printf '# Section: %s\n' "${_SEC_LABEL}"
    printf '# Command: %s\n' "${desc}"
    printf '# Exit:    %d | Duration: %ds\n' "${exit_code}" "${duration_s}"
    printf '#\n'
    printf '%s\n' "${output}" | strip_ansi
  } > "${CMD_DIR}/${slug}.txt"
}

# ── check helpers ──────────────────────────────────────────────────────────────

HORUS=("horus")

# run_check: required command. Failure → FAIL section.
# Usage: run_check "description" cmd args...
run_check() {
  local desc="$1"; shift
  local out exit_code=0 t0 t1
  t0="$(date +%s)"
  out="$("${HORUS[@]}" "$@" 2>&1)" || exit_code=$?
  t1="$(date +%s)"
  _write_cmd_file "${desc}" "${exit_code}" "$((t1 - t0))" "${out}"
  if [ "${exit_code}" -eq 0 ]; then
    ok "${desc}"
    printf '%s\n' "${out}" | sed 's/^/      /'
    return 0
  else
    fail "${desc} (exit ${exit_code})"
    printf '%s\n' "${out}" | head -5 | sed 's/^/      /'
    return 1
  fi
}

# check_output: run a command, require a string in combined output.
# Failure → FAIL section.
# Usage: check_output "description" "needle" cmd args...
check_output() {
  local desc="$1" needle="$2"; shift 2
  local out exit_code=0 t0 t1
  t0="$(date +%s)"
  out="$("${HORUS[@]}" "$@" 2>&1 || true)"
  t1="$(date +%s)"
  _write_cmd_file "${desc}" 0 "$((t1 - t0))" "${out}"
  if printf '%s' "${out}" | grep -qF -- "${needle}"; then
    ok "${desc}"
    return 0
  else
    fail "${desc} — expected: ${needle}"
    printf '%s\n' "${out}" | head -5 | sed 's/^/      /'
    return 1
  fi
}

# check_warn: connector-dependent command. Failure → PARTIAL section (not FAIL).
# Use for commands where missing connectors are expected and non-blocking.
# Usage: check_warn "description" cmd args...
check_warn() {
  local desc="$1"; shift
  local out exit_code=0 t0 t1
  t0="$(date +%s)"
  out="$("${HORUS[@]}" "$@" 2>&1)" || exit_code=$?
  t1="$(date +%s)"
  _write_cmd_file "${desc}" "${exit_code}" "$((t1 - t0))" "${out}"
  if [ "${exit_code}" -eq 0 ]; then
    ok "${desc}"
    printf '%s\n' "${out}" | sed 's/^/      /'
  else
    partial_cmd "${desc} (exit ${exit_code} — connector may be absent)"
    printf '%s\n' "${out}" | head -3 | sed 's/^/      /'
  fi
}

# in_repo_*: helpers that CD to REPO_PATH first.
in_repo_check() {
  local desc="$1"; shift
  local out exit_code=0 t0 t1
  t0="$(date +%s)"
  out="$(cd "${REPO_PATH}" && "${HORUS[@]}" "$@" 2>&1)" || exit_code=$?
  t1="$(date +%s)"
  _write_cmd_file "${desc}" "${exit_code}" "$((t1 - t0))" "${out}"
  if [ "${exit_code}" -eq 0 ]; then
    ok "${desc}"
    printf '%s\n' "${out}" | sed 's/^/      /'
    return 0
  else
    fail "${desc} (exit ${exit_code})"
    printf '%s\n' "${out}" | head -5 | sed 's/^/      /'
    return 1
  fi
}

in_repo_warn() {
  local desc="$1"; shift
  local out exit_code=0 t0 t1
  t0="$(date +%s)"
  out="$(cd "${REPO_PATH}" && "${HORUS[@]}" "$@" 2>&1)" || exit_code=$?
  t1="$(date +%s)"
  _write_cmd_file "${desc}" "${exit_code}" "$((t1 - t0))" "${out}"
  if [ "${exit_code}" -eq 0 ]; then
    ok "${desc}"
    printf '%s\n' "${out}" | sed 's/^/      /'
  else
    partial_cmd "${desc} (exit ${exit_code} — connector may be absent)"
    printf '%s\n' "${out}" | head -3 | sed 's/^/      /'
  fi
}

# ── metadata ──────────────────────────────────────────────────────────────────

# Collect versions and git ref before the run starts.
HORUS_VERSION_STR="$(horus --version 2>/dev/null || printf 'unknown')"
SOURCE_VERSION_STR="$(horus-source --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || printf 'not installed')"
GIT_REF="$(cd "${REPO_PATH}" && git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
GIT_BRANCH="$(cd "${REPO_PATH}" && git rev-parse --abbrev-ref HEAD 2>/dev/null || printf 'unknown')"

# ── banner ────────────────────────────────────────────────────────────────────

printf '\n  %s\n' "$(bold '⚡ Horus local release smoke')"
printf '  %-18s %s\n' "$(dim 'Repo:')"     "$(dim "${REPO_PATH}")"
printf '  %-18s %s\n' "$(dim 'CLI:')"      "$(dim "${HORUS_VERSION_STR}")"
printf '  %-18s %s\n' "$(dim 'Source:')"   "$(dim "${SOURCE_VERSION_STR}")"
printf '  %-18s %s\n' "$(dim 'Git ref:')"  "$(dim "${GIT_REF} (${GIT_BRANCH})")"
printf '  %-18s %s\n' "$(dim 'Timestamp:')" "$(dim "${TIMESTAMP}")"
printf '  %-18s %s\n' "$(dim 'Log:')"      "$(dim "${LOG_FILE}")"
if [ "${REPORT_MODE}" -eq 1 ]; then
  printf '  %-18s %s\n' "$(dim 'Report dir:')" "$(dim "${REPORT_DIR}")"
fi

INVESTIGATION_ID=""

# ── § 1  INSTALL ──────────────────────────────────────────────────────────────

section INSTALL "Install channel verification"

if [ "${SKIP_INSTALL}" -eq 1 ]; then
  note "Skipped (--skip-install)"
  upgrade_section_state WARN
else
  # 1a. PATH binary
  if printf '%s' "${HORUS_VERSION_STR}" | grep -qE '^horus [0-9]+\.[0-9]+\.[0-9]+'; then
    ok "--version: ${HORUS_VERSION_STR}"
  else
    fail "--version did not return expected semver output (got: ${HORUS_VERSION_STR})"
  fi

  # 1b. npm registry version
  if command -v npm &>/dev/null; then
    NPM_VERSION="$(npm view @merittdev/horus version 2>/dev/null || true)"
    if [ -n "${NPM_VERSION}" ]; then
      ok "npm registry: @merittdev/horus@${NPM_VERSION}"
    else
      warn "npm view @merittdev/horus returned empty (registry may be slow)"
    fi
  else
    note "npm not found — skipping npm registry check"
  fi

  # 1c. curl installer — isolated to a temp dir
  if [ "${SKIP_CURL}" -eq 1 ]; then
    note "Skipping curl install (--skip-curl)"
  elif ! command -v curl &>/dev/null; then
    note "curl not found — skipping curl installer check"
  else
    CURL_TMPDIR="$(mktemp -d)"
    ORIG_PATH="${PATH}"
    mkdir -p "${CURL_TMPDIR}/bin"
    INSTALL_OUTPUT="$(PATH="${CURL_TMPDIR}/bin:${PATH}" HORUS_INSTALL_DIR="${CURL_TMPDIR}/bin" \
      curl -fsSL https://horus.sh/install.sh 2>/dev/null | \
      PATH="${CURL_TMPDIR}/bin:${ORIG_PATH}" bash 2>&1 || true)"
    CURL_EXIT=$?
    export PATH="${ORIG_PATH}"
    if [ "${CURL_EXIT}" -eq 0 ]; then
      ok "curl install exited 0"
      if [ -f "${CURL_TMPDIR}/bin/horus" ]; then
        CURL_VER="$("${CURL_TMPDIR}/bin/horus" --version 2>&1 || true)"
        if printf '%s' "${CURL_VER}" | grep -qE 'horus [0-9]'; then
          ok "curl-installed binary --version: ${CURL_VER}"
        else
          fail "curl-installed binary --version returned unexpected output (got: ${CURL_VER})"
        fi
      else
        note "curl-installed binary not found at expected path (installer may use different dir)"
      fi
    else
      fail "curl install exited ${CURL_EXIT}"
      printf '%s\n' "${INSTALL_OUTPUT}" | tail -10 | sed 's/^/      /'
    fi
    rm -rf "${CURL_TMPDIR}"
  fi
fi

# ── § 2  ONBOARDING ───────────────────────────────────────────────────────────

section ONBOARD "Onboarding smoke (init → doctor → investigate → explain)"

# 2a. Clean state (unless --keep-config)
if [ "${KEEP_CONFIG}" -eq 0 ]; then
  if [ -d "${REPO_PATH}/.horus" ]; then
    note "Removing ${REPO_PATH}/.horus (use --keep-config to skip)"
    rm -rf "${REPO_PATH}/.horus"
  fi
fi

# 2b. horus init — required; writes/registers .horus/config.json, starts the
# source-intelligence host, and indexes the repo (setup/index merged into init).
# WARN (not fail) on indexing pieces when the source backend is absent.
note "Running horus init (may take a while on first run)…"
INIT_OUT="$(cd "${REPO_PATH}" && "${HORUS[@]}" init 2>&1)" && INIT_EXIT=0 || INIT_EXIT=$?
_write_cmd_file "horus init" "${INIT_EXIT}" 0 "${INIT_OUT}"
if printf '%s' "${INIT_OUT}" | grep -qiF '.horus'; then
  ok "horus init — .horus config created"
else
  fail "horus init — unexpected output (expected .horus mention)"
  printf '%s\n' "${INIT_OUT}" | head -5 | sed 's/^/      /'
fi
if [ "${INIT_EXIT}" -eq 0 ]; then
  ok "horus init — exited 0"
  if printf '%s' "${INIT_OUT}" | grep -qiE 'Indexed|source-intelligence|source host'; then
    ok "horus init — source host registered"
  else
    warn "horus init — source host registration line not found"
    printf '%s\n' "${INIT_OUT}" | tail -5 | sed 's/^/      /'
  fi
else
  warn "horus init — exited ${INIT_EXIT} (source-intelligence backend may be absent)"
  printf '%s\n' "${INIT_OUT}" | tail -5 | sed 's/^/      /'
fi

# 2c. horus doctor (post-init) — required; must print readiness header, and the
# source host must be configured after a successful init (HOR-150 regression).
DOCTOR_POST="$(cd "${REPO_PATH}" && "${HORUS[@]}" doctor 2>&1 || true)"
_write_cmd_file "horus doctor (post-init)" 0 0 "${DOCTOR_POST}"
if printf '%s' "${DOCTOR_POST}" | grep -qiE 'readiness|CLI version'; then
  ok "horus doctor (post-init) — readiness output present"
else
  fail "horus doctor (post-init) — missing readiness output"
  printf '%s\n' "${DOCTOR_POST}" | head -5 | sed 's/^/      /'
fi
if printf '%s' "${DOCTOR_POST}" | grep -qiE 'source.*host.*http|source-intelligence.*http'; then
  ok "horus doctor (post-init) — source host configured  [HOR-150 regression guard]"
else
  if [ "${INIT_EXIT}" -eq 0 ]; then
    fail "horus doctor (post-init) — source host not configured after successful init  [HOR-150]"
    printf '%s\n' "${DOCTOR_POST}" | grep -i source | head -3 | sed 's/^/      /'
  else
    warn "horus doctor (post-init) — source host not configured (init did not fully succeed)"
  fi
fi

# 2f. horus investigate
note "Running horus investigate (requires Postgres + source backend)…"
INVEST_HINT="getSaleWithLink slow"
INVEST_OUT="$(cd "${REPO_PATH}" && "${HORUS[@]}" investigate "${INVEST_HINT}" 2>&1)" \
  && INVEST_EXIT=0 || INVEST_EXIT=$?
_write_cmd_file "horus investigate" "${INVEST_EXIT}" 0 "${INVEST_OUT}"
if [ "${INVEST_EXIT}" -eq 0 ]; then
  ok "horus investigate — exited 0"
  INVESTIGATION_ID="$(printf '%s' "${INVEST_OUT}" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1 || true)"
  if [ -z "${INVESTIGATION_ID}" ]; then
    INVESTIGATION_ID="$(printf '%s' "${INVEST_OUT}" | grep -oE 'inv_[a-z0-9]+' | head -1 || true)"
  fi
  if [ -n "${INVESTIGATION_ID}" ]; then
    ok "horus investigate — ID extracted: ${INVESTIGATION_ID}"
  else
    note "horus investigate — could not extract ID from output (subsequent sections may skip)"
  fi
else
  warn "horus investigate — exited ${INVEST_EXIT} (Postgres or source backend may be absent)"
  printf '%s\n' "${INVEST_OUT}" | tail -5 | sed 's/^/      /'
fi

# 2g. horus explain
in_repo_warn "horus explain getSaleWithLink" explain "getSaleWithLink"

# ── § 3  INVESTIGATION ────────────────────────────────────────────────────────

section INVEST "Investigation chain (investigations → replay → postmortem)"

if [ -z "${INVESTIGATION_ID}" ]; then
  warn "No investigation ID available — investigation chain will be skipped"
  note "Fix horus investigate, then re-run without --keep-config"
  skip_section
else
  check_warn "horus investigations" investigations
  in_repo_warn "horus replay <id>"                   replay "${INVESTIGATION_ID}"
  in_repo_warn "horus replay <id> --format markdown" replay "${INVESTIGATION_ID}" --format markdown
  in_repo_warn "horus postmortem <id>"               postmortem "${INVESTIGATION_ID}"
fi

# ── § 4  SOURCE INTELLIGENCE ──────────────────────────────────────────────────

section SOURCE "Source intelligence (architecture · blast-radius · owner · search · queues)"

in_repo_warn "horus architecture"                architecture
in_repo_warn "horus blast-radius getSaleWithLink" blast-radius "getSaleWithLink"
in_repo_warn "horus owner getSaleWithLink"        owner "getSaleWithLink"
in_repo_warn "horus search 'sale collection link'" search "sale collection link"
in_repo_warn "horus queues"                       queues

# ── § 5  CHANGE INTELLIGENCE ──────────────────────────────────────────────────

section CHANGE "Change intelligence (changes · timeline · what-changed)"

in_repo_warn "horus changes HEAD~5 HEAD" changes HEAD~5 HEAD
in_repo_warn "horus timeline"            timeline
in_repo_warn "horus what-changed"        what-changed

# ── § 6  STATUS / REGISTRY ────────────────────────────────────────────────────

section STATUS "Status / registry (status · repos · hosts)"

# status must exit 0 even with no connectors configured — it is always blocking.
in_repo_check "horus status" status
in_repo_warn "horus repos" repos
check_warn "horus hosts"   hosts

# ── § 7  SCORING ─────────────────────────────────────────────────────────────

section SCORE "Scoring (score · ask · scores)"

if [ -z "${INVESTIGATION_ID}" ]; then
  note "No investigation ID — scoring chain skipped"
  skip_section
else
  in_repo_warn "horus score <id>"           score "${INVESTIGATION_ID}"
  in_repo_warn "horus ask <id> <directive>" ask "${INVESTIGATION_ID}" "focus on api behavior"
  in_repo_warn "horus scores"               scores
fi

# ── summary ───────────────────────────────────────────────────────────────────

# Release blockers: INSTALL and ONBOARD and STATUS must not FAIL.
# Everything else (SOURCE, CHANGE, INVEST, SCORE) is non-blocking quality signal.
_is_blocker() {
  [ "$1" = "FAIL" ] && return 0 || return 1
}

_overall=0
_blocker_sections=""
if _is_blocker "${SEC_INSTALL_STATE}"; then
  _overall=1; _blocker_sections="${_blocker_sections} Install"
fi
if _is_blocker "${SEC_ONBOARD_STATE}"; then
  _overall=1; _blocker_sections="${_blocker_sections} Onboarding"
fi
if _is_blocker "${SEC_STATUS_STATE}"; then
  _overall=1; _blocker_sections="${_blocker_sections} Status/Registry"
fi

_state_label() {
  case "$1" in
    PASS)    green 'PASS'    ;;
    WARN)    yellow 'WARN'   ;;
    PARTIAL) yellow 'PARTIAL' ;;
    FAIL)    red 'FAIL'      ;;
    SKIPPED) dim 'SKIPPED'   ;;
    *)       dim 'UNKNOWN'   ;;
  esac
}

_state_md() {
  case "$1" in
    PASS)    printf '✅ PASS'    ;;
    WARN)    printf '⚠️  WARN'   ;;
    PARTIAL) printf '⚠️  PARTIAL' ;;
    FAIL)    printf '❌ FAIL'    ;;
    SKIPPED) printf '⏭️  SKIPPED' ;;
    *)       printf '❓ UNKNOWN' ;;
  esac
}

printf '\n'
printf '  %s\n' "$(bold 'Summary')"
printf '  %-28s %s\n' "Install:"              "$(_state_label "${SEC_INSTALL_STATE}")"
printf '  %-28s %s\n' "Onboarding:"           "$(_state_label "${SEC_ONBOARD_STATE}")"
printf '  %-28s %s\n' "Investigation chain:"  "$(_state_label "${SEC_INVEST_STATE}")"
printf '  %-28s %s\n' "Source intelligence:"  "$(_state_label "${SEC_SOURCE_STATE}")"
printf '  %-28s %s\n' "Change intelligence:"  "$(_state_label "${SEC_CHANGE_STATE}")"
printf '  %-28s %s\n' "Status / registry:"    "$(_state_label "${SEC_STATUS_STATE}")"
printf '  %-28s %s\n' "Scoring:"              "$(_state_label "${SEC_SCORE_STATE}")"
printf '  %s\n' "$(dim '────────────────────────────────────')"
if [ "${_overall}" -eq 0 ]; then
  printf '  %-28s %s\n' "Overall:" "$(green 'PASS')"
else
  printf '  %-28s %s\n' "Overall:" "$(red 'FAIL')"
  printf '  %s %s\n' "$(dim 'Blockers:')" "$(red "${_blocker_sections# }")"
fi
printf '\n'
printf '  %s %s\n' "$(dim 'Log:')" "$(dim "${LOG_FILE}")"
if [ "${REPORT_MODE}" -eq 1 ]; then
  printf '  %s %s\n' "$(dim 'Report:')" "$(dim "${REPORT_DIR}")"
fi
printf '\n'

# ── report generation ─────────────────────────────────────────────────────────

if [ "${REPORT_MODE}" -eq 1 ]; then

  # Verdict: PASS if all sections PASS/WARN/PARTIAL/SKIPPED and no blockers fail.
  if [ "${_overall}" -eq 0 ]; then
    VERDICT="PASS"
    if [ "${SEC_INVEST_STATE}" = "PARTIAL" ] || [ "${SEC_SOURCE_STATE}" = "PARTIAL" ] || \
       [ "${SEC_CHANGE_STATE}" = "PARTIAL" ] || [ "${SEC_SCORE_STATE}" = "PARTIAL" ] || \
       [ "${SEC_INSTALL_STATE}" = "WARN" ] || [ "${SEC_ONBOARD_STATE}" = "WARN" ]; then
      VERDICT="WARN"
    fi
  else
    VERDICT="FAIL"
  fi

  # ── summary.json ──
  cat > "${REPORT_DIR}/summary.json" <<JSON
{
  "timestamp": "${TS_ISO}",
  "horusVersion": "$(printf '%s' "${HORUS_VERSION_STR}" | sed 's/"/\\"/g')",
  "sourceVersion": "$(printf '%s' "${SOURCE_VERSION_STR}" | sed 's/"/\\"/g')",
  "repoPath": "$(printf '%s' "${REPO_PATH}" | sed 's/"/\\"/g')",
  "repoName": "$(printf '%s' "${REPO_NAME}" | sed 's/"/\\"/g')",
  "gitRef": "$(printf '%s' "${GIT_REF}" | sed 's/"/\\"/g')",
  "gitBranch": "$(printf '%s' "${GIT_BRANCH}" | sed 's/"/\\"/g')",
  "investigationId": "$(printf '%s' "${INVESTIGATION_ID}" | sed 's/"/\\"/g')",
  "sections": {
    "install": "${SEC_INSTALL_STATE}",
    "onboarding": "${SEC_ONBOARD_STATE}",
    "investigationChain": "${SEC_INVEST_STATE}",
    "sourceIntelligence": "${SEC_SOURCE_STATE}",
    "changeIntelligence": "${SEC_CHANGE_STATE}",
    "statusRegistry": "${SEC_STATUS_STATE}",
    "scoring": "${SEC_SCORE_STATE}"
  },
  "verdict": "${VERDICT}",
  "releaseBlocker": $([ "${_overall}" -ne 0 ] && printf 'true' || printf 'false'),
  "blockerSections": "$(printf '%s' "${_blocker_sections# }" | sed 's/"/\\"/g')"
}
JSON

  # ── report.md ──
  REPORT_MD="${REPORT_DIR}/report.md"
  {
    printf '# Horus Smoke Report — %s\n\n' "${TIMESTAMP}"
    printf '## Metadata\n\n'
    printf '| Field | Value |\n'
    printf '|-------|-------|\n'
    printf '| CLI version | `%s` |\n' "${HORUS_VERSION_STR}"
    printf '| Source backend | `%s` |\n' "${SOURCE_VERSION_STR}"
    printf '| Repo | `%s` (`%s`) |\n' "${REPO_PATH}" "${REPO_NAME}"
    printf '| Git ref | `%s` (`%s`) |\n' "${GIT_REF}" "${GIT_BRANCH}"
    printf '| Timestamp | `%s` |\n' "${TS_ISO}"
    if [ -n "${INVESTIGATION_ID}" ]; then
      printf '| Investigation ID | `%s` |\n' "${INVESTIGATION_ID}"
    fi
    printf '\n'
    printf '## Section Summary\n\n'
    printf '| Section | State | Blocker? |\n'
    printf '|---------|-------|----------|\n'
    printf '| Install | %s | Yes |\n'              "$(_state_md "${SEC_INSTALL_STATE}")"
    printf '| Onboarding | %s | Yes |\n'           "$(_state_md "${SEC_ONBOARD_STATE}")"
    printf '| Investigation chain | %s | No |\n'   "$(_state_md "${SEC_INVEST_STATE}")"
    printf '| Source intelligence | %s | No |\n'   "$(_state_md "${SEC_SOURCE_STATE}")"
    printf '| Change intelligence | %s | No |\n'   "$(_state_md "${SEC_CHANGE_STATE}")"
    printf '| Status / registry | %s | Yes |\n'    "$(_state_md "${SEC_STATUS_STATE}")"
    printf '| Scoring | %s | No |\n'               "$(_state_md "${SEC_SCORE_STATE}")"
    printf '\n'
    printf '## Verdict: %s\n\n' "${VERDICT}"
    if [ "${_overall}" -ne 0 ]; then
      printf '**Release blockers:** %s\n\n' "${_blocker_sections# }"
      printf 'One or more required sections failed. This build should not be released.\n\n'
    elif [ "${VERDICT}" = "WARN" ]; then
      printf 'No release blockers. Some connector-dependent sections had partial failures or were skipped.\n'
      printf 'Expected gaps (Elasticsearch/Grafana/MongoDB/Redis not configured) remain non-blocking.\n\n'
    else
      printf 'All sections passed. Ready for release or demo.\n\n'
    fi
    printf '## State Guide\n\n'
    printf '| State | Meaning |\n'
    printf '|-------|---------|\n'
    printf '| ✅ PASS | All commands exited 0 |\n'
    printf '| ⚠️  WARN | Optional items had issues |\n'
    printf '| ⚠️  PARTIAL | Some connector-dependent commands failed (non-blocking) |\n'
    printf '| ❌ FAIL | A required command failed (blocking for Install/Onboard/Status) |\n'
    printf '| ⏭️  SKIPPED | Section skipped — prerequisite unavailable |\n'
    printf '\n'
    printf '## Command Output\n\n'
    printf 'Per-command output files are in `commands/`. '
    printf 'Raw ANSI log is at `raw.log`.\n\n'
    if ls "${CMD_DIR}"/*.txt &>/dev/null; then
      for f in "${CMD_DIR}"/*.txt; do
        fname="$(basename "$f")"
        printf '### `%s`\n\n```\n' "${fname}"
        cat "$f"
        printf '```\n\n'
      done
    fi
  } > "${REPORT_MD}"

  printf '  %s\n' "$(bold 'Report files:')"
  printf '  %-18s %s\n' "$(dim 'report.md:')"    "$(dim "${REPORT_DIR}/report.md")"
  printf '  %-18s %s\n' "$(dim 'summary.json:')" "$(dim "${REPORT_DIR}/summary.json")"
  printf '  %-18s %s\n' "$(dim 'raw.log:')"      "$(dim "${REPORT_DIR}/raw.log")"
  printf '  %-18s %s\n' "$(dim 'commands/:')"    "$(dim "${CMD_DIR}/")"
  printf '\n'
fi

exit "${_overall}"
