#!/usr/bin/env bash
# 99-teardown.sh — kill all processes recorded by 00-setup.sh.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "99-teardown" "stop MCP + mock servers"

kill_recorded_pids
# Belt and braces — kill anything still bound to our ports.
for port in "$MCP_PORT" "$MOCK_X402_PORT" "$MOCK_GW_PORT"; do
  pid=$(ss -tlnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $0}' \
        | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  if [[ -n "$pid" ]]; then
    info "killing leftover pid $pid bound to :$port"
    kill "$pid" 2>/dev/null || true
  fi
done
# Wait for everything to release.
for _ in $(seq 1 20); do
  busy=0
  for port in "$MCP_PORT" "$MOCK_X402_PORT" "$MOCK_GW_PORT"; do
    ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":${port}$" && busy=1
  done
  [[ "$busy" -eq 0 ]] && break
  sleep 0.25
done
pass "teardown complete"
