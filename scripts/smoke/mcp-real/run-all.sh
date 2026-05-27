#!/usr/bin/env bash
# run-all.sh — execute every MCP real-network smoke step in order.
# REQUIRES live cosmos-pay :8402 and suverse-pay :3000 (this suite does
# NOT start them). The demo x402 server and MCP server are spawned and
# torn down by this suite.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

steps=(
  "00-setup.sh"
  "01-init-session.sh"
  "02-pay-and-call-cosmos.sh"
  "03-pay-and-call-idempotent.sh"
)
declare -A status_by_step
failed=0

for step in "${steps[@]}"; do
  if bash "$HERE/$step"; then
    status_by_step[$step]="PASS"
  else
    status_by_step[$step]="FAIL"
    failed=1
  fi
done

bash "$HERE/99-teardown.sh" || true

printf "\n%s━━━ summary ━━━%s\n" "$BOLD$BLUE" "$RESET"
for step in "${steps[@]}"; do
  if [[ "${status_by_step[$step]}" == "PASS" ]]; then
    printf "  %sPASS%s  %s\n" "$GREEN" "$RESET" "$step"
  else
    printf "  %sFAIL%s  %s\n" "$RED" "$RESET" "$step"
  fi
done

if (( failed == 0 )); then
  printf "\n%sall %d mcp-real smoke steps passed%s\n" "$GREEN$BOLD" "${#steps[@]}" "$RESET"
  exit 0
fi
printf "\n%sone or more mcp-real smoke steps failed (logs in %s)%s\n" "$RED$BOLD" "$SMOKE_MCP_REAL_TMP" "$RESET"
exit 1
