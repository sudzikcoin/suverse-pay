#!/usr/bin/env bash
# 06-settle-no-auth.sh — POST /facilitator/settle WITHOUT Authorization
# header. Asserts HTTP 401 with a clear unauthorized message — proves
# the auth boundary is in place.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "06-settle-no-auth" "POST /facilitator/settle without Bearer — must return 401"

# Use a syntactically-valid body so the auth check fires before the
# schema validator. Without a body, Fastify might short-circuit on
# parse failure.
body='{"paymentPayload":{"x402Version":2,"scheme":"exact","network":"eip155:8453","payload":{}},"paymentRequirements":{"scheme":"exact","network":"eip155:8453","maxAmountRequired":"1","asset":"0x0","payTo":"0x0","resource":"x","maxTimeoutSeconds":60,"extra":{}}}'

curl_capture -X POST "$BASE_URL/facilitator/settle" \
  -H "Content-Type: application/json" \
  -d "$body"

if [[ "$RESPONSE_STATUS" != "401" ]]; then
  fail "expected HTTP 401, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi
code=$(echo "$RESPONSE_BODY" | jq -r '.error.code // .code // empty')
if [[ "$code" != "unauthorized" ]]; then
  fail "expected code=unauthorized, got '$code'. body: $RESPONSE_BODY"
fi
pass "/facilitator/settle correctly returned 401 with code=unauthorized"
echo "$RESPONSE_BODY" | jq -C
