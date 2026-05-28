# Shared helpers for the facilitator-mocked smoke suite. Source from each step.
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
: "${SMOKE_FAC_TMP:=/tmp/suverse-pay-facilitator-smoke}"
: "${SMOKE_FAC_KEY_FILE:=$SMOKE_FAC_TMP/resource-key.plaintext}"
: "${SMOKE_FAC_KEY_ID_FILE:=$SMOKE_FAC_TMP/resource-key.id}"
: "${SMOKE_FAC_TIGHT_KEY_FILE:=$SMOKE_FAC_TMP/tight-key.plaintext}"
: "${SMOKE_FAC_TIGHT_KEY_ID_FILE:=$SMOKE_FAC_TMP/tight-key.id}"

SMOKE_FAC_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_FAC_ROOT="$(cd "$SMOKE_FAC_HERE/../../.." && pwd)"

# Reuse the Phase 1 real-smoke Cosmos fixture (signed PaymentPayload).
: "${COSMOS_FIXTURE_FILE:=$SMOKE_FAC_ROOT/scripts/smoke/real/fixtures/signed-settle-fresh.json}"
: "${COSMOS_PAY_REPO:=/home/govhub/x402-cosmos}"
: "${FIXTURE_BINARY:=$COSMOS_PAY_REPO/bin/fixture}"

mkdir -p "$SMOKE_FAC_TMP"

step_header() {
  local title="$1"; local subtitle="${2:-}"
  printf "\n%s━━━ %s ━━━%s\n" "$BOLD$BLUE" "$title" "$RESET"
  [[ -n "$subtitle" ]] && printf "%s%s%s\n" "$BLUE" "$subtitle" "$RESET"
}

pass() { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
fail() { printf "  %s✗%s %s\n" "$RED" "$RESET" "$1" >&2; return 1; }
info() { printf "  %s•%s %s\n" "$YELLOW" "$RESET" "$1"; }

require_resource_key() {
  if [[ ! -f "$SMOKE_FAC_KEY_FILE" ]]; then
    fail "$SMOKE_FAC_KEY_FILE missing — run 00-setup.sh first"
    return 1
  fi
  RESOURCE_KEY="$(cat "$SMOKE_FAC_KEY_FILE")"
  return 0
}

# Capture body + status from a curl call. After return:
#   RESPONSE_BODY = body
#   RESPONSE_STATUS = HTTP status code
curl_capture() {
  local body_file
  body_file=$(mktemp)
  RESPONSE_STATUS=$(curl -sS -o "$body_file" -w '%{http_code}' "$@")
  RESPONSE_BODY=$(cat "$body_file")
  rm -f "$body_file"
}

# Postgres-via-docker shell — used by 00-setup and 99-teardown to insert
# / revoke resource API keys without standing up a long-lived psql.
psql_exec() {
  docker compose -f "$SMOKE_FAC_ROOT/docker-compose.yml" exec -T -e PGPASSWORD=suverse postgres \
    psql -U suverse -d suverse_pay -t -A "$@"
}
