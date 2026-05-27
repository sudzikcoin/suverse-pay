#!/usr/bin/env bash
# 04-get-quote.sh — MCP get_quote against the mocked gateway.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "04-get-quote" "MCP get_quote → mock gateway"

[[ -f "$SMOKE_MCP_SESSION_FILE" ]] || { fail "no session file"; exit 1; }
sessionId=$(cat "$SMOKE_MCP_SESSION_FILE")

args=$(jq -nc --arg sid "$sessionId" '{
  sessionId: $sid,
  asset: "uusdc",
  amount: "10000",
  scheme: "exact_cosmos_authz",
  preferredNetworks: ["cosmos:grand-1"],
  optimize: "cost"
}')
resp=$(mcp_call get_quote "$args")
echo "$resp" | jq -C '.'

count=$(echo "$resp" | jq '.quotes | length')
recommendedProvider=$(echo "$resp" | jq -r '.recommended.providerId // ""')
if [[ "$count" -lt 1 ]]; then
  fail "expected at least one quote, got $count"
  exit 1
fi
if [[ "$recommendedProvider" != "cosmos-pay" ]]; then
  fail "expected recommended providerId=cosmos-pay, got $recommendedProvider"
  exit 1
fi

pass "get_quote: $count quote(s); recommended=$recommendedProvider"
