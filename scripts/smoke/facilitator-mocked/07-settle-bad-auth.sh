#!/usr/bin/env bash
# 07-settle-bad-auth.sh — POST /facilitator/settle with a syntactically
# valid Bearer token that doesn't match any resource_api_keys row.
# Asserts HTTP 401 + code=unauthorized.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "07-settle-bad-auth" "POST /facilitator/settle with bogus Bearer — must return 401"

bogus="deadbeef00000000000000000000000000000000000000000000000000000000"
body='{"paymentPayload":{"x402Version":2,"scheme":"exact","network":"eip155:8453","payload":{}},"paymentRequirements":{"scheme":"exact","network":"eip155:8453","maxAmountRequired":"1","asset":"0x0","payTo":"0x0","resource":"x","maxTimeoutSeconds":60,"extra":{}}}'

curl_capture -X POST "$BASE_URL/facilitator/settle" \
  -H "Authorization: Bearer $bogus" \
  -H "Content-Type: application/json" \
  -d "$body"

if [[ "$RESPONSE_STATUS" != "401" ]]; then
  fail "expected HTTP 401, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi
code=$(echo "$RESPONSE_BODY" | jq -r '.error.code // .code // empty')
if [[ "$code" != "unauthorized" ]]; then
  fail "expected code=unauthorized, got '$code'. body: $RESPONSE_BODY"
fi
pass "/facilitator/settle correctly returned 401 for an invalid bearer token"
echo "$RESPONSE_BODY" | jq -C
