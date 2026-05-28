#!/usr/bin/env bash
# 00-setup.sh — verify everything the suite needs, then spawn the mock
# x402 server and the MCP server. STOPS with a clear prompt if:
#   - suverse-pay :3000 not reachable
#   - PayAI facilitator unreachable
#   - .env.solana-devnet missing or malformed
#   - Solana devnet wallet has no USDC-Dev balance
#   - Solana devnet wallet has too little SOL-Dev for ATA rent
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "00-setup" "verify live infra + wallet, spawn mock x402 + MCP"

require_admin_key
require_solana_devnet_env

# 1. Suverse-pay (we don't call /facilitator/settle in this suite, but
#    the MCP server points at the gateway for /providers / /quote.)
if ! curl -sf --max-time 3 "$GATEWAY_URL/health" >/dev/null; then
  fail "suverse-pay not reachable at $GATEWAY_URL — start the API server first"
fi
pass "suverse-pay reachable at $GATEWAY_URL"

# 2. PayAI must be reachable AND must advertise our canonical devnet kind.
payai_resp=$(curl -sS --max-time 8 "$PAYAI_URL/supported")
if ! echo "$payai_resp" | jq -e --arg n "$SOLANA_DEVNET_CAIP2" \
     '.kinds[]? | select(.network == $n and .scheme == "exact")' >/dev/null; then
  fail "PayAI /supported did not advertise (network=$SOLANA_DEVNET_CAIP2, scheme=exact). Response: $payai_resp"
fi
pass "PayAI advertises $SOLANA_DEVNET_CAIP2 / exact"

# 3. Solana devnet RPC reachable.
if ! curl -sf --max-time 5 -X POST "$SOLANA_DEVNET_RPC" \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' >/dev/null; then
  fail "Solana devnet RPC not reachable at $SOLANA_DEVNET_RPC"
fi
pass "Solana devnet RPC reachable at $SOLANA_DEVNET_RPC"

# 4. Wallet funding check — STOP with explicit instructions if dry.
usdc_balance=$(solana_devnet_usdc_balance "$SOLANA_DEVNET_ADDRESS")
sol_balance=$(solana_devnet_sol_balance "$SOLANA_DEVNET_ADDRESS")
info "wallet address: $SOLANA_DEVNET_ADDRESS"
info "USDC-Dev balance: ${usdc_balance:-0} atomic units (${USDC_DEV_MINT})"
info "SOL-Dev balance:  ${sol_balance:-0} lamports"

if [[ -z "$usdc_balance" || "$usdc_balance" == "0" || "$usdc_balance" == "null" ]]; then
  cat >&2 <<EOM
${RED}wallet has no USDC-Dev — fund it before re-running this suite${RESET}

  1. Visit ${BOLD}https://faucet.circle.com${RESET}
  2. Select network: Solana → Devnet
  3. Paste address: ${BOLD}$SOLANA_DEVNET_ADDRESS${RESET}
  4. Request at least 1 USDC-Dev
  5. Also ensure SOL-Dev > 0.01 SOL for SPL account rent — use:
       ${BOLD}https://faucet.solana.com${RESET}  (paste the same address)

Then re-run: bash scripts/smoke/mcp-solana/run-all.sh
EOM
  exit 1
fi

# SOL-Dev rent floor: ~0.002 SOL per ATA. Require >= 0.005 SOL = 5,000,000 lamports.
if [[ -z "$sol_balance" || "$sol_balance" -lt 5000000 ]]; then
  cat >&2 <<EOM
${RED}wallet has too little SOL-Dev (need >= 5,000,000 lamports, have ${sol_balance:-0})${RESET}

  Visit ${BOLD}https://faucet.solana.com${RESET} or run \`solana airdrop\`
  for address: ${BOLD}$SOLANA_DEVNET_ADDRESS${RESET}
EOM
  exit 1
fi
pass "wallet funded (USDC-Dev=$usdc_balance, SOL-Dev=${sol_balance} lamports)"

# 5. Clean per-run state.
[[ -f "$SMOKE_SOL_PIDS" ]] && kill_recorded_pids
rm -f "$SMOKE_SOL_SESSION_FILE" "$SMOKE_SOL_PAYMENT_FILE" \
      "$SMOKE_SOL_TX_FILE" "$SMOKE_SOL_TRANSPORT_FILE"
: > "$SMOKE_SOL_MCP_LOG"
: > "$SMOKE_SOL_MOCK_LOG"

# 6. Spawn mock x402 devnet server.
info "spawn mock x402 devnet on :$MOCK_PORT"
(
  cd "$SMOKE_SOL_ROOT"
  MOCK_PORT="$MOCK_PORT" \
  X402_NETWORK="$SOLANA_DEVNET_CAIP2" \
  X402_SCHEME="exact" \
  X402_ASSET="$USDC_DEV_MINT" \
  X402_PAY_TO="$SOLANA_DEVNET_ADDRESS" \
  X402_FEE_PAYER="$PAYAI_FEE_PAYER" \
  X402_AMOUNT="100" \
  PAYAI_URL="$PAYAI_URL" \
  node "$SMOKE_SOL_HERE/mock-x402-devnet/index.mjs" >"$SMOKE_SOL_MOCK_LOG" 2>&1 &
  echo $! >> "$SMOKE_SOL_PIDS"
)
for _ in $(seq 1 30); do
  if curl -sf --max-time 1 "$MOCK_URL/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.3
done
curl -sf --max-time 1 "$MOCK_URL/healthz" >/dev/null \
  || { fail "mock x402 server did not bind"; tail -20 "$SMOKE_SOL_MOCK_LOG" >&2; exit 1; }
pass "mock x402 server listening on $MOCK_URL (self-transfer to $SOLANA_DEVNET_ADDRESS)"

# 7. Spawn MCP server pointed at the real gateway.
info "spawn MCP server on :$MCP_PORT"
(
  cd "$SMOKE_SOL_ROOT"
  MCP_PORT="$MCP_PORT" \
  MCP_HOST="127.0.0.1" \
  SUVERSE_PAY_GATEWAY_URL="$GATEWAY_URL" \
  SUVERSE_PAY_ADMIN_KEY="$ADMIN_API_KEY" \
  SUVERSE_PAY_SOLANA_RPC_URL_DEVNET="$SOLANA_DEVNET_RPC" \
  MCP_SESSION_TIMEOUT_MINUTES="30" \
  LOG_LEVEL="warn" \
  pnpm --filter @suverse-pay/mcp run start >"$SMOKE_SOL_MCP_LOG" 2>&1 &
  echo $! >> "$SMOKE_SOL_PIDS"
)
for _ in $(seq 1 60); do
  ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${MCP_PORT}$" && break
  sleep 0.5
done
ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${MCP_PORT}$" \
  || { fail "MCP did not bind"; tail -30 "$SMOKE_SOL_MCP_LOG" >&2; exit 1; }
pass "MCP listening on :$MCP_PORT"

# 8. MCP transport handshake.
sid=$(mcp_init)
[[ -n "$sid" ]] || { fail "MCP transport handshake failed"; exit 1; }
pass "MCP transport session: $sid"
