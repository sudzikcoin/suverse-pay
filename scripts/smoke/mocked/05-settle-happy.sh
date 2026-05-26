#!/usr/bin/env bash
# 05-settle-happy.sh — TASK.md acceptance scenario #5
# POST /settle with Idempotency-Key → settled with mock tx hash;
# payments + payment_attempts + routing_decisions rows written.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "05-settle-happy" "POST /settle — expect status=settled, MOCK_TX_*"

idem="smoke-happy-$(date +%s)"

read -r -d '' body <<'JSON' || true
{
  "paymentPayload": {
    "x402Version": 2,
    "scheme": "exact_cosmos_authz",
    "network": "cosmos:noble-1",
    "payload": { "from": "noble1payer", "publicKey": "k", "signature": "s",
      "authorization": { "from": "noble1payer", "to": "noble1recipient",
        "denom": "uusdc", "amount": "10000", "nonce": "1",
        "validAfter": 0, "validBefore": 9999999999,
        "resource": "https://example.com/widget", "chainId": "noble-1" } }
  },
  "paymentRequirements": {
    "scheme": "exact_cosmos_authz",
    "network": "cosmos:noble-1",
    "maxAmountRequired": "10000",
    "asset": "uusdc",
    "payTo": "noble1recipient",
    "resource": "https://example.com/widget",
    "maxTimeoutSeconds": 60,
    "extra": { "facilitator": "smoke", "chainId": "noble-1" }
  }
}
JSON

expect_status 200 POST /settle -H "Idempotency-Key: $idem" -d "$body" || exit 1
echo "$RESPONSE_BODY" | jq -C '{paymentId, status, providerId, txHash, attempts: (.attempts | length)}'

status=$(echo "$RESPONSE_BODY" | jq -r .status)
tx=$(echo "$RESPONSE_BODY" | jq -r .txHash)
pid=$(echo "$RESPONSE_BODY" | jq -r .paymentId)

if [[ "$status" != "settled" ]]; then
  fail "expected status=settled, got $status"
fi
if [[ "$tx" != MOCK_TX_* ]]; then
  fail "expected txHash MOCK_TX_*, got '$tx'"
fi
echo "$pid" > "$SMOKE_PAYMENT_ID_FILE"
echo "$idem" > "$SMOKE_TMP/last-idem"
pass "settled $pid via cosmos-pay, txHash=$tx (saved for 06/08)"
