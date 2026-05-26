#!/usr/bin/env bash
# 01-health.sh — TASK.md acceptance scenario #1
# GET /health (no auth) → 200 {"status":"ok"}
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "01-health" "GET /health"

status=$(curl -sS -o /tmp/smoke-health.json -w '%{http_code}' "$BASE_URL/health")
if [[ "$status" != "200" ]]; then
  fail "expected 200, got $status"
fi
body=$(cat /tmp/smoke-health.json)
echo "  response: $body" | jq -C . 2>/dev/null || echo "  response: $body"
if [[ "$(jq -r .status /tmp/smoke-health.json)" != "ok" ]]; then
  fail "expected status=ok in body"
fi
pass "/health returned 200 ok"
