# Shared helpers for the real-EVM smoke suite. Source from each step.
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

# ---- Defaults — override via env vars before invocation -----------------
: "${BASE_URL:=http://127.0.0.1:3000}"
: "${SMOKE_REVM_TMP:=/tmp/suverse-pay-real-evm-smoke}"
: "${SMOKE_REVM_FIXTURE_INTERNAL:=$SMOKE_REVM_TMP/fixtures/internal-settle.json}"
: "${SMOKE_REVM_FIXTURE_FACILITATOR:=$SMOKE_REVM_TMP/fixtures/facilitator-settle.json}"
: "${SMOKE_REVM_IDEM_FILE:=$SMOKE_REVM_TMP/internal-idem}"
: "${SMOKE_REVM_PAYMENT_ID_FILE:=$SMOKE_REVM_TMP/internal-payment-id}"
: "${SMOKE_REVM_TX_FILE:=$SMOKE_REVM_TMP/internal-tx}"
: "${SMOKE_REVM_FAC_TX_FILE:=$SMOKE_REVM_TMP/facilitator-tx}"
: "${SMOKE_REVM_RESOURCE_KEY_FILE:=$SMOKE_REVM_TMP/resource-key.plaintext}"
: "${SMOKE_REVM_RESOURCE_KEY_ID_FILE:=$SMOKE_REVM_TMP/resource-key.id}"

# Base Sepolia constants — used for assertions and signing.
: "${SMOKE_REVM_NETWORK:=eip155:84532}"
: "${SMOKE_REVM_USDC:=0x036CbD53842c5426634e7929541eC2318f3dCF7e}"
: "${SMOKE_REVM_PAY_TO:=0x000000000000000000000000000000000000bEEF}"
: "${SMOKE_REVM_AMOUNT_ATOMIC:=1000}"  # 0.001 USDC per settle (CDP enforces a 1000-atomic minimum on Base Sepolia)
: "${SMOKE_REVM_RPC:=https://sepolia.base.org}"
: "${SMOKE_REVM_EXPLORER:=https://sepolia.basescan.org}"

# Locate repo root from this file.
SMOKE_REVM_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_REVM_ROOT="$(cd "$SMOKE_REVM_HERE/../../.." && pwd)"

mkdir -p "$SMOKE_REVM_TMP" "$SMOKE_REVM_TMP/fixtures"

step_header() {
  local title="$1"; local subtitle="${2:-}"
  printf "\n%s━━━ %s ━━━%s\n" "$BOLD$BLUE" "$title" "$RESET"
  [[ -n "$subtitle" ]] && printf "%s%s%s\n" "$BLUE" "$subtitle" "$RESET"
}
pass() { printf "  %s✓%s %s\n" "$GREEN" "$RESET" "$1"; }
fail() { printf "  %s✗%s %s\n" "$RED" "$RESET" "$1" >&2; return 1; }
info() { printf "  %s•%s %s\n" "$YELLOW" "$RESET" "$1"; }

# ADMIN_API_KEY must be in the environment. This suite NEVER bootstraps
# or rotates it — that would invalidate the running gateway's auth.
require_admin_key() {
  if [[ -z "${ADMIN_API_KEY:-}" ]]; then
    fail "ADMIN_API_KEY not set — source /home/govhub/suverse-pay/.env first"
    return 1
  fi
}

# Resource API key used by step 06 (the public /facilitator/settle path).
require_resource_key() {
  if [[ ! -f "$SMOKE_REVM_RESOURCE_KEY_FILE" ]]; then
    fail "$SMOKE_REVM_RESOURCE_KEY_FILE missing — run 00-setup.sh first"
    return 1
  fi
  RESOURCE_KEY="$(cat "$SMOKE_REVM_RESOURCE_KEY_FILE")"
}

# Capture body + status from a curl call. After return:
#   RESPONSE_BODY   — response body
#   RESPONSE_STATUS — HTTP status code
curl_capture() {
  local body_file
  body_file=$(mktemp)
  RESPONSE_STATUS=$(curl -sS -o "$body_file" -w '%{http_code}' "$@")
  RESPONSE_BODY=$(cat "$body_file")
  rm -f "$body_file"
}

# Authed JSON helper for the internal admin surface (/settle, /verify, /providers).
curl_admin() {
  local method="$1"; shift
  local url="$1"; shift
  curl_capture -X "$method" \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    "$@" \
    "$BASE_URL$url"
}

# Sign a payload via the workspace helper. Writes the JSON envelope to $1,
# emits the nonce on stdout so the caller can stash it for the idempotent
# replay test.
sign_payload() {
  local out_file="$1"
  cd "$SMOKE_REVM_ROOT" || return 1
  pnpm --silent tsx "$SMOKE_REVM_HERE/sign-payload.mts" \
    --out "$out_file" \
    --network "$SMOKE_REVM_NETWORK" \
    --asset "$SMOKE_REVM_USDC" \
    --pay-to "$SMOKE_REVM_PAY_TO" \
    --amount "$SMOKE_REVM_AMOUNT_ATOMIC"
}

# Wait until eth_getTransactionReceipt returns a non-null status for $1.
# Returns 0 (success) on confirmation; 1 if it doesn't confirm in time.
wait_for_tx_receipt() {
  local tx="$1"
  local tries=${2:-12}
  local sleep_s=${3:-5}
  for ((i=0; i<tries; i++)); do
    local body
    body=$(curl -s -X POST "$SMOKE_REVM_RPC" \
      -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$tx\"],\"id\":1}")
    local status
    status=$(echo "$body" | jq -r '.result.status // ""')
    if [[ "$status" == "0x1" ]]; then return 0; fi
    if [[ "$status" == "0x0" ]]; then
      info "tx $tx reverted on-chain: $body"
      return 1
    fi
    sleep "$sleep_s"
  done
  return 1
}
