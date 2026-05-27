#!/usr/bin/env bash
# 01-init-session.sh — call init_session with the canonical BIP-39 test
# mnemonic + cosmos:grand-1, persist the returned sessionId for
# subsequent steps.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "01-init-session" "MCP init_session with test mnemonic"

args=$(jq -nc \
  --arg secret "$SMOKE_TEST_MNEMONIC" \
  '{secret: $secret, networks: ["cosmos:grand-1"]}')

resp=$(mcp_call init_session "$args")
echo "$resp" | jq -C '.'

sessionId=$(echo "$resp" | jq -r .sessionId)
addr=$(echo "$resp" | jq -r '.addresses."cosmos:grand-1"')
if [[ -z "$sessionId" || "$sessionId" == "null" ]]; then
  fail "init_session did not return a sessionId"
  exit 1
fi
if [[ ! "$addr" =~ ^noble1 ]]; then
  fail "expected a noble1... address for cosmos:grand-1, got: $addr"
  exit 1
fi

echo "$sessionId" > "$SMOKE_MCP_SESSION_FILE"
pass "sessionId=$sessionId, cosmos address=$addr"
