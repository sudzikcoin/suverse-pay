#!/usr/bin/env bash
# 03-verify-cosmos.sh — POST /facilitator/verify with a real Cosmos
# signed payload (reuses the Phase 1 real-smoke fixture). Asserts
# isValid: true. /verify is open (no auth) and doesn't broadcast.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "03-verify-cosmos" "POST /facilitator/verify — real Cosmos signed payload"

# The cosmos-pay fixture is single-use AND short-lived (~50s validity).
# Regenerate at every step that consumes it; otherwise a stale nonce or
# expired authz produces expired_authorization / nonce_already_used.
bash "$SMOKE_FAC_ROOT/scripts/smoke/real/00-prepare-fixtures.sh" >/dev/null || \
  fail "failed to regenerate Cosmos fixture"
pass "regenerated fresh Cosmos fixture"

curl_capture -X POST "$BASE_URL/facilitator/verify" \
  -H "Content-Type: application/json" \
  -d @"$COSMOS_FIXTURE_FILE"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected HTTP 200, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi

is_valid=$(echo "$RESPONSE_BODY" | jq -r '.isValid')
if [[ "$is_valid" != "true" ]]; then
  reason=$(echo "$RESPONSE_BODY" | jq -r '.invalidReason // "no reason given"')
  fail "expected isValid=true, got isValid=$is_valid (reason: $reason). body: $RESPONSE_BODY"
fi
pass "facilitator/verify accepted the Cosmos signed payload"
echo "$RESPONSE_BODY" | jq -C '{isValid, payer}'
