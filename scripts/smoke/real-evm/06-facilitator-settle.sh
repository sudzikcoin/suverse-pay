#!/usr/bin/env bash
# 06-facilitator-settle.sh — REAL on-chain settle on Base Sepolia via
# the PUBLIC /facilitator/settle surface (not the internal /settle).
# Uses the resource API key bootstrapped in 00-setup. Signs a FRESH
# EIP-3009 payload (different nonce from 04, since EIP-3009 nonces are
# single-use). Asserts:
#   - HTTP 200
#   - success: true
#   - transaction (txHash) present + 32-byte hex
#   - transaction differs from 04-settle's tx (proves a second on-chain
#     broadcast actually happened, not idempotent cache reuse)
#   - on-chain receipt status == 0x1 within ~60s
#
# This step is what proves /facilitator/settle works on EVM. Up through
# v0.3.0, only Cosmos was real-tested through the facilitator surface
# (Sub-task 7 in Phase 3).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "06-facilitator-settle" "POST /facilitator/settle — REAL on-chain Base Sepolia via CDP"

require_resource_key

nonce=$(sign_payload "$SMOKE_REVM_FIXTURE_FACILITATOR" | tail -n1)
info "fresh nonce: $nonce"

curl_capture -X POST "$BASE_URL/facilitator/settle" \
  -H "Authorization: Bearer $RESOURCE_KEY" \
  -H "Content-Type: application/json" \
  -d @"$SMOKE_REVM_FIXTURE_FACILITATOR"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected 200, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi
echo "$RESPONSE_BODY" | jq -C

success=$(echo "$RESPONSE_BODY" | jq -r '.success')
tx=$(echo "$RESPONSE_BODY" | jq -r '.transaction')
network=$(echo "$RESPONSE_BODY" | jq -r '.network')

if [[ "$success" != "true" ]]; then
  reason=$(echo "$RESPONSE_BODY" | jq -r '.errorReason // "no reason"')
  msg=$(echo "$RESPONSE_BODY" | jq -r '.errorMessage // ""')
  fail "expected success=true, got success=$success (reason=$reason msg=$msg)"
fi
if ! [[ "$tx" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  fail "transaction is not a 32-byte hex string: '$tx'"
fi
if [[ "$network" != "$SMOKE_REVM_NETWORK" ]]; then
  fail "expected network=$SMOKE_REVM_NETWORK, got $network"
fi

# Sanity: make sure this is genuinely a NEW on-chain transaction, not
# the same tx 04-settle produced. If they match, something cached the
# tx between the internal and facilitator paths — which would be a
# silent correctness bug.
if [[ -f "$SMOKE_REVM_TX_FILE" ]]; then
  internal_tx=$(cat "$SMOKE_REVM_TX_FILE")
  if [[ "$tx" == "$internal_tx" ]]; then
    fail "facilitator tx $tx is identical to 04-settle's tx — different code paths must not share a tx"
  fi
fi

echo "$tx" > "$SMOKE_REVM_FAC_TX_FILE"
pass "/facilitator/settle broadcast on Base Sepolia"
info "tx hash: $tx"
info "explorer: $SMOKE_REVM_EXPLORER/tx/$tx"

info "waiting for on-chain receipt (status 0x1)..."
if wait_for_tx_receipt "$tx" 12 5; then
  pass "on-chain receipt confirmed status=0x1 for $tx"
else
  fail "on-chain receipt not confirmed within 60s for $tx — see $SMOKE_REVM_EXPLORER/tx/$tx"
fi
