#!/usr/bin/env bash
# 07-settle-fallback.sh — TASK.md acceptance scenarios #7 + #8 (combined).
#
# (#7 — fallback / retry on retryable provider failure)
#   Restart the smoke server with SMOKE_COSMOS_PAY_FAIL_MODE=
#   provider_internal_error so cosmos-pay always returns a retryable
#   failure. /settle should record a failed attempt and finalize as
#   status=failed (only one provider supports this route in the smoke
#   fixture, so cross-provider fallback degrades to "exhausted
#   candidate list" which is the same observable). This proves the
#   error mapping + payment_attempts row write-around-failure path.
#
# (#8 — route_unsupported)
#   Send a /settle for a scheme no adapter supports; expect
#   errorCode=route_unsupported, status=failed, zero attempts.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
source "$HERE/_lib.sh"

step_header "07-settle-fallback" "force cosmos-pay into fail mode, then send /settle"

info "stopping current smoke server (pnpm wraps tsx wraps node — full chain)"
stop_smoke_server

info "spawn smoke server with SMOKE_COSMOS_PAY_FAIL_MODE=provider_internal_error"
(
  cd "$ROOT"
  DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="$REDIS_URL" \
  ADMIN_API_KEY="$ADMIN_API_KEY" \
  API_PORT=3333 \
  LOG_LEVEL=warn \
  SMOKE_COSMOS_PAY_FAIL_MODE=provider_internal_error \
  pnpm --filter @suverse-pay/api run start:mock >>"$SMOKE_LOG" 2>&1 &
  echo $! >"$SMOKE_PID_FILE"
)
for _ in $(seq 1 60); do
  curl -sf "$BASE_URL/health" >/dev/null 2>&1 && break
  sleep 0.5
done

idem_fail="smoke-fallback-$(date +%s)"
read -r -d '' body <<'JSON' || true
{
  "paymentPayload": {
    "x402Version": 2,
    "scheme": "exact_cosmos_authz",
    "network": "cosmos:noble-1",
    "payload": { "from": "noble1payer", "publicKey": "k", "signature": "s",
      "authorization": { "from": "noble1payer", "to": "noble1recipient",
        "denom": "uusdc", "amount": "10000", "nonce": "f1",
        "validAfter": 0, "validBefore": 9999999999,
        "resource": "https://example.com/widget", "chainId": "noble-1" } }
  },
  "paymentRequirements": {
    "scheme": "exact_cosmos_authz",
    "network": "cosmos:noble-1",
    "maxAmountRequired": "10000",
    "asset": "uusdc",
    "payTo": "noble1recipient",
    "resource": "https://example.com/widget",
    "maxTimeoutSeconds": 60,
    "extra": { "facilitator": "smoke", "chainId": "noble-1" }
  }
}
JSON

expect_status 200 POST /settle -H "Idempotency-Key: $idem_fail" -d "$body" || exit 1
echo "$RESPONSE_BODY" | jq -C '{status, errorCode, attempts: [.attempts[] | {providerId, outcome, errorCode}]}'

status=$(echo "$RESPONSE_BODY" | jq -r .status)
ec=$(echo "$RESPONSE_BODY" | jq -r .errorCode)
n_attempts=$(echo "$RESPONSE_BODY" | jq '.attempts | length')

if [[ "$status" != "failed" ]]; then fail "expected status=failed when cosmos-pay fails, got $status"; fi
if [[ "$ec" != "provider_internal_error" ]]; then fail "expected errorCode=provider_internal_error, got $ec"; fi
if [[ "$n_attempts" -lt 1 ]]; then fail "expected at least 1 recorded attempt, got $n_attempts"; fi
pass "failure path: status=failed, errorCode=$ec, attempts=$n_attempts"

step_header "07b-route-unsupported" "POST /settle with unknown scheme — expect route_unsupported"

idem_route="smoke-noroute-$(date +%s)"
read -r -d '' bad_body <<'JSON' || true
{
  "paymentPayload": {
    "x402Version": 2,
    "scheme": "scheme_no_provider_supports",
    "network": "cosmos:noble-1",
    "payload": {}
  },
  "paymentRequirements": {
    "scheme": "scheme_no_provider_supports",
    "network": "cosmos:noble-1",
    "maxAmountRequired": "10000",
    "asset": "uusdc",
    "payTo": "noble1recipient",
    "resource": "https://example.com/widget"
  }
}
JSON

expect_status 200 POST /settle -H "Idempotency-Key: $idem_route" -d "$bad_body" || exit 1
echo "$RESPONSE_BODY" | jq -C '{status, errorCode, attempts: (.attempts | length)}'

status2=$(echo "$RESPONSE_BODY" | jq -r .status)
ec2=$(echo "$RESPONSE_BODY" | jq -r .errorCode)
n2=$(echo "$RESPONSE_BODY" | jq '.attempts | length')
if [[ "$status2" != "failed" || "$ec2" != "route_unsupported" || "$n2" != "0" ]]; then
  fail "expected status=failed/route_unsupported/0 attempts, got $status2/$ec2/$n2"
fi
pass "route_unsupported path: zero adapter calls, payment finalized as failed"

info "restart server in default (success) mode for downstream steps"
stop_smoke_server
(
  cd "$ROOT"
  DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
  ADMIN_API_KEY="$ADMIN_API_KEY" API_PORT=3333 LOG_LEVEL=warn \
  pnpm --filter @suverse-pay/api run start:mock >>"$SMOKE_LOG" 2>&1 &
  echo $! >"$SMOKE_PID_FILE"
)
for _ in $(seq 1 60); do
  curl -sf "$BASE_URL/health" >/dev/null 2>&1 && break
  sleep 0.5
done
pass "smoke server restored to default mode"
