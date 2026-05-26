#!/usr/bin/env bash
# 03-quote.sh — TASK.md acceptance scenarios #3 + #4
# POST /quote returns synthetic quotes; optimize=cost orders them.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "03-quote" "POST /quote — synthetic quotes + optimize=cost ordering"

read -r -d '' body <<'JSON' || true
{
  "asset": "uusdc",
  "amount": "10000",
  "preferredNetworks": ["cosmos:noble-1", "eip155:8453"],
  "scheme": "exact_cosmos_authz",
  "policy": { "optimize": "cost" }
}
JSON

expect_status 200 POST /quote -d "$body" || exit 1
echo "$RESPONSE_BODY" | jq -C '{recommended, quotes: [.quotes[] | {providerId, network, estimatedFeeUsd}]}'

n=$(echo "$RESPONSE_BODY" | jq '.quotes | length')
if (( n < 1 )); then
  fail "no quotes returned"
fi

# Each successive fee should be >= the previous (ascending sort).
fees=$(echo "$RESPONSE_BODY" | jq -r '.quotes[].estimatedFeeUsd')
prev=""
while read -r f; do
  if [[ -n "$prev" ]]; then
    if awk "BEGIN { exit !($f >= $prev) }"; then : ; else
      fail "quotes not sorted ascending: $prev -> $f"
    fi
  fi
  prev="$f"
done <<<"$fees"

reason=$(echo "$RESPONSE_BODY" | jq -r '.recommended.reason')
if [[ "$reason" != "lowest_cost" ]]; then
  fail "expected recommended.reason=lowest_cost, got $reason"
fi
pass "$n synthetic quotes, sorted by cost ascending, recommended=$reason"
