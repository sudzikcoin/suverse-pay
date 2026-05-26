#!/usr/bin/env bash
# 99-teardown.sh — stop the smoke server, clean up PID + tmp files.
#
# Database state is intentionally left in place so a developer can
# inspect rows after a failed run with psql. To wipe, re-run
# 00-setup.sh which TRUNCATEs as its first step.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "99-teardown" "stop smoke server"

stop_smoke_server
rm -f "$SMOKE_PAYMENT_ID_FILE" "$SMOKE_TMP/last-idem"
pass "cleanup complete (logs preserved at $SMOKE_LOG)"
