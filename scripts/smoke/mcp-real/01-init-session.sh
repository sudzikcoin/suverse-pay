#!/usr/bin/env bash
# 01-init-session.sh — init_session with the funded testnet payer
# mnemonic from /home/govhub/x402-cosmos/.env. The payer must have a
# live x/authz SendAuthorization granted to the facilitator (24h
# window — use tools/grant in x402-cosmos to refresh).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "01-init-session" "MCP init_session with the funded testnet payer"

require_cosmos_env

args=$(jq -nc \
  --arg secret "$X402_PAYER_MNEMONIC" \
  '{secret: $secret, networks: ["cosmos:grand-1"]}')

resp=$(mcp_call init_session "$args")
# Don't echo $resp — it would include addresses, which are public, but
# better safe than sorry around anything passing through a logged shell.
sessionId=$(echo "$resp" | jq -r .sessionId)
addr=$(echo "$resp" | jq -r '.addresses."cosmos:grand-1"')

if [[ -z "$sessionId" || "$sessionId" == "null" ]]; then
  fail "init_session did not return a sessionId"
  exit 1
fi
if [[ ! "$addr" =~ ^noble1 ]]; then
  fail "expected noble1... address, got: $addr"
  exit 1
fi

echo "$sessionId" > "$SMOKE_MCP_REAL_SESSION_FILE"
pass "sessionId=$sessionId"
info "payer address: $addr"
info "grantee address: $X402_FACILITATOR_GRANTEE"
info "demo server:   $DEMO_URL/premium"
