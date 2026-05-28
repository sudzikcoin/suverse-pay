#!/usr/bin/env bash
# 99-teardown.sh — stop the mock x402 server and the MCP server. Leave
# suverse-pay :3000 and cosmos-pay :8402 running (managed outside this
# suite). Always exits 0.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "99-teardown" "stop mock x402 + MCP"

kill_recorded_pids
for port in "$MCP_PORT" "$MOCK_PORT"; do
  pid=$(ss -tlnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $0}' \
        | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  if [[ -n "$pid" ]]; then
    info "killing leftover pid $pid on :$port"
    kill "$pid" 2>/dev/null || true
  fi
done
for _ in $(seq 1 20); do
  busy=0
  for port in "$MCP_PORT" "$MOCK_PORT"; do
    ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${port}$" && busy=1
  done
  [[ "$busy" -eq 0 ]] && break
  sleep 0.25
done
pass "teardown complete"
exit 0
