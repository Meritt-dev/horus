#!/usr/bin/env bash
# Horus local demo environment setup (HOR-101)
#
# Prepares the minimum local services and sample data to demonstrate Horus
# honestly. Does NOT install system-level dependencies or require external
# cloud services. Runtime connectors (Elasticsearch, Grafana, MongoDB) are
# optional — the script reports what is configured and what is missing.
#
# Usage (from the Horus repo root):
#   ./scripts/demo-setup.sh
#
# Prerequisites (must already be installed):
#   docker   — for the local Postgres instance
#   node     — ≥22 (for migrations and the CLI)
#   pnpm     — for running workspace migrations
#
# After setup, use these demo commands:
#   horus investigate "<hint>"
#   horus investigations list
#   horus replay <id>
#   horus postmortem <id>

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# ── colour helpers ─────────────────────────────────────────────────────────────
bold()   { printf '\033[1m%s\033[0m' "$*"; }
green()  { printf '\033[32m%s\033[0m' "$*"; }
yellow() { printf '\033[33m%s\033[0m' "$*"; }
red()    { printf '\033[31m%s\033[0m' "$*"; }
dim()    { printf '\033[2m%s\033[0m' "$*"; }

pass()   { printf '  %s %s\n'   "$(green '✓')"  "$*"; }
warn()   { printf '  %s %s\n'   "$(yellow '~')" "$*"; }
fail()   { printf '  %s %s\n'   "$(red '✗')"    "$*"; }
hint()   { printf '    %s\n'    "$(dim "→ $*")"; }

DEMO_READY=0   # 0 = all required services up; 1 = something missing

# ── 1. Prerequisite binaries ───────────────────────────────────────────────────
printf '\n  %s\n\n' "$(bold 'Horus demo environment setup')"

printf '  %s\n\n' "$(bold 'Prerequisites')"

if command -v docker &>/dev/null; then
  pass "docker found"
else
  fail "docker not found"
  hint "Install Docker Desktop: https://docs.docker.com/get-docker/"
  DEMO_READY=1
fi

if command -v node &>/dev/null; then
  pass "node found $(dim "($(node --version))")"
else
  fail "node not found"
  hint "Install Node.js 22: https://nodejs.org/"
  DEMO_READY=1
fi

if command -v pnpm &>/dev/null; then
  pass "pnpm found"
else
  fail "pnpm not found"
  hint "Install: npm install -g pnpm"
  DEMO_READY=1
fi

if [ "$DEMO_READY" -ne 0 ]; then
  printf '\n  %s\n\n' "$(red "$(bold 'FAIL')")"
  printf '  Install the missing prerequisites above and re-run %s.\n\n' \
    "$(bold './scripts/demo-setup.sh')"
  exit 1
fi

# ── 2. Postgres ────────────────────────────────────────────────────────────────
printf '\n  %s\n\n' "$(bold 'Database (Postgres 16)')"

DB_CONTAINER="horus-db"
DB_URL="${DATABASE_URL:-postgresql://horus:horus@localhost:5433/horus}"

# Check if the container already exists (running or stopped)
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
  pass "$DB_CONTAINER container is running"
elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$DB_CONTAINER"; then
  warn "$DB_CONTAINER container exists but is stopped — starting it"
  if docker start "$DB_CONTAINER" >/dev/null 2>&1; then
    pass "$DB_CONTAINER started"
  else
    fail "could not start $DB_CONTAINER"
    hint "Run: docker start $DB_CONTAINER"
    DEMO_READY=1
  fi
else
  printf '  Creating %s container...\n' "$DB_CONTAINER"
  if docker run -d --name "$DB_CONTAINER" \
    -e POSTGRES_USER=horus \
    -e POSTGRES_PASSWORD=horus \
    -e POSTGRES_DB=horus \
    -p 5433:5432 \
    postgres:16 >/dev/null 2>&1; then
    pass "$DB_CONTAINER created and started"
  else
    fail "could not create $DB_CONTAINER container"
    hint "docker run -d --name $DB_CONTAINER \\"
    hint "  -e POSTGRES_USER=horus -e POSTGRES_PASSWORD=horus -e POSTGRES_DB=horus \\"
    hint "  -p 5433:5432 postgres:16"
    DEMO_READY=1
  fi
fi

