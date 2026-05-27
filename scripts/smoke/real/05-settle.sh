#!/usr/bin/env bash
# 05-settle.sh — POST /settle through suverse-pay with the signed fixture.
# Broadcasts a real MsgExec(MsgSend) on Cosmos testnet grand-1, asserts a
# non-empty txHash. Stores the paymentId + Idempotency-Key for 06/07.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "05-settle" "POST /settle — real on-chain broadcast on Noble testnet"

if [[ ! -f "$FIXTURE_FILE" ]]; then
  fail "$FIXTURE_FILE missing — run 00-prepare-fixtures.sh"
fi

idem="real-smoke-$(date +%s)-$$"
info "Idempotency-Key: $idem"

expect_status 200 POST /settle \
  -H "Idempotency-Key: $idem" \
  -d @"$FIXTURE_FILE" || exit 1

echo "$RESPONSE_BODY" | jq -C '{paymentId, status, providerId, txHash, network, attempts: (.attempts | length)}'

status=$(echo "$RESPONSE_BODY" | jq -r .status)
tx=$(echo "$RESPONSE_BODY" | jq -r .txHash)
pid=$(echo "$RESPONSE_BODY" | jq -r .paymentId)
provider=$(echo "$RESPONSE_BODY" | jq -r .providerId)

if [[ "$status" != "settled" ]]; then
  errCode=$(echo "$RESPONSE_BODY" | jq -r '.errorCode // ""')
  errMsg=$(echo "$RESPONSE_BODY" | jq -r '.errorMessage // ""')
  fail "expected status=settled, got $status (errorCode=$errCode errorMessage=$errMsg)"
fi
if [[ "$tx" == "null" || -z "$tx" ]]; then
  fail "expected non-empty txHash, got '$tx'"
fi
if [[ "$provider" != "cosmos-pay" ]]; then
  fail "expected providerId=cosmos-pay, got $provider"
fi

echo "$pid"  > "$SMOKE_REAL_PAYMENT_ID_FILE"
echo "$idem" > "$SMOKE_REAL_IDEM_FILE"

pass "settled $pid via cosmos-pay"
info "tx hash: $tx"
info "explorer: https://www.mintscan.io/noble-testnet/txs/$tx"
