#!/usr/bin/env bash
# 04-verify.sh — bonus coverage for POST /verify
# Routes to the supporting adapter and confirms valid=true.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "04-verify" "POST /verify — expect valid=true via cosmos-pay"

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

expect_status 200 POST /verify -d "$body" || exit 1
echo "$RESPONSE_BODY" | jq -C .

valid=$(echo "$RESPONSE_BODY" | jq -r .valid)
pid=$(echo "$RESPONSE_BODY" | jq -r .providerId)
if [[ "$valid" != "true" ]]; then
  fail "expected valid=true, got $valid"
fi
if [[ "$pid" != "cosmos-pay" ]]; then
  fail "expected providerId=cosmos-pay (only supporter of exact_cosmos_authz), got $pid"
fi
pass "verify routed to cosmos-pay, payload accepted"
