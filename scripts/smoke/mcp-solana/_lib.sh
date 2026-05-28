# Shared helpers for the mcp-solana real smoke suite. Source from each step.
# No `set` here — caller owns its options.

if [[ -t 1 ]]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[0;33m'
  BLUE=$'\033[0;34m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; RESET=""
fi

# Live infra (must already be running — this suite does NOT touch it).
: "${GATEWAY_URL:=http://localhost:3000}"
: "${PAYAI_URL:=https://facilitator.payai.network}"
: "${SOLANA_DEVNET_RPC:=https://api.devnet.solana.com}"

# Spawned by 00-setup.sh on dedicated loopback ports.
: "${MCP_PORT:=3298}"
: "${MOCK_PORT:=8291}"
: "${MCP_URL:=http://127.0.0.1:$MCP_PORT/mcp}"
: "${MOCK_URL:=http://127.0.0.1:$MOCK_PORT}"

# x402 v2 CAIP-2 form (canonical, what signer-solana / PayAI v2 accept).
: "${SOLANA_DEVNET_CAIP2:=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1}"
# USDC on Solana devnet (the Circle faucet at faucet.circle.com mints this).
: "${USDC_DEV_MINT:=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU}"
# PayAI's facilitator pubkey on Solana devnet (captured Phase 3 Sub-task 3).
: "${PAYAI_FEE_PAYER:=2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4}"

: "${SMOKE_SOL_TMP:=/tmp/suverse-pay-mcp-solana}"
: "${SMOKE_SOL_PIDS:=$SMOKE_SOL_TMP/pids}"
: "${SMOKE_SOL_MCP_LOG:=$SMOKE_SOL_TMP/mcp.log}"
: "${SMOKE_SOL_MOCK_LOG:=$SMOKE_SOL_TMP/mock.log}"
: "${SMOKE_SOL_SESSION_FILE:=$SMOKE_SOL_TMP/session-id}"
: "${SMOKE_SOL_TRANSPORT_FILE:=$SMOKE_SOL_TMP/mcp-transport-session}"
: "${SMOKE_SOL_PAYMENT_FILE:=$SMOKE_SOL_TMP/payment-id}"
: "${SMOKE_SOL_TX_FILE:=$SMOKE_SOL_TMP/tx-signature}"

SMOKE_SOL_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_SOL_ROOT="$(cd "$SMOKE_SOL_HERE/../../.." && pwd)"
SMOKE_SOL_SHARED="$(cd "$SMOKE_SOL_HERE/../mcp-shared" && pwd)"

: "${SOLANA_DEVNET_ENV:=$SMOKE_SOL_ROOT/.env.solana-devnet}"

mkdir -p "$SMOKE_SOL_TMP"

step_header() {
  local title="$1"; local subtitle="${2:-}"
  printf "\n%s━━━ %s ━━━%s\n" "$BOLD$BLUE" "$title" "$RESET"
  [[ -n "$subtitle" ]] && printf "%s%s%s\n" "$BLUE" "$subtitle" "$RESET"
}

pass() { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
fail() { printf "  %s✗%s %s\n" "$RED" "$RESET" "$1" >&2; return 1; }
info() { printf "  %s•%s %s\n" "$YELLOW" "$RESET" "$1"; }

mcp_init() {
  node "$SMOKE_SOL_SHARED/driver.mjs" init "$MCP_URL" "$SMOKE_SOL_TRANSPORT_FILE"
}

mcp_call() {
  local tool="$1"; local args="$2"
  node "$SMOKE_SOL_SHARED/driver.mjs" call "$MCP_URL" "$SMOKE_SOL_TRANSPORT_FILE" "$tool" "$args"
}

record_pid() { echo "$1" >> "$SMOKE_SOL_PIDS"; }

kill_recorded_pids() {
  [[ -f "$SMOKE_SOL_PIDS" ]] || return 0
  while IFS= read -r p; do
    [[ -n "$p" ]] && kill "$p" 2>/dev/null || true
  done < "$SMOKE_SOL_PIDS"
  rm -f "$SMOKE_SOL_PIDS"
}

require_solana_devnet_env() {
  if [[ ! -f "$SOLANA_DEVNET_ENV" ]]; then
    fail "$SOLANA_DEVNET_ENV not found — generate via signer-solana's derive helpers (see README)"
    return 1
  fi
  # shellcheck source=/dev/null
  source "$SOLANA_DEVNET_ENV"
  if [[ -z "${SOLANA_DEVNET_MNEMONIC:-}" || -z "${SOLANA_DEVNET_ADDRESS:-}" ]]; then
    fail "$SOLANA_DEVNET_ENV is missing SOLANA_DEVNET_MNEMONIC or SOLANA_DEVNET_ADDRESS"
    return 1
  fi
}

require_admin_key() {
  if [[ -z "${ADMIN_API_KEY:-}" && -f "$SMOKE_SOL_ROOT/.env" ]]; then
    set -a; source "$SMOKE_SOL_ROOT/.env"; set +a
  fi
  if [[ -z "${ADMIN_API_KEY:-}" ]]; then
    fail "ADMIN_API_KEY not set — source the suverse-pay .env first"
    return 1
  fi
}

# Query the Solana devnet RPC for the SPL token balance of an owner /
# mint pair. Echoes the raw atomic-units string to stdout, or empty if
# no token account exists.
solana_devnet_usdc_balance() {
  local owner="$1"
  local payload
  payload=$(jq -nc --arg owner "$owner" --arg mint "$USDC_DEV_MINT" '{
    jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
    params: [$owner, { mint: $mint }, { encoding: "jsonParsed" }]
  }')
  curl -sS --max-time 8 -X POST "$SOLANA_DEVNET_RPC" \
    -H 'Content-Type: application/json' -d "$payload" \
  | jq -r '.result.value[0].account.data.parsed.info.tokenAmount.amount // ""'
}

# Query devnet for SOL balance (lamports) of an address.
solana_devnet_sol_balance() {
  local owner="$1"
  local payload
  payload=$(jq -nc --arg owner "$owner" '{
    jsonrpc: "2.0", id: 1, method: "getBalance", params: [$owner]
  }')
  curl -sS --max-time 8 -X POST "$SOLANA_DEVNET_RPC" \
    -H 'Content-Type: application/json' -d "$payload" \
  | jq -r '.result.value // 0'
}
