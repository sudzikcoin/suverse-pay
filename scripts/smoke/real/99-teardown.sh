#!/usr/bin/env bash
# 99-teardown.sh — clean per-run state. Does NOT stop the gateway or
# facilitator; they run externally with their own lifecycles.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "99-teardown" "clean per-run state in $SMOKE_REAL_TMP"

rm -f "$SMOKE_REAL_PAYMENT_ID_FILE" "$SMOKE_REAL_IDEM_FILE"
# Leave the signed fixture in place — it has the txHash and on-chain
# proof, useful for forensic debugging after a failed run.
pass "removed payment-id and idem files; fixture preserved at $FIXTURE_FILE"
