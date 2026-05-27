#!/usr/bin/env bash
# 00-setup.sh — sanity-check live services, spawn the x402-cosmos demo
# server and the MCP server. cosmos-pay :8402 and suverse-pay :3000
# must already be running — this suite does NOT touch them.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "00-setup" "verify live services + spawn demo + MCP"

require_admin_key
require_cosmos_env

# 1. Verify live infra.
info "verify cosmos-pay :$COSMOS_PAY_URL"
curl -sf --max-time 3 "$COSMOS_PAY_URL/supported" >/dev/null \
  || { fail "cosmos-pay not reachable at $COSMOS_PAY_URL"; exit 1; }
pass "cosmos-pay healthy"

info "verify suverse-pay $GATEWAY_URL/health"
curl -sf --max-time 3 "$GATEWAY_URL/health" >/dev/null \
  || { fail "suverse-pay not reachable at $GATEWAY_URL"; exit 1; }
pass "suverse-pay healthy"

# 2. Build demo server binary if missing.
if [[ ! -x "$DEMO_BINARY" ]]; then
  info "build x402-cosmos demo server → $DEMO_BINARY"
  (
    cd "$COSMOS_PAY_REPO"
    go build -o "$DEMO_BINARY" ./examples/server/ >>"$SMOKE_DEMO_LOG" 2>&1
  ) || { fail "demo server build failed"; tail -20 "$SMOKE_DEMO_LOG" >&2; exit 1; }
  pass "demo server built"
fi

# 3. Clean slate for this run.
[[ -f "$SMOKE_MCP_REAL_PIDS" ]] && kill_recorded_pids
rm -f "$SMOKE_MCP_REAL_SESSION_FILE" "$SMOKE_MCP_REAL_PAYMENT_FILE" "$SMOKE_MCP_REAL_TRANSPORT_FILE"
: > "$SMOKE_MCP_REAL_LOG"
: > "$SMOKE_DEMO_LOG"

# 4. Spawn the demo x402 resource server.
info "spawn demo server (:$DEMO_PORT) → cosmos-pay facilitator"
(
  X402_SERVER_ADDR=":$DEMO_PORT" \
  X402_PAY_TO="$X402_PAY_TO" \
  X402_FACILITATOR_URL="$COSMOS_PAY_URL" \
  X402_FACILITATOR_GRANTEE="$X402_FACILITATOR_GRANTEE" \
  X402_AMOUNT="$X402_AMOUNT" \
  X402_NETWORK="$X402_NETWORK" \
  X402_ASSET="$X402_ASSET" \
  "$DEMO_BINARY" >>"$SMOKE_DEMO_LOG" 2>&1 &
  echo $! >> "$SMOKE_MCP_REAL_PIDS"
)

for _ in $(seq 1 30); do
  if curl -sf --max-time 1 "$DEMO_URL/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 0.3
done
curl -sf --max-time 1 "$DEMO_URL/healthz" >/dev/null \
  || { fail "demo server did not bind. tail of $SMOKE_DEMO_LOG:"; tail -20 "$SMOKE_DEMO_LOG" >&2; exit 1; }
pass "demo server listening on $DEMO_URL"

# 5. Spawn MCP server pointed at the REAL gateway.
info "spawn MCP server (:$MCP_PORT) → real gateway"
(
  cd "$SMOKE_MCP_REAL_ROOT"
  MCP_PORT="$MCP_PORT" \
  MCP_HOST="127.0.0.1" \
  SUVERSE_PAY_GATEWAY_URL="$GATEWAY_URL" \
  SUVERSE_PAY_ADMIN_KEY="$ADMIN_API_KEY" \
  MCP_SESSION_TIMEOUT_MINUTES="30" \
  LOG_LEVEL="warn" \
  pnpm --filter @suverse-pay/mcp run start >"$SMOKE_MCP_REAL_LOG" 2>&1 &
  echo $! >> "$SMOKE_MCP_REAL_PIDS"
)

for _ in $(seq 1 60); do
  ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${MCP_PORT}$" && break
  sleep 0.5
done
ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${MCP_PORT}$" \
  || { fail "MCP did not bind"; tail -30 "$SMOKE_MCP_REAL_LOG" >&2; exit 1; }
pass "MCP listening on :$MCP_PORT"

# 6. MCP transport handshake.
sid=$(mcp_init)
[[ -n "$sid" ]] || { fail "MCP transport handshake failed"; exit 1; }
pass "MCP transport session: $sid"
