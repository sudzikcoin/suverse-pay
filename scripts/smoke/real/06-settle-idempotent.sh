#!/usr/bin/env bash
# 06-settle-idempotent.sh — replay /settle with the SAME Idempotency-Key
# as 05. CLAUDE.md §1 invariant: duplicate calls MUST return the same
# response without re-broadcasting. Verify by checking that:
#   - paymentId matches the original
#   - txHash matches the original
#   - /payments/:id reports exactly one attempt (no second adapter call)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "06-settle-idempotent" "replay /settle with same Idempotency-Key"

if [[ ! -f "$SMOKE_REAL_PAYMENT_ID_FILE" || ! -f "$SMOKE_REAL_IDEM_FILE" ]]; then
  fail "no prior payment recorded — run 05-settle.sh first"
fi
expected_id=$(cat "$SMOKE_REAL_PAYMENT_ID_FILE")
idem=$(cat "$SMOKE_REAL_IDEM_FILE")

expect_status 200 POST /settle \
  -H "Idempotency-Key: $idem" \
  -d @"$FIXTURE_FILE" || exit 1
echo "$RESPONSE_BODY" | jq -C '{paymentId, status, providerId, txHash}'

got_id=$(echo "$RESPONSE_BODY" | jq -r .paymentId)
got_tx=$(echo "$RESPONSE_BODY" | jq -r .txHash)

if [[ "$got_id" != "$expected_id" ]]; then
  fail "replay returned a DIFFERENT paymentId ($got_id vs $expected_id)"
fi
pass "same paymentId on replay ($got_id)"

# Independently confirm no second on-chain broadcast: /payments/:id must
# still show exactly one attempt.
expect_status 200 GET "/payments/$expected_id" || exit 1
n=$(echo "$RESPONSE_BODY" | jq '.attempts | length')
tx_in_db=$(echo "$RESPONSE_BODY" | jq -r '.txHash')

if (( n != 1 )); then
  fail "expected exactly 1 attempt on idempotent replay, got $n"
fi
if [[ "$got_tx" != "$tx_in_db" ]]; then
  fail "replay txHash $got_tx disagrees with DB row $tx_in_db"
fi
pass "1 attempt only — no duplicate on-chain broadcast"
