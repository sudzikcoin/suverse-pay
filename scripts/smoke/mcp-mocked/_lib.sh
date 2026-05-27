# Shared helpers for the MCP-mocked smoke suite. Source from each step.
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

# Defaults — override via env vars before invocation.
: "${MCP_PORT:=3199}"
: "${MOCK_X402_PORT:=3198}"
: "${MOCK_GW_PORT:=3197}"
: "${MCP_URL:=http://127.0.0.1:$MCP_PORT/mcp}"
: "${MOCK_X402_URL:=http://127.0.0.1:$MOCK_X402_PORT}"
: "${MOCK_GW_URL:=http://127.0.0.1:$MOCK_GW_PORT}"
: "${SMOKE_MCP_TMP:=/tmp/suverse-pay-mcp-mocked}"
: "${SMOKE_MCP_PIDS_FILE:=$SMOKE_MCP_TMP/pids}"
: "${SMOKE_MCP_LOG:=$SMOKE_MCP_TMP/mcp.log}"
: "${SMOKE_MOCK_LOG:=$SMOKE_MCP_TMP/mocks.log}"
: "${SMOKE_MCP_SESSION_FILE:=$SMOKE_MCP_TMP/session-id}"
: "${SMOKE_MCP_TRANSPORT_FILE:=$SMOKE_MCP_TMP/mcp-transport-session}"
: "${SMOKE_MCP_PAYMENT_FILE:=$SMOKE_MCP_TMP/payment-id}"
# Canonical BIP-39 test mnemonic (publicly known, never used for real funds).
: "${SMOKE_TEST_MNEMONIC:=abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about}"

SMOKE_MCP_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_MCP_ROOT="$(cd "$SMOKE_MCP_HERE/../../.." && pwd)"
SMOKE_MCP_SHARED="$(cd "$SMOKE_MCP_HERE/../mcp-shared" && pwd)"

mkdir -p "$SMOKE_MCP_TMP"

step_header() {
  local title="$1"; local subtitle="${2:-}"
  printf "\n%s━━━ %s ━━━%s\n" "$BOLD$BLUE" "$title" "$RESET"
  [[ -n "$subtitle" ]] && printf "%s%s%s\n" "$BLUE" "$subtitle" "$RESET"
}

pass() { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
fail() { printf "  %s✗%s %s\n" "$RED" "$RESET" "$1" >&2; return 1; }
info() { printf "  %s•%s %s\n" "$YELLOW" "$RESET" "$1"; }

# mcp_init — one-time MCP transport handshake. Writes the
# mcp-session-id to $SMOKE_MCP_TRANSPORT_FILE so subsequent mcp_call
# invocations can reuse it. The MCP HTTP transport rejects repeat
# initialize calls within the same process lifetime.
mcp_init() {
  node "$SMOKE_MCP_SHARED/driver.mjs" init "$MCP_URL" "$SMOKE_MCP_TRANSPORT_FILE"
}

# mcp_call <tool-name> <args-json>
# Prints the tool's JSON response to stdout. Returns non-zero on tool
# error envelope (driver exits 8) or transport failure.
mcp_call() {
  local tool="$1"; local args="$2"
  node "$SMOKE_MCP_SHARED/driver.mjs" call "$MCP_URL" "$SMOKE_MCP_TRANSPORT_FILE" "$tool" "$args"
}

# Append a PID to the pidfile so teardown can kill it. Best-effort.
record_pid() {
  echo "$1" >> "$SMOKE_MCP_PIDS_FILE"
}

# Kill everything in the pidfile, then empty it.
kill_recorded_pids() {
  [[ -f "$SMOKE_MCP_PIDS_FILE" ]] || return 0
  while IFS= read -r p; do
    [[ -n "$p" ]] && kill "$p" 2>/dev/null || true
  done < "$SMOKE_MCP_PIDS_FILE"
  rm -f "$SMOKE_MCP_PIDS_FILE"
}
