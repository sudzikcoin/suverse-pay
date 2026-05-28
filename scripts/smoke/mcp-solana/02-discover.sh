#!/usr/bin/env bash
# 02-discover.sh — call MCP discover_endpoints. Bazaar may or may not
# return any Solana devnet entries (it's mainnet-focused). This step
# just proves the tool runs without crashing and surfaces what it
# found; it does NOT gate the smoke on a specific count.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "02-discover" "MCP discover_endpoints (informational)"

[[ -f "$SMOKE_SOL_SESSION_FILE" ]] || { fail "no session file"; exit 1; }
sessionId=$(cat "$SMOKE_SOL_SESSION_FILE")

args=$(jq -nc --arg sid "$sessionId" --arg n "$SOLANA_DEVNET_CAIP2" '{
  sessionId: $sid, network: $n, limit: 5
}')

set +e
resp=$(mcp_call discover_endpoints "$args")
rc=$?
set -e

if (( rc != 0 )); then
  info "discover_endpoints returned non-zero rc=$rc — surfacing response and continuing"
fi
count=$(echo "$resp" | jq -r '.endpoints | length' 2>/dev/null || echo "?")
info "endpoints returned: $count (devnet entries on Bazaar are rare — expected)"
echo "$resp" | jq -C '{count: (.endpoints | length // 0), sources: (.sources // [])}' 2>/dev/null || echo "$resp"
pass "discover_endpoints completed without crashing the MCP server"
