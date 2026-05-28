#!/usr/bin/env bash
# 04-verify-evm.sh — POST /facilitator/verify with a structurally-valid
# EVM PaymentPayload. The endpoint is "open" (no Bearer required), and
# this test asserts the ROUTING / SHAPE layer only — NOT CDP itself.
#
# Without a Coinbase CDP API key configured, the underlying CDP adapter
# returns an error (or simply rejects the verify). We accept four
# outcomes as PASS:
#   - HTTP 200 with isValid: false + invalidReason  (CDP rejected as
#     expected — the cosmos-pay-style facilitator-shape response)
#   - HTTP 200 with isValid: true                   (CDP key is wired
#     AND the payload happens to pass signature validation — rare for
#     this synthetic payload but legal)
#   - HTTP 400 with route_unsupported               (CDP adapter not
#     enabled at all)
#   - HTTP 502 from the gateway whose error.details.providerId is
#     "coinbase-cdp"                                (CDP IS wired AND
#     rejected the synthetic payload at the HTTP layer — v0.3.1+
#     reality, since CDP returns x402V2 signature-validation failures
#     as HTTP 400 which our httpJson throws on. This still proves the
#     routing layer reached CDP, which is what this test checks.)
# The FAIL conditions are: 401/403 (auth model misconfigured — /verify
# must be open), 5xx without a CDP attribution (server crash), or a
# malformed response body.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "04-verify-evm" "POST /facilitator/verify — EVM payload, routing-only assertion"

# Synthetic but spec-shaped EIP-3009 PaymentPayload. NOT a real signed
# transferWithAuthorization — the resource server / CDP would reject
# the signature, but the routing layer doesn't care.
payload='{
  "paymentPayload": {
    "x402Version": 2,
    "scheme": "exact",
    "network": "eip155:8453",
    "payload": {
      "signature": "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
      "authorization": {
        "from": "0x000000000000000000000000000000000000dEaD",
        "to": "0x000000000000000000000000000000000000bEEF",
        "value": "100000",
        "validAfter": "0",
        "validBefore": "9999999999",
        "nonce": "0x1111111111111111111111111111111111111111111111111111111111111111"
      }
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:8453",
    "maxAmountRequired": "100000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x000000000000000000000000000000000000bEEF",
    "resource": "https://example.com/premium",
    "maxTimeoutSeconds": 60,
    "extra": { "name": "USD Coin", "version": "2" }
  }
}'

curl_capture -X POST "$BASE_URL/facilitator/verify" \
  -H "Content-Type: application/json" \
  -d "$payload"

case "$RESPONSE_STATUS" in
  200)
    is_valid=$(echo "$RESPONSE_BODY" | jq -r '.isValid // empty')
    if [[ -z "$is_valid" ]]; then
      fail "200 with malformed body (no isValid). body: $RESPONSE_BODY"
    fi
    pass "/facilitator/verify routed to EVM adapter and returned isValid=$is_valid"
    echo "$RESPONSE_BODY" | jq -C
    ;;
  400)
    code=$(echo "$RESPONSE_BODY" | jq -r '.error.code // .code // empty')
    if [[ "$code" == "route_unsupported" ]]; then
      pass "EVM adapter not enabled in this build — routing reported route_unsupported"
      echo "$RESPONSE_BODY" | jq -C
    else
      fail "unexpected 400 (code='$code'). body: $RESPONSE_BODY"
    fi
    ;;
  401|403)
    fail "/facilitator/verify is supposed to be OPEN — got auth-rejection status $RESPONSE_STATUS. body: $RESPONSE_BODY"
    ;;
  502)
    cdp_attribution=$(echo "$RESPONSE_BODY" | jq -r '.error.details.providerId // ""')
    if [[ "$cdp_attribution" == "coinbase-cdp" ]]; then
      pass "/facilitator/verify routed to coinbase-cdp; CDP rejected the synthetic payload at HTTP layer (v0.3.1 wire-format reality)"
      echo "$RESPONSE_BODY" | jq -C
    else
      fail "unexpected 502 with no CDP attribution. body: $RESPONSE_BODY"
    fi
    ;;
  *)
    fail "unexpected HTTP $RESPONSE_STATUS. body: $RESPONSE_BODY"
    ;;
esac
