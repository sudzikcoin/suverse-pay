#!/usr/bin/env bash
# 05-settle-cosmos.sh — POST /facilitator/settle with the Phase 1
# Cosmos fixture. Uses the resource API key from 00-setup. The
# /facilitator/settle endpoint routes through the SAME cosmos-pay
# adapter as the legacy /settle, so this broadcasts a REAL on-chain
# transfer on Noble testnet grand-1. Asserts:
#   - HTTP 200
#   - success: true
#   - non-empty transaction (Noble txHash)
#   - network matches the requirements
#
# Single-use fixture (nonce gets consumed); 09-idempotency replays
# this same fixture and proves the second call returns the same row
# without minting another tx.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "05-settle-cosmos" "POST /facilitator/settle — real Cosmos broadcast"

require_resource_key

# Regenerate a fresh single-use Cosmos fixture so this step + 09 share
# the same (just-minted) nonce. Without this, 05 would consume yesterday's
# nonce and 09 would have nothing to replay.
bash "$SMOKE_FAC_ROOT/scripts/smoke/real/00-prepare-fixtures.sh" || \
  fail "failed to regenerate Cosmos fixture"

# Stash the fixture for 09-idempotency to replay.
cp "$COSMOS_FIXTURE_FILE" "$SMOKE_FAC_TMP/settle-fixture.json"

curl_capture -X POST "$BASE_URL/facilitator/settle" \
  -H "Authorization: Bearer $RESOURCE_KEY" \
  -H "Content-Type: application/json" \
  -d @"$COSMOS_FIXTURE_FILE"

if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected HTTP 200, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi

success=$(echo "$RESPONSE_BODY" | jq -r '.success')
tx=$(echo "$RESPONSE_BODY" | jq -r '.transaction')
network=$(echo "$RESPONSE_BODY" | jq -r '.network')

if [[ "$success" != "true" ]]; then
  reason=$(echo "$RESPONSE_BODY" | jq -r '.errorReason // "no reason"')
  fail "expected success=true, got success=$success (reason: $reason). body: $RESPONSE_BODY"
fi
if [[ -z "$tx" || "$tx" == "null" ]]; then
  fail "expected non-empty transaction, got '$tx'"
fi
if [[ "$network" != "cosmos:grand-1" ]]; then
  fail "expected network=cosmos:grand-1, got $network"
fi

# Stash for the rest of the suite + final report.
echo "$tx" > "$SMOKE_FAC_TMP/last-tx-hash"
echo "$RESPONSE_BODY" > "$SMOKE_FAC_TMP/last-settle-response.json"

pass "facilitator/settle broadcast tx on Noble testnet"
info "tx hash:  $tx"
info "explorer: https://www.mintscan.io/noble-testnet/txs/$tx"
echo "$RESPONSE_BODY" | jq -C
