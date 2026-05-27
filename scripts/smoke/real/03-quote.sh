#!/usr/bin/env bash
# 03-quote.sh — POST /quote against the real cosmos-pay provider on
# cosmos:grand-1. Quote is synthetic (cosmos-pay has no quote endpoint;
# the adapter computes it from supports() + recent health).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "03-quote" "POST /quote — cosmos:grand-1 / uusdc / exact_cosmos_authz"

read -r -d '' body <<'JSON' || true
{
  "asset": "uusdc",
  "amount": "10000",
  "preferredNetworks": ["cosmos:grand-1"],
  "scheme": "exact_cosmos_authz",
  "policy": { "optimize": "cost" }
}
JSON

expect_status 200 POST /quote -d "$body" || exit 1
echo "$RESPONSE_BODY" | jq -C '{recommended, quotes: [.quotes[] | {providerId, network, scheme, estimatedFeeUsd, source}]}'

n=$(echo "$RESPONSE_BODY" | jq '.quotes | length')
if (( n < 1 )); then
  fail "no quotes returned"
fi
rec_provider=$(echo "$RESPONSE_BODY" | jq -r '.recommended.providerId')
if [[ "$rec_provider" != "cosmos-pay" ]]; then
  fail "recommended provider expected cosmos-pay, got $rec_provider"
fi
pass "$n quote(s), recommended=cosmos-pay"
