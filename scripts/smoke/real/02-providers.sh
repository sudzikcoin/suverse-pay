#!/usr/bin/env bash
# 02-providers.sh — GET /providers must list cosmos-pay with
# health.status="healthy" because the facilitator is actually reachable.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "02-providers" "GET /providers — cosmos-pay must be healthy"

expect_status 200 GET /providers || exit 1
echo "$RESPONSE_BODY" | jq -C '.providers[] | {id, enabled, health: .health.status, capabilities: [.capabilities[] | {network, asset, scheme}]}'

cosmos_status=$(echo "$RESPONSE_BODY" | jq -r '.providers[] | select(.id == "cosmos-pay") | .health.status')
if [[ "$cosmos_status" != "healthy" ]]; then
  fail "cosmos-pay health.status=$cosmos_status, expected healthy"
fi
pass "cosmos-pay reported as healthy"
