#!/usr/bin/env bash
# 03-pay-and-call-idempotent.sh — replay the same pay_and_call call.
# Within the same hour bucket the Idempotency-Key is identical, so:
#   - gateway returns the SAME paymentId (no new on-chain tx)
#   - get_payment_status shows EXACTLY one attempt
# This is the strongest invariant we can demonstrate on-chain.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "03-pay-and-call-idempotent" "replay must NOT mint a second on-chain tx"

[[ -f "$SMOKE_MCP_REAL_SESSION_FILE" ]] || { fail "no session file"; exit 1; }
[[ -f "$SMOKE_MCP_REAL_PAYMENT_FILE" ]] || { fail "no paymentId from 02"; exit 1; }
sessionId=$(cat "$SMOKE_MCP_REAL_SESSION_FILE")
firstPaymentId=$(cat "$SMOKE_MCP_REAL_PAYMENT_FILE")
firstTx=$(cat "${SMOKE_MCP_REAL_TMP}/last-tx")

args=$(jq -nc --arg sid "$sessionId" --arg url "$DEMO_URL/premium" '{
  sessionId: $sid,
  url: $url,
  method: "GET"
}')

resp=$(mcp_call pay_and_call "$args")
echo "$resp" | jq -C '{status, paymentId, txHash, network, idempotentReplay}'
status=$(echo "$resp" | jq -r .status)
paymentId=$(echo "$resp" | jq -r .paymentId)
txHash=$(echo "$resp" | jq -r .txHash)
replay=$(echo "$resp" | jq -r '.idempotentReplay // false')

if [[ "$status" != "settled" ]]; then
  fail "expected status=settled on replay, got $status"
  exit 1
fi
if [[ "$paymentId" != "$firstPaymentId" ]]; then
  fail "IDEMPOTENCY BROKEN: first paymentId=$firstPaymentId, replay=$paymentId"
  exit 1
fi
pass "same paymentId on replay: $paymentId"

# MCP-side cache: replay short-circuits without re-submitting to the
# resource server. txHash MUST be identical because we return the
# previous result verbatim. If pay_and_call had hit the network again
# for signing/submission, cosmos-pay would have minted a new tx
# (different hash) since the payload nonce is freshly random.
if [[ "$txHash" != "$firstTx" ]]; then
  fail "expected same txHash on replay, got first=$firstTx replay=$txHash"
  exit 1
fi
if [[ "$replay" != "true" ]]; then
  fail "expected idempotentReplay=true on second call, got $replay"
  exit 1
fi
pass "same txHash on replay: $txHash"
pass "idempotentReplay=true — proves MCP-side cache short-circuited (no second on-chain broadcast)"
info "Mintscan: https://www.mintscan.io/noble-testnet/txs/$txHash"
