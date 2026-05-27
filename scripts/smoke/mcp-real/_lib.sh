# Shared helpers for the MCP real-network smoke suite. Source from each step.
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

# These run against the LIVE infrastructure (cosmos-pay :8402,
# suverse-pay :3000). The suite DOES NOT start or stop those services
# — they must already be running.
: "${COSMOS_PAY_URL:=http://localhost:8402}"
: "${GATEWAY_URL:=http://localhost:3000}"

# MCP server is spawned by 00-setup.sh on a dedicated loopback port.
# Demo x402 resource server (from /home/govhub/x402-cosmos/examples/server)
# is also spawned on its own port.
: "${MCP_PORT:=3299}"
: "${DEMO_PORT:=8290}"
: "${MCP_URL:=http://127.0.0.1:$MCP_PORT/mcp}"
: "${DEMO_URL:=http://127.0.0.1:$DEMO_PORT}"

: "${SMOKE_MCP_REAL_TMP:=/tmp/suverse-pay-mcp-real}"
: "${SMOKE_MCP_REAL_PIDS:=$SMOKE_MCP_REAL_TMP/pids}"
: "${SMOKE_MCP_REAL_LOG:=$SMOKE_MCP_REAL_TMP/mcp.log}"
: "${SMOKE_DEMO_LOG:=$SMOKE_MCP_REAL_TMP/demo.log}"
: "${SMOKE_MCP_REAL_SESSION_FILE:=$SMOKE_MCP_REAL_TMP/session-id}"
: "${SMOKE_MCP_REAL_TRANSPORT_FILE:=$SMOKE_MCP_REAL_TMP/mcp-transport-session}"
: "${SMOKE_MCP_REAL_PAYMENT_FILE:=$SMOKE_MCP_REAL_TMP/payment-id}"

SMOKE_MCP_REAL_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_MCP_REAL_ROOT="$(cd "$SMOKE_MCP_REAL_HERE/../../.." && pwd)"
SMOKE_MCP_REAL_SHARED="$(cd "$SMOKE_MCP_REAL_HERE/../mcp-shared" && pwd)"

# x402-cosmos repo for the demo server + env (payer mnemonic, grantee, etc).
: "${COSMOS_PAY_REPO:=/home/govhub/x402-cosmos}"
: "${COSMOS_PAY_ENV:=$COSMOS_PAY_REPO/.env}"
: "${DEMO_BINARY:=/tmp/x402-demo-server}"

mkdir -p "$SMOKE_MCP_REAL_TMP"

step_header() {
  local title="$1"; local subtitle="${2:-}"
  printf "\n%s━━━ %s ━━━%s\n" "$BOLD$BLUE" "$title" "$RESET"
  [[ -n "$subtitle" ]] && printf "%s%s%s\n" "$BLUE" "$subtitle" "$RESET"
}

pass() { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
fail() { printf "  %s✗%s %s\n" "$RED" "$RESET" "$1" >&2; return 1; }
info() { printf "  %s•%s %s\n" "$YELLOW" "$RESET" "$1"; }

mcp_init() {
  node "$SMOKE_MCP_REAL_SHARED/driver.mjs" init "$MCP_URL" "$SMOKE_MCP_REAL_TRANSPORT_FILE"
}

mcp_call() {
  local tool="$1"; local args="$2"
  node "$SMOKE_MCP_REAL_SHARED/driver.mjs" call "$MCP_URL" "$SMOKE_MCP_REAL_TRANSPORT_FILE" "$tool" "$args"
}

record_pid() { echo "$1" >> "$SMOKE_MCP_REAL_PIDS"; }

kill_recorded_pids() {
  [[ -f "$SMOKE_MCP_REAL_PIDS" ]] || return 0
  while IFS= read -r p; do
    [[ -n "$p" ]] && kill "$p" 2>/dev/null || true
  done < "$SMOKE_MCP_REAL_PIDS"
  rm -f "$SMOKE_MCP_REAL_PIDS"
}

# Load x402-cosmos env (payer mnemonic, grantee, payTo, etc.) — required
# for the demo server and for init_session. The .env uses bash `export`
# statements so we can source it directly.
require_cosmos_env() {
  if [[ ! -f "$COSMOS_PAY_ENV" ]]; then
    fail "$COSMOS_PAY_ENV not found — Cosmos config required for real smoke"
    return 1
  fi
  # shellcheck source=/dev/null
  source "$COSMOS_PAY_ENV"
  for v in X402_PAYER_MNEMONIC X402_FACILITATOR_GRANTEE X402_PAY_TO X402_NETWORK X402_ASSET X402_AMOUNT; do
    if [[ -z "${!v:-}" ]]; then
      fail "$v not set after sourcing $COSMOS_PAY_ENV"
      return 1
    fi
  done
}

# Suverse-pay gateway admin key — used by the MCP server to authenticate
# to the gateway. NOT exposed to the MCP client; lives only in MCP's env.
require_admin_key() {
  if [[ -z "${ADMIN_API_KEY:-}" ]]; then
    # Fall back to the project .env, same way scripts/smoke/real does.
    if [[ -f "$SMOKE_MCP_REAL_ROOT/.env" ]]; then
      # shellcheck source=/dev/null
      set -a
      source "$SMOKE_MCP_REAL_ROOT/.env"
      set +a
    fi
  fi
  if [[ -z "${ADMIN_API_KEY:-}" ]]; then
    fail "ADMIN_API_KEY not set — source the suverse-pay .env first"
    return 1
  fi
}
