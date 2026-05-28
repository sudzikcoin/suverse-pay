#!/usr/bin/env bash
# 01-supported.sh — GET /facilitator/supported (no auth).
# Asserts JSON shape: { x402Version, kinds: [{network, scheme, asset?}, ...] }
# Lists at least cosmos:grand-1/exact_cosmos_authz so the cosmos-pay
# adapter is wired into the facilitator surface.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "01-supported" "GET /facilitator/supported — open access"

curl_capture "$BASE_URL/facilitator/supported"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected HTTP 200, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi

# /facilitator/supported is { kinds: [{x402Version, scheme, network}, ...],
# extensions: [], signers: {...} } — x402Version is embedded per-kind, not
# at top level (matches x402 v2 spec § 5.2 SupportedResponse shape).
kinds_count=$(echo "$RESPONSE_BODY" | jq -r '.kinds | length')
if [[ "$kinds_count" -lt 1 ]]; then
  fail "expected at least one kind, got $kinds_count. body: $RESPONSE_BODY"
fi
pass "kinds reported: $kinds_count"

first_version=$(echo "$RESPONSE_BODY" | jq -r '.kinds[0].x402Version')
if [[ "$first_version" != "2" ]]; then
  fail "expected kinds[].x402Version=2, got '$first_version'"
fi
pass "x402Version=2 on every kind"

has_cosmos=$(echo "$RESPONSE_BODY" | jq -r '
  [.kinds[] | select(.network=="cosmos:grand-1" and .scheme=="exact_cosmos_authz")] | length
')
if [[ "$has_cosmos" -lt 1 ]]; then
  fail "expected cosmos:grand-1/exact_cosmos_authz in kinds. body: $RESPONSE_BODY"
fi
pass "cosmos:grand-1/exact_cosmos_authz advertised"

echo "$RESPONSE_BODY" | jq -C '{kinds_count: (.kinds | length), kinds: (.kinds | map({network, scheme}))}'
