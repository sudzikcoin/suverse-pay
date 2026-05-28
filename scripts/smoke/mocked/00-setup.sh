#!/usr/bin/env bash
# 00-setup.sh — boot the mocked smoke server and wait for /health.
#
# Steps:
#   1. TRUNCATE non-fixture tables + FLUSHDB Redis (idempotent setup).
#   2. Run pnpm db:bootstrap with ADMIN_API_KEY=$ADMIN_API_KEY (--force).
#   3. Spawn `pnpm start:mock` in the background, write PID to
#      $SMOKE_PID_FILE.
#   4. Poll GET /health until 200 or 30s timeout.
#
# Idempotent: a stale PID from a previous run is killed first.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
source "$HERE/_lib.sh"

step_header "00-setup" "boot smoke server on $BASE_URL"

# Kill any leftover server from a previous botched run.
if [[ -f "$SMOKE_PID_FILE" ]] && kill -0 "$(cat "$SMOKE_PID_FILE")" 2>/dev/null; then
  info "killing stale smoke server pid=$(cat "$SMOKE_PID_FILE")"
  kill "$(cat "$SMOKE_PID_FILE")" 2>/dev/null || true
  sleep 1
fi
rm -f "$SMOKE_PID_FILE" "$SMOKE_PAYMENT_ID_FILE"

info "TRUNCATE non-fixture tables + FLUSHDB"
sg docker -c "docker compose -f \"$ROOT/docker-compose.yml\" exec -T postgres psql -U suverse -d suverse_pay -c \"TRUNCATE TABLE payment_attempts, routing_decisions, payments, provider_health_checks, merchant_policies, api_keys RESTART IDENTITY CASCADE\"" >/dev/null
sg docker -c "docker compose -f \"$ROOT/docker-compose.yml\" exec -T redis redis-cli FLUSHDB" >/dev/null

info "bootstrap admin api_key"
DATABASE_URL="$DATABASE_URL" ADMIN_API_KEY="$ADMIN_API_KEY" \
  pnpm --filter @suverse-pay/db run bootstrap --force >/dev/null

info "spawn mock server"
# Hard-pin API_PORT=3333: an upstream .env that sets API_PORT=3000
# would otherwise collide with a long-running dev gateway and the
# server-mock would fail with EADDRINUSE. The mocked smoke is a sandbox
# and must NEVER use the prod port.
(
  cd "$ROOT"
  DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="$REDIS_URL" \
  ADMIN_API_KEY="$ADMIN_API_KEY" \
  API_PORT=3333 \
  LOG_LEVEL="${LOG_LEVEL:-info}" \
  SMOKE_COSMOS_PAY_LATENCY_MS="${SMOKE_COSMOS_PAY_LATENCY_MS:-0}" \
  SMOKE_CDP_LATENCY_MS="${SMOKE_CDP_LATENCY_MS:-0}" \
  ${SMOKE_COSMOS_PAY_FAIL_MODE:+SMOKE_COSMOS_PAY_FAIL_MODE="$SMOKE_COSMOS_PAY_FAIL_MODE"} \
  pnpm --filter @suverse-pay/api run start:mock >"$SMOKE_LOG" 2>&1 &
  echo $! >"$SMOKE_PID_FILE"
)

info "wait for /health (up to 30s)"
for i in $(seq 1 60); do
  if curl -sf "$BASE_URL/health" >/dev/null 2>&1; then
    pass "server is up after ${i}*0.5s"
    pass "pid=$(cat "$SMOKE_PID_FILE"), log=$SMOKE_LOG"
    exit 0
  fi
  sleep 0.5
done

echo "${RED}server did not become healthy within 30s. tail of $SMOKE_LOG:${RESET}" >&2
tail -40 "$SMOKE_LOG" >&2 || true
exit 1
