#!/usr/bin/env bash
# 00-prepare-fixtures.sh — generate a fresh signed PaymentPayload + matching
# PaymentRequirements via the cosmos-pay `fixture` tool. Single-use on chain
# (each settle consumes the nonce), so this MUST run before 04/05/06.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "00-prepare-fixtures" "regenerate signed-settle-fresh.json"

if [[ ! -x "$FIXTURE_BINARY" ]]; then
  fail "fixture binary not found at $FIXTURE_BINARY. Build it: cd $COSMOS_PAY_REPO && go build -o bin/fixture ./tools/fixture"
fi
if [[ ! -f "$COSMOS_PAY_REPO/.env" ]]; then
  fail "$COSMOS_PAY_REPO/.env not found — the generator reads payer/facilitator mnemonics + network from it"
fi

info "loading cosmos-pay credentials from $COSMOS_PAY_REPO/.env"
# shellcheck disable=SC1091
( set -a; source "$COSMOS_PAY_REPO/.env"; set +a; "$FIXTURE_BINARY" --output "$FIXTURE_FILE" ) || fail "fixture generation failed"

if ! jq -e '.paymentPayload.payload.signature | length > 0' "$FIXTURE_FILE" >/dev/null; then
  fail "fixture missing signature — $FIXTURE_FILE looks malformed"
fi
nonce=$(jq -r '.paymentPayload.payload.authorization.nonce' "$FIXTURE_FILE")
validBefore=$(jq -r '.paymentPayload.payload.authorization.validBefore' "$FIXTURE_FILE")
now=$(date +%s)
remaining=$(( validBefore - now ))
pass "generated $FIXTURE_FILE (nonce=$nonce, ${remaining}s until expiry)"
