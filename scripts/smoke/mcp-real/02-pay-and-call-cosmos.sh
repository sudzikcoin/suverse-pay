#!/usr/bin/env bash
# 02-pay-and-call-cosmos.sh — full real MCP pay_and_call flow:
#   agent → MCP → 402 on demo server (via x402-cosmos middleware)
#       → ADR-036 sign by signer-cosmos
#       → POST /settle on the real gateway
#       → on-chain MsgExec(MsgSend) broadcast through cosmos-pay
#       → retry demo /premium with PAYMENT-SIGNATURE
#       → 200 secret payload
# Asserts a non-empty txHash and prints the Mintscan explorer URL.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "02-pay-and-call-cosmos" "REAL on-chain broadcast on Noble testnet"

[[ -f "$SMOKE_MCP_REAL_SESSION_FILE" ]] || { fail "no session file"; exit 1; }
sessionId=$(cat "$SMOKE_MCP_REAL_SESSION_FILE")

args=$(jq -nc --arg sid "$sessionId" --arg url "$DEMO_URL/premium" '{
  sessionId: $sid,
  url: $url,
  method: "GET"
}')

set +e
resp=$(mcp_call pay_and_call "$args")
rc=$?
set -e

if (( rc != 0 )); then
  echo "$resp" | jq -C '.' 2>/dev/null || echo "$resp"
  # Try to detect grant expiration; surface refresh instructions.
  if echo "$resp" | grep -qiE "grant|authoriz|insufficient"; then
    fail "pay_and_call returned an error — likely an expired/missing x/authz grant."
    echo "${YELLOW}Refresh the grant (24h window) with:" >&2
    echo "  cd $COSMOS_PAY_REPO && go run ./tools/grant \\
       --mnemonic \"\$X402_PAYER_MNEMONIC\" \\
       --grantee \"\$X402_FACILITATOR_GRANTEE\" \\
       --spend-limit 1000000uusdc --expiration 24h${RESET}" >&2
  else
    fail "pay_and_call failed (rc=$rc)"
  fi
  exit 1
fi

echo "$resp" | jq -C '{status, paymentId, txHash, network, responseStatus: .response.status}'

status=$(echo "$resp" | jq -r .status)
paymentId=$(echo "$resp" | jq -r .paymentId)
txHash=$(echo "$resp" | jq -r .txHash)
responseStatus=$(echo "$resp" | jq -r '.response.status')

if [[ "$status" != "settled" ]]; then
  fail "expected status=settled, got $status"
  exit 1
fi
if [[ -z "$txHash" || "$txHash" == "null" ]]; then
  fail "expected non-empty on-chain txHash, got '$txHash'"
  exit 1
fi
if [[ "$responseStatus" != "200" ]]; then
  fail "expected response.status=200 from /premium retry, got $responseStatus"
  exit 1
fi

echo "$paymentId" > "$SMOKE_MCP_REAL_PAYMENT_FILE"
echo "$txHash"    > "${SMOKE_MCP_REAL_TMP}/last-tx"

pass "REAL settlement on Noble grand-1 succeeded"
info "paymentId: $paymentId"
info "txHash:    $txHash"
info "explorer:  https://www.mintscan.io/noble-testnet/txs/$txHash"
info "response:  $(echo "$resp" | jq -c '.response.body')"
