#!/usr/bin/env bash
# 03-pay-and-call-devnet.sh — the headline test. Drives the full real
# Solana devnet flow through MCP:
#   agent → MCP → 402 from mock x402 (configured for solana:devnet)
#       → MCP fetches recentBlockhash from devnet RPC
#       → signer-solana mints SPL transferChecked (self-transfer 100u)
#       → POST PAYMENT-SIGNATURE to mock
#       → mock forwards to PayAI /settle
#       → PayAI co-signs (feePayer) and submits to devnet
#       → mock returns 200 + PAYMENT-RESPONSE with txSignature
# Asserts a real Solana devnet txSignature.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "03-pay-and-call-devnet" "REAL Solana devnet settlement via PayAI"

[[ -f "$SMOKE_SOL_SESSION_FILE" ]] || { fail "no session file"; exit 1; }
sessionId=$(cat "$SMOKE_SOL_SESSION_FILE")

args=$(jq -nc --arg sid "$sessionId" --arg url "$MOCK_URL/premium" '{
  sessionId: $sid, url: $url, method: "GET"
}')

set +e
resp=$(mcp_call pay_and_call "$args")
rc=$?
set -e

if (( rc != 0 )); then
  echo "$resp" | jq -C '.' 2>/dev/null || echo "$resp"
  fail "pay_and_call returned rc=$rc"
fi

status=$(echo "$resp" | jq -r .status)
paymentId=$(echo "$resp" | jq -r .paymentId)
txSignature=$(echo "$resp" | jq -r .txHash)
respStatus=$(echo "$resp" | jq -r '.response.status')

if [[ "$status" != "settled" ]]; then
  echo "$resp" | jq -C '.'
  fail "expected status=settled, got $status"
fi
if [[ -z "$txSignature" || "$txSignature" == "null" ]]; then
  echo "$resp" | jq -C '.'
  fail "expected non-empty Solana txSignature, got '$txSignature'"
fi
if [[ "$respStatus" != "200" ]]; then
  fail "expected response.status=200 from /premium retry, got $respStatus"
fi

echo "$paymentId"   > "$SMOKE_SOL_PAYMENT_FILE"
echo "$txSignature" > "$SMOKE_SOL_TX_FILE"

pass "REAL Solana devnet settlement succeeded"
info "paymentId:   $paymentId"
info "txSignature: $txSignature"
info "explorer:    https://explorer.solana.com/tx/${txSignature}?cluster=devnet"
info "response:    $(echo "$resp" | jq -c '.response.body')"
echo "$resp" | jq -C '{status, paymentId, txHash, network, responseStatus: .response.status}'
