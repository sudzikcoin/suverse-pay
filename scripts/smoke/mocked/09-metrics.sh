#!/usr/bin/env bash
# 09-metrics.sh — TASK.md acceptance scenario #10
# GET /metrics/summary returns totals + per-provider rolls.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "09-metrics" "GET /metrics/summary"

expect_status 200 GET /metrics/summary || exit 1
echo "$RESPONSE_BODY" | jq -C '{totals, providers: [.providers[] | {providerId, attempts, successes, failures, avgLatencyMs}]}'

total=$(echo "$RESPONSE_BODY" | jq -r '.totals.payments')
if [[ "$total" == "null" ]]; then
  fail "totals.payments missing"
fi
pass "metrics returned: payments=$total"
