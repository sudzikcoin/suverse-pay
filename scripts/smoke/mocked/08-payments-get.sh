#!/usr/bin/env bash
# 08-payments-get.sh — TASK.md acceptance scenario #9
# GET /payments/:id returns the payment with its attempts list.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "08-payments-get" "GET /payments/:id (uses paymentId from step 05)"

if [[ ! -f "$SMOKE_PAYMENT_ID_FILE" ]]; then
  fail "no paymentId from step 05 — re-run 00 → 05 first"
fi
pid=$(cat "$SMOKE_PAYMENT_ID_FILE")

expect_status 200 GET "/payments/$pid" || exit 1
echo "$RESPONSE_BODY" | jq -C '{paymentId, status, providerId, txHash, attempts: [.attempts[] | {providerId, outcome, latencyMs}]}'

n=$(echo "$RESPONSE_BODY" | jq '.attempts | length')
status=$(echo "$RESPONSE_BODY" | jq -r .status)
if [[ "$status" != "settled" ]]; then
  fail "expected settled, got $status"
fi
if (( n < 1 )); then
  fail "expected >=1 attempt, got $n"
fi
pass "payment row + $n attempt(s) returned, status=$status"
