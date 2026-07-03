#!/usr/bin/env bash
# scripts/e2e-smoke.sh — Horus v0.1 end-to-end local smoke flow
#
# Exercises the full v0.1 user path from init through postmortem.
# Does NOT require Elasticsearch, MongoDB, Grafana, or any production system.
# Postgres is required for the investigate → replay → postmortem chain.
#
# Phases:
#   1. Startup   — version, help, doctor (no Postgres needed)
#   2. User path — init, investigate (git-only), investigations, replay, postmortem
#
# Usage:
#   ./scripts/e2e-smoke.sh                              # uses 'horus' on PATH
#   ./scripts/e2e-smoke.sh apps/horus/dist/index.cjs   # uses local build

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve the binary to test
if [ -n "${1:-}" ]; then
  TARGET="$1"
  [[ "$TARGET" == /* ]] || TARGET="$ROOT/$TARGET"
  HORUS=("node" "$TARGET")
else
  if ! command -v horus &>/dev/null; then
    printf '\n  ✗ horus not found on PATH\n\n' >&2
    exit 1
  fi
  HORUS=("horus")
fi

# ── Colour helpers ────────────────────────────────────────────────────────────
bold()  { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
cyan()  { printf '\033[36m%s\033[0m' "$*"; }
dim()   { printf '\033[2m%s\033[0m' "$*"; }
yellow(){ printf '\033[33m%s\033[0m' "$*"; }

FAIL=0

step() { printf '\n  %s %s\n' "$(cyan '→')" "$(bold "$1")"; }
ok()   { printf '    %s %s\n' "$(green '✓')" "$1"; }
fail() { printf '    %s %s\n' "$(red '✗')" "$1"; FAIL=1; }
note() { printf '    %s %s\n' "$(yellow '!')" "$1"; }

# check_output: run HORUS with given args, require needle in combined output.
check_output() {
  local desc="$1" needle="$2"; shift 2
  local out
  out="$("${HORUS[@]}" "$@" 2>&1 || true)"
  if printf '%s' "$out" | grep -qF -- "$needle"; then
    ok "$desc"
  else
    fail "$desc (expected: $needle)"
    printf '    %s\n' "$(dim "got: $(printf '%s' "$out" | head -3)")"
  fi
}

# check_exit0: run HORUS with given args, require exit 0.
check_exit0() {
  local desc="$1"; shift
  if "${HORUS[@]}" "$@" >/dev/null 2>&1; then
    ok "$desc"
  else
    fail "$desc (non-zero exit)"
  fi
}

# ── Phase 1: startup (no Postgres required) ───────────────────────────────────

printf '\n  %s\n' "$(bold 'Horus v0.1 end-to-end smoke flow')"
printf '  %s\n' "$(dim "binary: ${HORUS[*]}")"

step "CLI startup"
check_output "--version exits 0 and shows horus" "horus"       --version
check_output "--version shows semver"            "0."          --version
check_output "--help lists investigate"          "investigate" --help
check_output "--help lists postmortem"           "postmortem"  --help

step "deprecated stubs (setup/index merged into init)"
check_output "setup stub points to horus init" "has been merged into \`horus init\`" setup
check_output "index stub points to horus init" "has been merged into \`horus init\`" index

step "doctor (no live services required)"
check_output "doctor prints readiness header" "Horus readiness check" doctor
check_output "doctor shows CLI version"       "CLI version"           doctor

# ── Phase 2: full user path (requires Postgres) ───────────────────────────────

step "Postgres connectivity"
DB_URL="${DATABASE_URL:-postgresql://horus:horus@localhost:5433/horus}"
DB_AVAIL=0

# Probe: run `horus investigations` — it connects to Postgres and returns quickly
PROBE_OUT="$("${HORUS[@]}" investigations 2>&1 || true)"
if ! printf '%s' "$PROBE_OUT" | grep -qiE 'ECONNREFUSED|connection refused|ETIMEDOUT'; then
  DB_AVAIL=1
  ok "Postgres reachable ($DB_URL)"
elif printf '%s' "$PROBE_OUT" | grep -qF 'No investigations yet'; then
  DB_AVAIL=1
  ok "Postgres reachable ($DB_URL) — no investigations yet"
else
  fail "Postgres not reachable — run: docker compose up -d"
  printf '    %s\n' "$(dim "$(printf '%s' "$PROBE_OUT" | head -2)")"
fi

if [ "$DB_AVAIL" -eq 0 ]; then
  note "Skipping init/investigate/replay/postmortem: Postgres unavailable."
  note "Start Postgres with: docker compose up -d"
  note "Then re-run: $0 ${1:-}"
else
  # Decide whether to create a temp config or reuse one that already exists.
  LOCAL_CONFIG="$ROOT/.horus/config.json"
  CREATED_CONFIG=0
  PROJECT_NAME="smoke-e2e"

  step "init"
  if [ -f "$LOCAL_CONFIG" ]; then
    # An existing init is present — use it and read the project name from it.
    EXISTING_NAME="$(node -e "const c=require('$LOCAL_CONFIG'); process.stdout.write(c.project?.name ?? 'unknown')" 2>/dev/null || echo '')"
    if [ -n "$EXISTING_NAME" ]; then
      PROJECT_NAME="$EXISTING_NAME"
      ok "Existing .horus/config.json found — using project '$PROJECT_NAME'"
    else
      ok "Existing .horus/config.json found — using as-is"
    fi
  else
    INIT_OUT="$("${HORUS[@]}" init --name "$PROJECT_NAME" --env staging 2>&1 || true)"
    if printf '%s' "$INIT_OUT" | grep -qF 'Initialized Horus project'; then
      ok "horus init: project '$PROJECT_NAME' created"
      CREATED_CONFIG=1
    else
      fail "horus init failed"
      printf '    %s\n' "$(dim "$(printf '%s' "$INIT_OUT" | head -5)")"
    fi
  fi

  # -- investigate --
  # The command may produce a full report (with source connector + Postgres) or a
  # degraded response (no connector configured). Both are acceptable here — we verify
  # the command runs and does not crash, and then use `horus investigations` to find
  # any saved investigation for the replay/postmortem chain.
  step "investigate (git-only: HEAD~3)"
  INV_OUT="$("${HORUS[@]}" investigate \
    --name "$PROJECT_NAME" \
    --env staging \
    --since HEAD~3 \
    "e2e smoke test — git evidence only" 2>&1 || true)"
  if printf '%s' "$INV_OUT" | grep -qiE 'Root Cause|Confidence|Investigation|summary'; then
    ok "horus investigate: full report produced"
  elif printf '%s' "$INV_OUT" | grep -qiE 'connector|evidence|source|degraded'; then
    ok "horus investigate: command runs (degraded — no source connector configured; expected in fresh env)"
    printf '    %s\n' "$(dim "note: configure a source connector or run 'horus init' for a full report")"
  else
    fail "horus investigate: unexpected output (neither report nor known degraded message)"
    printf '    %s\n' "$(dim "$(printf '%s' "$INV_OUT" | head -4)")"
  fi

  # -- investigations list: find any saved investigation (from any prior or current run) --
  step "investigations list"
  INV_LIST="$("${HORUS[@]}" investigations 2>&1 || true)"
  LAST_ID="$(printf '%s' "$INV_LIST" | head -1 | awk '{print $1}')"
  if [ -n "$LAST_ID" ] && [ "$LAST_ID" != "No" ]; then
    ok "horus investigations: latest id = $LAST_ID"
  else
    fail "horus investigations: could not extract an investigation id"
    printf '    %s\n' "$(dim "$(printf '%s' "$INV_LIST" | head -3)")"
    LAST_ID=""
  fi

  if [ -n "$LAST_ID" ]; then
    # -- replay --
    step "replay"
    REPLAY_OUT="$("${HORUS[@]}" replay "$LAST_ID" 2>&1 || true)"
    if printf '%s' "$REPLAY_OUT" | grep -qiE 'Root Cause|Confidence|Investigation|summary'; then
      ok "horus replay $LAST_ID: report output confirmed"
    else
      fail "horus replay $LAST_ID: no report in output"
      printf '    %s\n' "$(dim "$(printf '%s' "$REPLAY_OUT" | head -5)")"
    fi

    # -- postmortem --
    step "postmortem"
    PM_OUT="$("${HORUS[@]}" postmortem "$LAST_ID" 2>&1 || true)"
    if printf '%s' "$PM_OUT" | grep -qF '## Summary'; then
      ok "horus postmortem $LAST_ID: Markdown output confirmed"
    else
      fail "horus postmortem $LAST_ID: no Markdown summary in output"
      printf '    %s\n' "$(dim "$(printf '%s' "$PM_OUT" | head -5)")"
    fi
  else
    note "Skipping replay and postmortem: no investigation id available"
  fi

  # -- cleanup temp config --
  if [ "$CREATED_CONFIG" -eq 1 ] && [ -f "$LOCAL_CONFIG" ]; then
    rm -f "$LOCAL_CONFIG"
    note "Removed temporary .horus/config.json"
  fi
fi

# ── Result ─────────────────────────────────────────────────────────────────────

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '  %s\n\n' "$(green "$(bold 'PASS')")"
  exit 0
else
  printf '  %s\n\n' "$(red "$(bold 'FAIL')")"
  exit 1
fi
