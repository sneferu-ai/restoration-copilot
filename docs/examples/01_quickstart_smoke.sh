#!/usr/bin/env bash
# 01 — Install smoke test against a running Restoration Copilot server.
#
# Usage:
#   python3 -m orchestrator.api.server &        # terminal 1
#   bash docs/examples/01_quickstart_smoke.sh   # terminal 2
#
# Optional env: BASE (default http://localhost:8000),
#               OPERATOR_USERNAME / OPERATOR_PASSWORD (dev defaults).
# Exit 0 when every step returns the documented shape; exit 1 otherwise.
set -euo pipefail

BASE="${BASE:-http://localhost:8000}"
USER_NAME="${OPERATOR_USERNAME:-operator}"
PASSWORD="${OPERATOR_PASSWORD:-restoration-dev}"

step() { printf '\n== %s ==\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

step "1/4 liveness"
curl -sf "$BASE/live/status" | grep -q '"status": "ok"' || fail "GET /live/status"
echo "OK  $BASE/live/status"

step "2/4 module health"
HEALTH=$(curl -sf "$BASE/restoration/health") || fail "GET /restoration/health"
echo "$HEALTH" | grep -q '"module_loaded": true' || fail "module_loaded not true: $HEALTH"
echo "$HEALTH" | grep -q '"os_supported": true' || fail "os_supported not true (POSIX required): $HEALTH"
echo "OK  $HEALTH"

step "3/4 operator login"
TOKEN=$(curl -sf -X POST "$BASE/admin/operator/session" \
  -H 'Content-Type: application/json' \
  -d "{\"username\": \"$USER_NAME\", \"password\": \"$PASSWORD\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['session_token'])") \
  || fail "POST /admin/operator/session (check OPERATOR_USERNAME/PASSWORD)"
echo "OK  session_token=${TOKEN:0:8}…"

step "4/4 create a project"
OUT=$(curl -sf -X POST "$BASE/restoration/projects" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"vehicle_meta": {"year": "1969", "make": "Chevrolet", "model": "Camaro"}}') \
  || fail "POST /restoration/projects"
echo "$OUT" | grep -q '"project_id"' || fail "no project_id in: $OUT"
echo "OK  $OUT"

printf '\nSMOKE PASS — open %s/restoration-ui and sign in with your operator credentials.\n' "$BASE"
