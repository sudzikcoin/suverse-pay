#!/usr/bin/env bash
# 04-pay-and-call-idempotent.sh — replay 03 within the same hour
# bucket. MCP's in-process idempotency cache is keyed by
# (payerAddress, network, url, sha256(body), hourBucket), so the
# second call returns the cached result with idempotentReplay=true
# and the SAME paymentId — without re-signing or re-submitting.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "04-pay-and-call-idempotent" "replay 03 — must short-circuit via MCP idempotency cache"

[[ -f "$SMOKE_SOL_SESSION_FILE" ]] || { fail "no session file"; exit 1; }
[[ -f "$SMOKE_SOL_PAYMENT_FILE" ]] || { fail "no payment id from 03 — run that first"; exit 1; }
sessionId=$(cat "$SMOKE_SOL_SESSION_FILE")
first_payment=$(cat "$SMOKE_SOL_PAYMENT_FILE")
first_tx=$(cat "$SMOKE_SOL_TX_FILE")

args=$(jq -nc --arg sid "$sessionId" --arg url "$MOCK_URL/premium" '{
  sessionId: $sid, url: $url, method: "GET"
}')

resp=$(mcp_call pay_and_call "$args")
status=$(echo "$resp" | jq -r .status)
replay=$(echo "$resp" | jq -r '.idempotentReplay // false')
replay_payment=$(echo "$resp" | jq -r .paymentId)
replay_tx=$(echo "$resp" | jq -r .txHash)

if [[ "$status" != "settled" ]]; then
  echo "$resp" | jq -C '.'
  fail "expected status=settled on replay, got $status"
fi
if [[ "$replay" != "true" ]]; then
  echo "$resp" | jq -C '.'
  fail "expected idempotentReplay=true, got $replay"
fi
if [[ "$replay_payment" != "$first_payment" ]]; then
  fail "expected same paymentId ($first_payment), got $replay_payment"
fi
if [[ "$replay_tx" != "$first_tx" ]]; then
  fail "expected same txSignature ($first_tx), got $replay_tx"
fi

pass "MCP returned the cached result; no second on-chain Solana tx"
info "paymentId (both):   $first_payment"
info "txSignature (both): $first_tx"
