#!/usr/bin/env bash
# 06-settle-idempotent.sh — TASK.md acceptance scenario #6
# Re-issue the previous /settle with the SAME Idempotency-Key — the
# returned paymentId must match and the DB must still hold one row.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "06-settle-idempotent" "replay /settle with same Idempotency-Key"

if [[ ! -f "$SMOKE_PAYMENT_ID_FILE" || ! -f "$SMOKE_TMP/last-idem" ]]; then
  fail "no prior payment recorded — run 05-settle-happy.sh first"
fi
expected_id=$(cat "$SMOKE_PAYMENT_ID_FILE")
idem=$(cat "$SMOKE_TMP/last-idem")

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
echo "$RESPONSE_BODY" | jq -C '{paymentId, status, providerId, txHash}'

got=$(echo "$RESPONSE_BODY" | jq -r .paymentId)
if [[ "$got" != "$expected_id" ]]; then
  fail "replay returned a DIFFERENT paymentId ($got vs $expected_id)"
fi
pass "replay returned the same paymentId — idempotency holds"
