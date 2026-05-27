#!/usr/bin/env bash
# 04-verify.sh — POST /verify with the signed fixture. Verify must return
# isValid=true without broadcasting anything. The signed payload's nonce
# is NOT consumed by /verify, so 05-settle can still use the same fixture.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "04-verify" "POST /verify — fixture must pass signature + grant checks"

if [[ ! -f "$FIXTURE_FILE" ]]; then
  fail "$FIXTURE_FILE missing — run 00-prepare-fixtures.sh"
fi

expect_status 200 POST /verify -d @"$FIXTURE_FILE" || exit 1
echo "$RESPONSE_BODY" | jq -C '{valid, providerId, payer, invalidReason}'

valid=$(echo "$RESPONSE_BODY" | jq -r .valid)
if [[ "$valid" != "true" ]]; then
  reason=$(echo "$RESPONSE_BODY" | jq -r .invalidReason)
  fail "verify returned valid=$valid (reason=$reason)"
fi
pass "verify accepted — signature + grant + window all pass"
