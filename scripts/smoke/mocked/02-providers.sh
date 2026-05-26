#!/usr/bin/env bash
# 02-providers.sh — TASK.md acceptance scenario #2
# GET /providers → both providers listed with their static capabilities.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "02-providers" "GET /providers (expect cosmos-pay + coinbase-cdp)"

expect_status 200 GET /providers || exit 1
echo "$RESPONSE_BODY" | jq -C '.providers[] | {id, displayName, caps: (.capabilities | length)}'

ids=$(echo "$RESPONSE_BODY" | jq -r '.providers[].id' | sort | paste -sd, -)
if [[ "$ids" != "coinbase-cdp,cosmos-pay" ]]; then
  fail "unexpected providers list: $ids"
fi

cosmos_caps=$(echo "$RESPONSE_BODY" | jq '[.providers[] | select(.id=="cosmos-pay") | .capabilities[] | select(.scheme=="exact_cosmos_authz")] | length')
if [[ "$cosmos_caps" == "0" ]]; then
  fail "cosmos-pay missing exact_cosmos_authz capability"
fi
cdp_caps=$(echo "$RESPONSE_BODY" | jq '[.providers[] | select(.id=="coinbase-cdp") | .capabilities[] | select(.network=="eip155:8453")] | length')
if [[ "$cdp_caps" == "0" ]]; then
  fail "coinbase-cdp missing eip155:8453 capability"
fi
pass "both providers + their static capabilities present"