# Wait for Postgres to accept connections (up to 15 s)
if [ "$DEMO_READY" -eq 0 ]; then
  printf '  Waiting for Postgres to be ready...'
  for i in $(seq 1 15); do
    if docker exec "$DB_CONTAINER" pg_isready -U horus -q 2>/dev/null; then
      printf ' %s\n' "$(green 'ready')"
      break
    fi
    printf '.'
    sleep 1
    if [ "$i" -eq 15 ]; then
      printf ' %s\n' "$(red 'timed out')"
      fail "Postgres did not become ready within 15 seconds"
      hint "Check container logs: docker logs $DB_CONTAINER"
      DEMO_READY=1
    fi
  done
fi

# ── 3. Migrations ──────────────────────────────────────────────────────────────
if [ "$DEMO_READY" -eq 0 ]; then
  printf '\n  %s\n\n' "$(bold 'Database migrations')"
  if DATABASE_URL="$DB_URL" pnpm db migrate 2>&1; then
    pass "migrations applied"
  else
    fail "migrations failed"
    hint "Run: DATABASE_URL=\"$DB_URL\" pnpm db migrate"
    DEMO_READY=1
  fi
fi

# ── 4. Source-intelligence host ─────────────────────────────────────────────────
printf '\n  %s\n\n' "$(bold 'Source-intelligence host')"

SOURCE_OK=0
if command -v horus-source &>/dev/null; then
  pass "source-intelligence backend found"
  # Check if a source-intelligence host is reachable on the default port
  if curl -sf http://127.0.0.1:8420/health >/dev/null 2>&1; then
    pass "source-intelligence host reachable at http://127.0.0.1:8420"
    SOURCE_OK=1
  else
    warn "source-intelligence host not running"
    hint "Start: cd /path/to/your-repo && horus init"
  fi
else
  warn "source-intelligence backend not installed (source features will be unavailable)"
  hint "Install (Python 3.11+ required):"
  hint "  pip install horus-source"
fi

# ── 5. Readiness summary ────────────────────────────────────────────────────────
printf '\n  %s\n\n' "$(bold 'Connector caveats')"

# Check for a global config to detect runtime connectors
HORUS_CONFIG_HINT="config/horus.config.js"
if [ -f "$ROOT/$HORUS_CONFIG_HINT" ]; then
  warn "Runtime connectors (Elasticsearch, MongoDB, Grafana) depend on your horus.config.js"
  hint "Secrets are read from environment variables at runtime — see $HORUS_CONFIG_HINT"
  hint "horus doctor --config $HORUS_CONFIG_HINT  shows connector status"
else
  warn "No horus.config.js found — runtime log evidence will not be available"
  hint "Generate one: horus generate-config"
fi

# ── 6. Demo commands ───────────────────────────────────────────────────────────
printf '\n  %s\n\n' "$(bold 'Demo commands')"

if [ "$SOURCE_OK" -eq 1 ]; then
  INVESTIGATE_HINT='horus investigate "payment service returned 500s for 3 minutes"'
else
  INVESTIGATE_HINT='horus investigate "payment service returned 500s for 3 minutes"'
fi

printf '  %s\n'    "$(dim '# Investigate an incident')"
printf '  %s\n\n'  "$INVESTIGATE_HINT"
printf '  %s\n'    "$(dim '# List all past investigations')"
printf '  %s\n\n'  'horus investigations list'
printf '  %s\n'    "$(dim '# Replay a previous investigation')"
printf '  %s\n\n'  'horus replay <investigation-id>'
printf '  %s\n'    "$(dim '# Generate a postmortem')"
printf '  %s\n\n'  'horus postmortem <investigation-id>'
printf '  %s\n'    "$(dim '# Check overall readiness')"
printf '  %s\n\n'  'horus doctor'

# ── 7. Final result ────────────────────────────────────────────────────────────
if [ "$DEMO_READY" -eq 0 ]; then
  printf '  %s\n\n' "$(green "$(bold 'READY')")"
  printf '  Postgres is up and migrations are applied.\n'
  if [ "$SOURCE_OK" -eq 1 ]; then
    printf '  Source-intelligence host is running — run %s then use the demo commands above.\n\n' \
      "$(bold 'horus init')"
  else
    printf '  Source intelligence is not configured — run horus init in your repo for richer investigation results.\n\n'
  fi
  exit 0
else
  printf '  %s\n\n' "$(yellow "$(bold 'NOT READY')")"
  printf '  Resolve the items above and re-run %s.\n\n' \
    "$(bold './scripts/demo-setup.sh')"
  exit 1
fi
