#!/usr/bin/env bash
# 08-rate-limit.sh — use the tight-quota resource key (rate-limit 2/min,
# bootstrapped by 00-setup) and exceed its limit. Asserts HTTP 429 with
# a code=rate_limited and a Retry-After header.
#
# The body shape is intentionally invalid (synthetic EVM payload, no
# real adapter routes it past rate-limit check). That's fine for this
# test — the rate limit fires BEFORE the adapter is consulted, so
# every request counts whether or not it would settle.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "08-rate-limit" "tight-quota resource key — must trip 429 after 2 requests"

if [[ ! -f "$SMOKE_FAC_TIGHT_KEY_FILE" ]]; then
  fail "$SMOKE_FAC_TIGHT_KEY_FILE missing — run 00-setup.sh first"
fi
tight_key="$(cat "$SMOKE_FAC_TIGHT_KEY_FILE")"

body='{"paymentPayload":{"x402Version":2,"scheme":"exact","network":"eip155:8453","payload":{}},"paymentRequirements":{"scheme":"exact","network":"eip155:8453","maxAmountRequired":"1","asset":"0x0","payTo":"0x0","resource":"x","maxTimeoutSeconds":60,"extra":{}}}'

# Send N+1 = 3 requests as fast as possible. With rate-limit=2/min, the
# 3rd must return 429.
seen_429=0
retry_after_seen=""
for i in 1 2 3 4; do
  hdr_file=$(mktemp)
  status=$(curl -sS -o /dev/null -D "$hdr_file" -w '%{http_code}' \
    -X POST "$BASE_URL/facilitator/settle" \
    -H "Authorization: Bearer $tight_key" \
    -H "Content-Type: application/json" \
    -d "$body")
  if [[ "$status" == "429" ]]; then
    seen_429=$((seen_429 + 1))
    retry_after_seen=$(awk 'tolower($1)=="retry-after:"{print $2; exit}' "$hdr_file" | tr -d '\r\n')
    info "request #$i: 429 (Retry-After: ${retry_after_seen:-<missing>})"
  else
    info "request #$i: $status"
  fi
  rm -f "$hdr_file"
done

if (( seen_429 == 0 )); then
  fail "expected at least one 429 across 4 requests under a 2/min quota"
fi
if [[ -z "$retry_after_seen" ]]; then
  fail "received 429 but no Retry-After header"
fi
if ! [[ "$retry_after_seen" =~ ^[0-9]+$ ]]; then
  fail "Retry-After value '$retry_after_seen' is not a non-negative integer"
fi
pass "rate-limit fired: $seen_429 of 4 requests rejected with 429 + Retry-After=${retry_after_seen}s"
