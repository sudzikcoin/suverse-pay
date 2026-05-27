#!/usr/bin/env bash
# 00-setup.sh — sanity-check that everything the suite depends on is
# already running. The real suite does NOT start/stop gateways: cosmos-pay
# and suverse-pay run with their own credentials and lifecycles. This step
# fails fast with a clear message rather than producing confusing
# downstream errors.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "00-setup" "verify gateway, facilitator, env, fixture"

require_admin_key || exit 1
pass "ADMIN_API_KEY set"

if ! curl -sf -o /dev/null "$COSMOS_PAY_URL/supported"; then
  fail "cosmos-pay not reachable at $COSMOS_PAY_URL — start the facilitator first"
fi
pass "cosmos-pay /supported reachable at $COSMOS_PAY_URL"

if ! curl -sf -o /dev/null "$BASE_URL/health"; then
  fail "suverse-pay not reachable at $BASE_URL — start the API server first"
fi
pass "suverse-pay /health reachable at $BASE_URL"

if [[ ! -f "$FIXTURE_FILE" ]]; then
  fail "fixture not found at $FIXTURE_FILE — run 00-prepare-fixtures.sh first"
fi
pass "fixture present at $FIXTURE_FILE"

rm -f "$SMOKE_REAL_PAYMENT_ID_FILE" "$SMOKE_REAL_IDEM_FILE"
pass "cleared per-run state in $SMOKE_REAL_TMP"
