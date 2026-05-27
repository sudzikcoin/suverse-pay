#!/usr/bin/env bash
# 06-end-session.sh — MCP end_session, then verify subsequent tool
# calls against that sessionId fail with session_not_found.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "06-end-session" "MCP end_session + post-destroy invariant"

[[ -f "$SMOKE_MCP_SESSION_FILE" ]] || { fail "no session file"; exit 1; }
sessionId=$(cat "$SMOKE_MCP_SESSION_FILE")

args=$(jq -nc --arg sid "$sessionId" '{sessionId: $sid}')
resp=$(mcp_call end_session "$args")
echo "$resp" | jq -C '.'
removed=$(echo "$resp" | jq -r .removed)
if [[ "$removed" != "true" ]]; then
  fail "expected removed=true, got $removed"
  exit 1
fi
pass "end_session removed=true"

# Subsequent call must fail with session_not_found.
listArgs=$(jq -nc --arg sid "$sessionId" '{sessionId: $sid}')
if errOut=$(mcp_call list_providers "$listArgs" 2>&1); then
  # driver exits 8 on tool error; if we get here, no error
  fail "expected list_providers to fail after end_session, got success: $errOut"
  exit 1
fi
echo "$errOut" | head -3
if ! echo "$errOut" | grep -q "session_not_found"; then
  fail "expected error code session_not_found, got: $errOut"
  exit 1
fi
pass "post-destroy list_providers correctly returned session_not_found"

# End_session is idempotent — second end_session on same id is harmless.
resp2=$(mcp_call end_session "$args")
removed2=$(echo "$resp2" | jq -r .removed)
if [[ "$removed2" != "false" ]]; then
  fail "expected removed=false on second end_session, got $removed2"
  exit 1
fi
pass "end_session is idempotent (second call: removed=false)"
