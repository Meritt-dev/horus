#!/usr/bin/env bash
#
# HOR-17 — product-level acceptance test for Horus (revalidated under the
# project/environment-scoped model, HOR-34, with ES error-signature evidence
# (HOR-10) and MongoDB state evidence (HOR-33)).
#
# Replays the "Zoho sync delays" incident against the live leadcall-api/production
# environment (source-intelligence host :8420 + Elasticsearch leadcall-api-prod-* + Postgres :5433)
# and asserts the investigation surfaces the expected structure. Exits non-zero
# if any expectation regresses.
#
# Prereqs: `horus init` inside leadcall-api, `docker compose up -d`,
# `pnpm build`, and runtime creds in ~/.horus.env (ES_URL/ES_USERNAME/ES_PASSWORD).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN="node $ROOT/apps/horus/dist/index.cjs"
PROJECT="leadcall-api"
ENVIRONMENT="production"
HINT="zoho sync delays"

# Load runtime connector credentials (Elasticsearch etc.) if present.
if [ -f "$HOME/.horus.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.horus.env"
  set +a
fi

fail=0
check() { # check "<description>" "<expected substring>" "<haystack>"
  if printf '%s' "$3" | grep -qiF -- "$2"; then
    echo "  ✓ $1"
  else
    echo "  ✗ $1 — expected to find: $2"
    fail=1
  fi
}

echo "== HOR-17 acceptance: $PROJECT/$ENVIRONMENT \"$HINT\" =="

# Build the project's queue map, then run the scoped investigation.
$BIN index --project "$PROJECT" --env "$ENVIRONMENT" >/dev/null 2>&1
REPORT="$($BIN investigate --project "$PROJECT" --env "$ENVIRONMENT" "$HINT" 2>&1)"
if [ -z "$REPORT" ]; then
  echo "  ✗ investigate produced no output (is the source-intelligence host on :8420 and Postgres up?)"
  exit 1
fi

# The async boundary the stitcher can't resolve — the heart of the scenario.
check "resolves the Zoho sync source"         "ZohoService"            "$REPORT"
check "surfaces the realtime queue boundary"   "zoho-sync-realtime"     "$REPORT"
check "surfaces the batch queue boundary"      "zoho-sync-batch"        "$REPORT"
check "names the consuming worker"             "ZohoRealtimeProcessor"  "$REPORT"
# Real runtime evidence (HOR-10): error signatures synthesized from Elasticsearch.
check "synthesizes error-signature evidence"   "error signature"        "$REPORT"
# Disciplined reasoning: competing, ranked, validated hypotheses.
check "generates the queue-backlog hypothesis" "queue-backlog"          "$REPORT"
check "marks a hypothesis supported"           "supported"              "$REPORT"
# Honesty about uncertainty.
check "surfaces evidence gaps"                 "Evidence gaps"          "$REPORT"
check "caps confidence (ceiling)"              "Confidence ceiling"     "$REPORT"
# Actionable output.
check "offers next actions"                    "Next actions"           "$REPORT"

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — Horus reconstructed the async Zoho sync path, pulled real log evidence, and reasoned about it."
  exit 0
else
  echo "FAIL — one or more acceptance expectations regressed."
  exit 1
fi
