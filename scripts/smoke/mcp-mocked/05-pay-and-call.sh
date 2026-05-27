#!/usr/bin/env bash
# 05-pay-and-call.sh — MCP pay_and_call: 402 → sign (real cosmos signer)
# → mock /settle → retry with X-PAYMENT → 200 response from mock x402.
# Then replay to verify idempotency end-to-end (same Idempotency-Key,
# same paymentId, single settlement record in the mock gateway).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "05-pay-and-call" "MCP pay_and_call → mock x402 (direct submit, MCP-side cache)"

[[ -f "$SMOKE_MCP_SESSION_FILE" ]] || { fail "no session file"; exit 1; }
sessionId=$(cat "$SMOKE_MCP_SESSION_FILE")

args=$(jq -nc --arg sid "$sessionId" --arg url "$MOCK_X402_URL/weather" '{
  sessionId: $sid,
  url: $url,
  method: "GET"
}')

# First call: 402 → sign → POST PAYMENT-SIGNATURE → 200. No gateway
# /settle call — pay_and_call submits directly to the resource server.
resp1=$(mcp_call pay_and_call "$args")
echo "$resp1" | jq -C '{status, paymentId, txHash, network, idempotentReplay, responseStatus: .response.status, responseBody: .response.body}'

status1=$(echo "$resp1" | jq -r .status)
paymentId1=$(echo "$resp1" | jq -r .paymentId)
txHash1=$(echo "$resp1" | jq -r .txHash)
respStatus1=$(echo "$resp1" | jq -r .response.status)
respBody1=$(echo "$resp1" | jq -c .response.body)
replay1=$(echo "$resp1" | jq -r '.idempotentReplay // false')

if [[ "$status1" != "settled" ]]; then
  fail "expected status=settled, got $status1"
  exit 1
fi
if [[ "$respStatus1" != "200" ]]; then
  fail "expected response.status=200 on retry, got $respStatus1"
  exit 1
fi
if ! echo "$respBody1" | jq -e '.weather == "sunny"' >/dev/null; then
  fail "expected response body weather=sunny, got: $respBody1"
  exit 1
fi
if [[ "$replay1" == "true" ]]; then
  fail "first call should NOT be idempotentReplay=true"
  exit 1
fi
if [[ ! "$paymentId1" =~ ^mcp_[0-9a-f]{32}$ ]]; then
  fail "expected paymentId to match mcp_<32hex>, got: $paymentId1"
  exit 1
fi
echo "$paymentId1" > "$SMOKE_MCP_PAYMENT_FILE"
pass "first call: paymentId=$paymentId1, txHash=$txHash1, weather=$(echo "$respBody1" | jq -r .weather)"

# Second call with identical (url, body) — must hit MCP-side cache and
# return the same paymentId + txHash, with idempotentReplay=true.
resp2=$(mcp_call pay_and_call "$args")
paymentId2=$(echo "$resp2" | jq -r .paymentId)
txHash2=$(echo "$resp2" | jq -r .txHash)
replay2=$(echo "$resp2" | jq -r '.idempotentReplay // false')
if [[ "$paymentId2" != "$paymentId1" ]]; then
  fail "idempotency broken: paymentId changed from $paymentId1 to $paymentId2"
  exit 1
fi
if [[ "$txHash2" != "$txHash1" ]]; then
  fail "idempotency broken: txHash changed from $txHash1 to $txHash2"
  exit 1
fi
if [[ "$replay2" != "true" ]]; then
  fail "second call should be idempotentReplay=true, got $replay2"
  exit 1
fi
pass "second call: cached replay — same paymentId, same txHash, no second submission"
