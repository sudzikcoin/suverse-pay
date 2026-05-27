#!/usr/bin/env bash
# 02-list-providers.sh — MCP list_providers via the mocked gateway.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "02-list-providers" "MCP list_providers → mock gateway"

[[ -f "$SMOKE_MCP_SESSION_FILE" ]] || { fail "no session file — run 01-init-session.sh first"; exit 1; }
sessionId=$(cat "$SMOKE_MCP_SESSION_FILE")

args=$(jq -nc --arg sid "$sessionId" '{sessionId: $sid}')
resp=$(mcp_call list_providers "$args")
echo "$resp" | jq -C '.'

count=$(echo "$resp" | jq '.providers | length')
firstId=$(echo "$resp" | jq -r '.providers[0].id')
if [[ "$count" -lt 1 ]]; then
  fail "expected at least one provider, got $count"
  exit 1
fi
if [[ "$firstId" != "cosmos-pay" ]]; then
  fail "expected first provider id=cosmos-pay, got $firstId"
  exit 1
fi

pass "list_providers returned $count provider(s); first=$firstId"
