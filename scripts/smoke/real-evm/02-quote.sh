#!/usr/bin/env bash
# 02-quote.sh — POST /quote for Base Sepolia USDC. Synthetic-quote path
# (CDP exposes no /quote endpoint, so the adapter computes it from its
# static capabilities + estimatedFeeUsd metadata). Asserts:
#   - HTTP 200
#   - quotes array non-empty
#   - at least one quote.providerId == "coinbase-cdp"
#   - source == "synthetic" (the CDP path has no native quote)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "02-quote" "POST /quote — synthetic CDP quote for Base Sepolia USDC"

require_admin_key

body=$(cat <<EOF
{
  "preferredNetworks": ["$SMOKE_REVM_NETWORK"],
  "asset": "$SMOKE_REVM_USDC",
  "amount": "$SMOKE_REVM_AMOUNT_ATOMIC",
  "scheme": "exact"
}
EOF
)

curl_admin POST /quote -d "$body"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected 200, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi

n=$(echo "$RESPONSE_BODY" | jq '.quotes | length')
if (( n == 0 )); then
  fail "expected at least one quote, got 0. body: $RESPONSE_BODY"
fi

cdp_quote=$(echo "$RESPONSE_BODY" | jq -c '.quotes[] | select(.providerId=="coinbase-cdp")')
if [[ -z "$cdp_quote" ]]; then
  fail "no coinbase-cdp quote in response. body: $RESPONSE_BODY"
fi

source=$(echo "$cdp_quote" | jq -r '.source')
if [[ "$source" != "synthetic" ]]; then
  fail "expected source=synthetic for CDP, got $source"
fi

pass "/quote returned $n quote(s) including coinbase-cdp (source=synthetic)"
echo "$cdp_quote" | jq -C '{providerId, source, estimatedFeeUsd, estimatedLatencyMs}'
