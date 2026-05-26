# Shared helpers for the mocked smoke suite. Source from each step.
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

: "${BASE_URL:=http://127.0.0.1:3333}"
: "${ADMIN_API_KEY:=smoke-test-admin-key}"
: "${DATABASE_URL:=postgres://suverse:suverse@localhost:5433/suverse_pay}"
: "${REDIS_URL:=redis://localhost:6380}"
: "${SMOKE_TMP:=/tmp/suverse-pay-smoke}"
: "${SMOKE_PID_FILE:=$SMOKE_TMP/server.pid}"
: "${SMOKE_LOG:=$SMOKE_TMP/server.log}"
: "${SMOKE_PAYMENT_ID_FILE:=$SMOKE_TMP/last-payment-id}"

mkdir -p "$SMOKE_TMP"

# Block until the BASE_URL TCP port is free (no LISTEN socket). Used
# when restarting the smoke server with a different env: SIGTERM lets
# Node drain its pool + redis client, which can take a couple of
# seconds before the listen socket is actually released.
wait_smoke_port_free() {
  local host_port="${BASE_URL#http://}"
  local port="${host_port##*:}"
  for _ in $(seq 1 60); do
    if ! ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${port}$"; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

# pnpm wraps tsx wraps node — `kill <pnpm pid>` does NOT cascade to
# the listening Node process on every platform. pkill -f on the
# unique script path is reliable across pnpm versions.
stop_smoke_server() {
  if [[ -f "$SMOKE_PID_FILE" ]] && kill -0 "$(cat "$SMOKE_PID_FILE")" 2>/dev/null; then
    kill "$(cat "$SMOKE_PID_FILE")" 2>/dev/null || true
  fi
  pkill -f "tsx src/server-mock.ts" 2>/dev/null || true
  pkill -f "node.*server-mock" 2>/dev/null || true
  # If the port is still busy after 5s, escalate to SIGKILL.
  for _ in $(seq 1 20); do
    if ! ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${BASE_URL##*:}$"; then
      rm -f "$SMOKE_PID_FILE"
      return 0
    fi
    sleep 0.25
  done
  pkill -9 -f "tsx src/server-mock.ts" 2>/dev/null || true
  pkill -9 -f "node.*server-mock" 2>/dev/null || true
  wait_smoke_port_free
  rm -f "$SMOKE_PID_FILE"
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

# curl_json METHOD URL [extra-args...]
# Always sends auth header, prints body to stdout, status code to stderr line.
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

# expect_status EXPECTED_CODE METHOD URL [extra-args]
# Returns 0 on match, sets RESPONSE_BODY env, prints status.
expect_status() {
  local expected="$1"; shift
  local body status
  local stderr_file
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
