#!/usr/bin/env bash
# 09-idempotency.sh — replay 05's settle (same payload, same resource
# key, same hour-bucket → same derived idempotency key). Asserts:
#   - HTTP 200
#   - success: true
#   - SAME transaction hash as 05 (no second on-chain tx)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "09-idempotency" "replay 05-settle — must return same tx, no second broadcast"

require_resource_key
if [[ ! -f "$SMOKE_FAC_TMP/settle-fixture.json" ]]; then
  fail "$SMOKE_FAC_TMP/settle-fixture.json missing — 05-settle-cosmos must run first"
fi
if [[ ! -f "$SMOKE_FAC_TMP/last-tx-hash" ]]; then
  fail "$SMOKE_FAC_TMP/last-tx-hash missing — 05-settle-cosmos must run first"
fi
first_tx=$(cat "$SMOKE_FAC_TMP/last-tx-hash")

curl_capture -X POST "$BASE_URL/facilitator/settle" \
  -H "Authorization: Bearer $RESOURCE_KEY" \
  -H "Content-Type: application/json" \
  -d @"$SMOKE_FAC_TMP/settle-fixture.json"

if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected HTTP 200 on replay, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi
success=$(echo "$RESPONSE_BODY" | jq -r '.success')
replay_tx=$(echo "$RESPONSE_BODY" | jq -r '.transaction')

if [[ "$success" != "true" ]]; then
  fail "expected success=true on replay, got $success. body: $RESPONSE_BODY"
fi
if [[ "$replay_tx" != "$first_tx" ]]; then
  fail "expected same tx as 05 ($first_tx), got $replay_tx. body: $RESPONSE_BODY"
fi
pass "idempotency honored: same transaction returned, no second broadcast"
info "first  tx: $first_tx"
info "replay tx: $replay_tx"
