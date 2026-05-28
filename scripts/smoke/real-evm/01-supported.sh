#!/usr/bin/env bash
# 01-supported.sh — assert that BOTH surfaces advertise Base Sepolia:
#   - GET /providers (internal admin) lists coinbase-cdp with eip155:84532
#   - GET /facilitator/supported (public x402 spec §7.3) lists eip155:84532
#
# If either is missing the rest of the suite would fail with confusing
# 400 route_unsupported errors. Catch it here with a clear message.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "01-supported" "/providers + /facilitator/supported must advertise eip155:84532"

require_admin_key

# ---- Internal admin surface --------------------------------------------
providers_body=$(curl -s "$BASE_URL/providers" -H "Authorization: Bearer $ADMIN_API_KEY")
cdp_cap=$(echo "$providers_body" | jq -c '.providers[] | select(.id=="coinbase-cdp") | .capabilities[] | select(.network=="eip155:84532")')
if [[ -z "$cdp_cap" ]]; then
  fail "GET /providers: coinbase-cdp has no eip155:84532 capability. body: $providers_body"
fi
asset=$(echo "$cdp_cap" | jq -r '.asset')
if [[ "${asset,,}" != "${SMOKE_REVM_USDC,,}" ]]; then
  fail "expected asset=$SMOKE_REVM_USDC, got $asset"
fi
pass "/providers: coinbase-cdp advertises Base Sepolia USDC ($asset)"

# ---- Public facilitator surface ----------------------------------------
fac_body=$(curl -s "$BASE_URL/facilitator/supported")
fac_kind=$(echo "$fac_body" | jq -c '.kinds[] | select(.network=="eip155:84532" and .scheme=="exact")')
if [[ -z "$fac_kind" ]]; then
  fail "GET /facilitator/supported: no eip155:84532 exact kind. body: $fac_body"
fi
pass "/facilitator/supported: lists eip155:84532 + scheme=exact"
echo "$fac_kind" | jq -C
