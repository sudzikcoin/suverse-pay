#!/usr/bin/env bash
# 00-setup.sh — spawn the mock x402 + mock gateway + MCP server.
# All three processes run on localhost loopback ports; nothing real is
# touched. Survives across the rest of the suite via pidfile.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "00-setup" "spawn mocks + MCP server on loopback"

# Clean slate.
[[ -f "$SMOKE_MCP_PIDS_FILE" ]] && kill_recorded_pids
rm -f "$SMOKE_MCP_SESSION_FILE" "$SMOKE_MCP_PAYMENT_FILE"
: > "$SMOKE_MCP_LOG"
: > "$SMOKE_MOCK_LOG"

# 1. mock x402 + mock gateway (single node process).
info "spawn mock servers (x402 :$MOCK_X402_PORT, gateway :$MOCK_GW_PORT)"
MOCK_X402_PORT="$MOCK_X402_PORT" MOCK_GW_PORT="$MOCK_GW_PORT" \
  node "$SMOKE_MCP_SHARED/test-servers.mjs" >"$SMOKE_MOCK_LOG" 2>&1 &
record_pid $!

# Wait for both ports to listen.
for _ in $(seq 1 30); do
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":(${MOCK_X402_PORT}|${MOCK_GW_PORT})$"; then
    : # at least one is up; keep waiting until both are
  fi
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${MOCK_X402_PORT}$" \
     && ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${MOCK_GW_PORT}$"; then
    break
  fi
  sleep 0.2
done
ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${MOCK_X402_PORT}$" || { fail "mock x402 did not bind"; tail -20 "$SMOKE_MOCK_LOG" >&2; exit 1; }
ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${MOCK_GW_PORT}$" || { fail "mock gateway did not bind"; tail -20 "$SMOKE_MOCK_LOG" >&2; exit 1; }
pass "mocks listening"

# 2. MCP server pointed at the mock gateway.
info "spawn MCP server (:$MCP_PORT) → mock gateway"
(
  cd "$SMOKE_MCP_ROOT"
  MCP_PORT="$MCP_PORT" \
  MCP_HOST="127.0.0.1" \
  SUVERSE_PAY_GATEWAY_URL="$MOCK_GW_URL" \
  SUVERSE_PAY_ADMIN_KEY="mcp-mocked-smoke-key" \
  MCP_SESSION_TIMEOUT_MINUTES="30" \
  LOG_LEVEL="warn" \
  pnpm --filter @suverse-pay/mcp run start >"$SMOKE_MCP_LOG" 2>&1 &
  echo $! >> "$SMOKE_MCP_PIDS_FILE"
)

# Wait for MCP to bind.
mcp_up=0
for _ in $(seq 1 60); do
  if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${MCP_PORT}$"; then
    mcp_up=1
    break
  fi
  sleep 0.5
done
if (( mcp_up == 0 )); then
  fail "MCP server did not become reachable. tail of $SMOKE_MCP_LOG:"
  tail -40 "$SMOKE_MCP_LOG" >&2 || true
  exit 1
fi
pass "MCP listening on :$MCP_PORT"

# 3. One-time MCP transport handshake. Subsequent steps reuse the
# session-id from $SMOKE_MCP_TRANSPORT_FILE because the streamable HTTP
# transport refuses repeat `initialize` calls within the same server
# lifetime.
info "MCP transport handshake (one-time)"
sid=$(mcp_init)
if [[ -z "$sid" ]]; then
  fail "MCP transport handshake did not return a session-id"
  exit 1
fi
pass "MCP transport session: $sid"
