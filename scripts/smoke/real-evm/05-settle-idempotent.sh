#!/usr/bin/env bash
# 05-settle-idempotent.sh — replay 04-settle with the SAME Idempotency-
# Key AND the SAME signed fixture (so the same nonce). CLAUDE.md
# invariant 1: duplicate calls MUST return the same response without
# re-broadcasting. Verify by checking that:
#   - paymentId matches the original
#   - txHash matches the original
#   - /payments/:id reports exactly one attempt (no second on-chain tx)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "05-settle-idempotent" "replay /settle with same Idempotency-Key + nonce"

require_admin_key

if [[ ! -f "$SMOKE_REVM_PAYMENT_ID_FILE" || ! -f "$SMOKE_REVM_IDEM_FILE" || \
      ! -f "$SMOKE_REVM_FIXTURE_INTERNAL" || ! -f "$SMOKE_REVM_TX_FILE" ]]; then
  fail "missing 04-settle outputs in $SMOKE_REVM_TMP — run 04-settle.sh first"
fi
expected_id=$(cat "$SMOKE_REVM_PAYMENT_ID_FILE")
expected_tx=$(cat "$SMOKE_REVM_TX_FILE")
idem=$(cat "$SMOKE_REVM_IDEM_FILE")

curl_admin POST /settle \
  -H "Idempotency-Key: $idem" \
  -d @"$SMOKE_REVM_FIXTURE_INTERNAL"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected 200 on replay, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi
echo "$RESPONSE_BODY" | jq -C '{paymentId, status, providerId, txHash}'

got_id=$(echo "$RESPONSE_BODY" | jq -r '.paymentId')
got_tx=$(echo "$RESPONSE_BODY" | jq -r '.txHash')

if [[ "$got_id" != "$expected_id" ]]; then
  fail "replay returned a different paymentId ($got_id vs $expected_id)"
fi
if [[ "$got_tx" != "$expected_tx" ]]; then
  fail "replay returned a different txHash ($got_tx vs $expected_tx) — second on-chain broadcast?!"
fi
pass "same paymentId + txHash on replay ($got_id, $got_tx)"

# Independently confirm via /payments/:id that the DB shows exactly one
# attempt. If CDP had been called twice we'd see two attempt rows.
curl_admin GET "/payments/$expected_id"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected 200 from /payments/$expected_id, got $RESPONSE_STATUS"
fi
n=$(echo "$RESPONSE_BODY" | jq '.attempts | length')
tx_in_db=$(echo "$RESPONSE_BODY" | jq -r '.txHash')
if (( n != 1 )); then
  fail "expected exactly 1 attempt on idempotent replay, got $n"
fi
if [[ "$tx_in_db" != "$expected_tx" ]]; then
  fail "/payments/:id txHash $tx_in_db disagrees with 04-settle's $expected_tx"
fi
pass "1 attempt only — no duplicate on-chain broadcast"
