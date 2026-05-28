#!/usr/bin/env bash
# 03-verify.sh — sign a fresh EIP-3009 payload and POST it to /verify.
# Asserts the gateway routes the request to coinbase-cdp and CDP
# returns isValid=true. Verify does NOT broadcast and does NOT consume
# the nonce — the signed fixture is throwaway (separate from the
# 04-settle fixture which carries its own fresh nonce).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "03-verify" "POST /verify — CDP must accept the EIP-3009 signature"

require_admin_key

verify_fixture="$SMOKE_REVM_TMP/fixtures/verify.json"
nonce=$(sign_payload "$verify_fixture" | tail -n1)
info "signed payload nonce: $nonce"

curl_admin POST /verify -d @"$verify_fixture"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected 200, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi
echo "$RESPONSE_BODY" | jq -C '{valid, providerId, payer, invalidReason}'

valid=$(echo "$RESPONSE_BODY" | jq -r '.valid')
provider=$(echo "$RESPONSE_BODY" | jq -r '.providerId // ""')
if [[ "$valid" != "true" ]]; then
  reason=$(echo "$RESPONSE_BODY" | jq -r '.invalidReason // ""')
  fail "verify rejected the signature: valid=$valid reason=$reason"
fi
if [[ "$provider" != "coinbase-cdp" ]]; then
  fail "expected providerId=coinbase-cdp, got '$provider'"
fi
pass "CDP accepted the EIP-3009 signature (valid=true)"
