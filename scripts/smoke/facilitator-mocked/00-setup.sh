#!/usr/bin/env bash
# 00-setup.sh — verify the gateway is running, bootstrap a fresh resource
# API key via the CLI (label "facilitator-smoke"), AND a second tight-quota
# key for the rate-limit test (label "facilitator-smoke-tight",
# rate-limit 2/min). Stash both plaintexts + ids on disk.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "00-setup" "probe gateway + bootstrap two resource API keys"

if ! curl -sf -o /dev/null --max-time 3 "$BASE_URL/health"; then
  fail "suverse-pay /health not reachable at $BASE_URL — start the API server first"
fi
pass "suverse-pay reachable at $BASE_URL"

if ! curl -sf -o /dev/null --max-time 3 "$COSMOS_PAY_URL/supported"; then
  fail "cosmos-pay /supported not reachable at $COSMOS_PAY_URL — start the facilitator first"
fi
pass "cosmos-pay reachable at $COSMOS_PAY_URL"

# Load DATABASE_URL from .env so the CLI can talk to Postgres.
if [[ -f "$SMOKE_FAC_ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$SMOKE_FAC_ROOT/.env"; set +a
fi
if [[ -z "${DATABASE_URL:-}" ]]; then
  fail "DATABASE_URL not set (looked in $SMOKE_FAC_ROOT/.env)"
fi

# Wipe any prior plaintext files so the suite never re-uses a previously
# revoked key.
rm -f "$SMOKE_FAC_KEY_FILE" "$SMOKE_FAC_KEY_ID_FILE" \
      "$SMOKE_FAC_TIGHT_KEY_FILE" "$SMOKE_FAC_TIGHT_KEY_ID_FILE"

cd "$SMOKE_FAC_ROOT"

main_out=$(DATABASE_URL="$DATABASE_URL" \
  pnpm --silent --filter @suverse-pay/db run bootstrap-resource-key \
    -- --label "facilitator-smoke" --rate-limit 60 --monthly-cap null 2>&1)
main_plain=$(printf '%s\n' "$main_out" | awk '/^    [a-f0-9]{64}$/{gsub(/^    /,""); print; exit}')
main_id=$(printf '%s\n' "$main_out" | awk -F': +' '/^  id: /{print $2; exit}')
if [[ -z "$main_plain" || -z "$main_id" ]]; then
  printf '%s\n' "$main_out" >&2
  fail "could not parse plaintext or id from bootstrap output"
fi
printf '%s' "$main_plain" > "$SMOKE_FAC_KEY_FILE"
printf '%s' "$main_id" > "$SMOKE_FAC_KEY_ID_FILE"
chmod 600 "$SMOKE_FAC_KEY_FILE"
pass "bootstrapped main resource key: $main_id (60 req/min)"

tight_out=$(DATABASE_URL="$DATABASE_URL" \
  pnpm --silent --filter @suverse-pay/db run bootstrap-resource-key \
    -- --label "facilitator-smoke-tight" --rate-limit 2 --monthly-cap null 2>&1)
tight_plain=$(printf '%s\n' "$tight_out" | awk '/^    [a-f0-9]{64}$/{gsub(/^    /,""); print; exit}')
tight_id=$(printf '%s\n' "$tight_out" | awk -F': +' '/^  id: /{print $2; exit}')
if [[ -z "$tight_plain" || -z "$tight_id" ]]; then
  printf '%s\n' "$tight_out" >&2
  fail "could not parse plaintext or id from tight bootstrap output"
fi
printf '%s' "$tight_plain" > "$SMOKE_FAC_TIGHT_KEY_FILE"
printf '%s' "$tight_id" > "$SMOKE_FAC_TIGHT_KEY_ID_FILE"
chmod 600 "$SMOKE_FAC_TIGHT_KEY_FILE"
pass "bootstrapped tight resource key: $tight_id (2 req/min)"

info "main key file:  $SMOKE_FAC_KEY_FILE"
info "tight key file: $SMOKE_FAC_TIGHT_KEY_FILE"
