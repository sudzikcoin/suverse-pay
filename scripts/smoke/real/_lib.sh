# Shared helpers for the real-network smoke suite. Source from each step.
# No `set` here — caller owns its options.

if [[ -t 1 ]]; then
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[0;33m'
  BLUE=$'\033[0;34m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; BOLD=""; RESET=""
fi

# Defaults — override via env vars before invocation.
: "${BASE_URL:=http://127.0.0.1:3000}"
: "${COSMOS_PAY_URL:=http://localhost:8402}"
: "${SMOKE_REAL_TMP:=/tmp/suverse-pay-real-smoke}"
: "${SMOKE_REAL_PAYMENT_ID_FILE:=$SMOKE_REAL_TMP/last-payment-id}"
: "${SMOKE_REAL_IDEM_FILE:=$SMOKE_REAL_TMP/last-idem}"

# Locate repo root from this file.
SMOKE_REAL_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_REAL_ROOT="$(cd "$SMOKE_REAL_HERE/../../.." && pwd)"

: "${FIXTURE_FILE:=$SMOKE_REAL_HERE/fixtures/signed-settle-fresh.json}"
: "${COSMOS_PAY_REPO:=/home/govhub/x402-cosmos}"
: "${FIXTURE_BINARY:=$COSMOS_PAY_REPO/bin/fixture}"

mkdir -p "$SMOKE_REAL_TMP" "$SMOKE_REAL_HERE/fixtures"

# ADMIN_API_KEY must be in environment (typically sourced from
# /home/govhub/suverse-pay/.env). The real suite does NOT bootstrap or
# rotate it — that would invalidate the running gateway's auth.
require_admin_key() {
  if [[ -z "${ADMIN_API_KEY:-}" ]]; then
    echo "${RED}ADMIN_API_KEY not set — source the suverse-pay .env first${RESET}" >&2
    return 1
  fi
}

step_header() {
  local title="$1"; local subtitle="${2:-}"
  printf "\n%s━━━ %s ━━━%s\n" "$BOLD$BLUE" "$title" "$RESET"
  [[ -n "$subtitle" ]] && printf "%s%s%s\n" "$BLUE" "$subtitle" "$RESET"
}

pass() {
  printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"
}

fail() {
  printf "  %s✗%s %s\n" "$RED" "$RESET" "$1" >&2
  return 1
}

info() {
  printf "  %s•%s %s\n" "$YELLOW" "$RESET" "$1"
}

curl_json() {
  local method="$1"; shift
  local url="$1"; shift
  local body_file http_status
  body_file=$(mktemp)
  http_status=$(curl -sS -o "$body_file" -w '%{http_code}' \
    -X "$method" \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    "$@" \
    "$BASE_URL$url")
  cat "$body_file"
  rm -f "$body_file"
  printf "%s" "$http_status" >&2
}

expect_status() {
  local expected="$1"; shift
  local body status stderr_file
  stderr_file=$(mktemp)
  body=$(curl_json "$@" 2>"$stderr_file")
  status=$(cat "$stderr_file")
  rm -f "$stderr_file"
  RESPONSE_BODY="$body"
  if [[ "$status" != "$expected" ]]; then
    fail "expected HTTP $expected, got $status. body: $body"
    return 1
  fi
  return 0
}
