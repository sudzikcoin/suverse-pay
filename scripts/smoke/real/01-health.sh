#!/usr/bin/env bash
# 01-health.sh — GET /health → 200 OK.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "01-health" "GET /health"

expect_status 200 GET /health || exit 1
pass "/health → 200"
