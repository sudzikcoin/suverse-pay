#!/usr/bin/env bash
# 03-discover-endpoints.sh — MCP discover_endpoints. Hits the REAL
# Coinbase Bazaar (no auth, public catalog). Since we cache real
# Bazaar responses in the packages/discovery integration test, this is
# a separate live call — assert structure rather than specific rows.
#
# If Bazaar is unreachable, the discovery aggregator returns [] without
# throwing. The test passes either way provided the shape is correct;
# we just print a note when zero endpoints come back.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "03-discover-endpoints" "MCP discover_endpoints — live Bazaar"

[[ -f "$SMOKE_MCP_SESSION_FILE" ]] || { fail "no session file"; exit 1; }
sessionId=$(cat "$SMOKE_MCP_SESSION_FILE")

args=$(jq -nc --arg sid "$sessionId" '{sessionId: $sid, limit: 5}')
resp=$(mcp_call discover_endpoints "$args")
echo "$resp" | jq -C '{count: (.endpoints | length), sample: (.endpoints | .[0:2])}'

count=$(echo "$resp" | jq '.endpoints | length')
if ! echo "$resp" | jq -e '.endpoints | type == "array"' >/dev/null; then
  fail "discover_endpoints did not return an endpoints array"
  exit 1
fi

if [[ "$count" -eq 0 ]]; then
  info "zero endpoints — Bazaar reachable but empty (or unreachable; aggregator returned [])"
else
  # Validate the first endpoint's required fields.
  first=$(echo "$resp" | jq '.endpoints[0]')
  for field in resource network asset scheme amount payTo sourceId discoveredAt; do
    val=$(echo "$first" | jq -r ".$field // \"\"")
    if [[ -z "$val" ]]; then
      fail "first endpoint missing required field: $field"
      exit 1
    fi
  done
fi

pass "discover_endpoints returned $count endpoint(s) with the expected shape"
