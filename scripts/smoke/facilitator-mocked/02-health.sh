#!/usr/bin/env bash
# 02-health.sh — GET /facilitator/health (no auth).
# Asserts shape: { status: "ok", x402Version: 2 }
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "02-health" "GET /facilitator/health — open access"

curl_capture "$BASE_URL/facilitator/health"
if [[ "$RESPONSE_STATUS" != "200" ]]; then
  fail "expected HTTP 200, got $RESPONSE_STATUS. body: $RESPONSE_BODY"
fi

status=$(echo "$RESPONSE_BODY" | jq -r '.status')
version=$(echo "$RESPONSE_BODY" | jq -r '.x402Version')
if [[ "$status" != "ok" ]]; then fail "expected status=ok, got $status"; fi
if [[ "$version" != "2" ]]; then fail "expected x402Version=2, got $version"; fi
pass "facilitator/health reports {status: ok, x402Version: 2}"
