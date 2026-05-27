#!/usr/bin/env bash
# run-all.sh — execute every numbered MCP-mocked smoke step in order,
# print a PASS/FAIL summary, exit non-zero if anything failed.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

steps=(
  "00-setup.sh"
  "01-init-session.sh"
  "02-list-providers.sh"
  "03-discover-endpoints.sh"
  "04-get-quote.sh"
  "05-pay-and-call.sh"
  "06-end-session.sh"
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
  printf "\n%sall %d mcp-mocked smoke steps passed%s\n" "$GREEN$BOLD" "${#steps[@]}" "$RESET"
  exit 0
fi
printf "\n%sone or more mcp-mocked smoke steps failed (logs in %s)%s\n" "$RED$BOLD" "$SMOKE_MCP_TMP" "$RESET"
exit 1
