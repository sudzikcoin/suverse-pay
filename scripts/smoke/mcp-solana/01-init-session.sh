#!/usr/bin/env bash
# 01-init-session.sh — MCP init_session with the funded Solana devnet
# mnemonic. Asserts the derived base58 address matches the known
# address in .env.solana-devnet (so we know we're paying out of the
# wallet the user funded).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "01-init-session" "MCP init_session for Solana devnet"

require_solana_devnet_env

args=$(jq -nc \
  --arg secret "$SOLANA_DEVNET_MNEMONIC" \
  --arg network "$SOLANA_DEVNET_CAIP2" \
  '{secret: $secret, networks: [$network]}')

resp=$(mcp_call init_session "$args")
sessionId=$(echo "$resp" | jq -r .sessionId)
derived=$(echo "$resp" | jq -r --arg n "$SOLANA_DEVNET_CAIP2" '.addresses[$n]')

if [[ -z "$sessionId" || "$sessionId" == "null" ]]; then
  fail "init_session did not return a sessionId. resp: $resp"
fi
if [[ "$derived" != "$SOLANA_DEVNET_ADDRESS" ]]; then
  fail "derived address $derived != expected $SOLANA_DEVNET_ADDRESS"
fi

echo "$sessionId" > "$SMOKE_SOL_SESSION_FILE"
pass "sessionId=$sessionId"
info "payer base58 address: $derived"
