#!/usr/bin/env bash
# 07-payments-get.sh — GET /payments/:id for the payment created in 05.
# Independent verification path that the payment row + attempts list
# persist correctly and report the real on-chain tx hash.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "07-payments-get" "GET /payments/:id (paymentId from step 05)"

if [[ ! -f "$SMOKE_REAL_PAYMENT_ID_FILE" ]]; then
  fail "no paymentId from step 05 — re-run 00 → 05 first"
fi
pid=$(cat "$SMOKE_REAL_PAYMENT_ID_FILE")

expect_status 200 GET "/payments/$pid" || exit 1
echo "$RESPONSE_BODY" | jq -C '{paymentId, status, providerId, txHash, network, attempts: [.attempts[] | {providerId, outcome, latencyMs}]}'

status=$(echo "$RESPONSE_BODY" | jq -r .status)
tx=$(echo "$RESPONSE_BODY" | jq -r .txHash)
n=$(echo "$RESPONSE_BODY" | jq '.attempts | length')

if [[ "$status" != "settled" ]]; then
  fail "expected status=settled, got $status"
fi
if [[ "$tx" == "null" || -z "$tx" ]]; then
  fail "expected non-empty txHash"
fi
if (( n < 1 )); then
  fail "expected >=1 attempt, got $n"
fi
pass "payment $pid: status=settled, $n attempt(s), txHash=$tx"
