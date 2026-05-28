#!/usr/bin/env bash
# 04-settle.sh — REAL on-chain settle on Base Sepolia via Coinbase CDP.
# Signs a fresh EIP-3009 transferWithAuthorization with a fresh 32-byte
# random nonce, POSTs it to /settle through suverse-pay. CDP submits the
# transferWithAuthorization to Base Sepolia. Asserts:
#   - HTTP 200
#   - status == "settled"
#   - providerId == "coinbase-cdp"
#   - txHash present + 32-byte hex
#   - on-chain receipt status == 0x1 (success) within ~60s
# Stashes the paymentId + Idempotency-Key + signed fixture so 05 can
# replay against the SAME nonce and prove idempotency.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "04-settle" "POST /settle — REAL on-chain Base Sepolia broadcast via CDP"

require_admin_key

nonce=$(sign_payload "$SMOKE_REVM_FIXTURE_INTERNAL" | tail -n1)
info "fresh nonce: $nonce"

idem="real-evm-smoke-$(date +%s)-$$"
info "Idempotency-Key: $idem"

curl_admin POST /settle \
  -H "Idempotency-Key: $idem" \
  -d @"$SMOKE_REVM_FIXTURE_INTERNAL"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected 200, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi

echo "$RESPONSE_BODY" | jq -C '{paymentId, status, providerId, txHash, network, attempts: (.attempts | length)}'

status=$(echo "$RESPONSE_BODY" | jq -r '.status')
provider=$(echo "$RESPONSE_BODY" | jq -r '.providerId')
tx=$(echo "$RESPONSE_BODY" | jq -r '.txHash')
pid=$(echo "$RESPONSE_BODY" | jq -r '.paymentId')

if [[ "$status" != "settled" ]]; then
  err_code=$(echo "$RESPONSE_BODY" | jq -r '.errorCode // ""')
  err_msg=$(echo "$RESPONSE_BODY" | jq -r '.errorMessage // ""')
  fail "expected status=settled, got $status (errorCode=$err_code errorMessage=$err_msg)"
fi
if [[ "$provider" != "coinbase-cdp" ]]; then
  fail "expected providerId=coinbase-cdp, got $provider"
fi
if [[ "$tx" == "null" || -z "$tx" ]]; then
  fail "expected non-empty txHash, got '$tx'"
fi
if ! [[ "$tx" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  fail "txHash is not a 32-byte hex string: '$tx'"
fi

echo "$pid"  > "$SMOKE_REVM_PAYMENT_ID_FILE"
echo "$idem" > "$SMOKE_REVM_IDEM_FILE"
echo "$tx"   > "$SMOKE_REVM_TX_FILE"

pass "settled $pid via coinbase-cdp on Base Sepolia"
info "tx hash: $tx"
info "explorer: $SMOKE_REVM_EXPLORER/tx/$tx"

# Independently confirm the on-chain receipt — CDP returning a txHash
# does not on its own prove inclusion. Wait up to ~60s for the tx to
# land in a Base Sepolia block.
info "waiting for on-chain receipt (status 0x1)..."
if wait_for_tx_receipt "$tx" 12 5; then
  pass "on-chain receipt confirmed status=0x1 for $tx"
else
  fail "on-chain receipt not confirmed within 60s for $tx — see $SMOKE_REVM_EXPLORER/tx/$tx"
fi
