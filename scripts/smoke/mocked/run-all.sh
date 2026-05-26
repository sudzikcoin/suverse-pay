#!/usr/bin/env bash
# run-all.sh — execute every numbered smoke step in order, print a
# PASS/FAIL summary, exit non-zero if anything failed.
#
# Steps (with mapping to TASK.md §"Required for Phase 1 done" item 4):
#   00-setup            boot mock server
#   01-health           #1
#   02-providers        #2
#   03-quote            #3 + #4
#   04-verify           bonus
#   05-settle-happy     #5
#   06-settle-idempotent #6
#   07-settle-fallback  #7 + #8
#   08-payments-get     #9
#   09-metrics          #10
#   99-teardown         (always runs, even on failure)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

steps=(
  "00-setup.sh"
  "01-health.sh"
  "02-providers.sh"
  "03-quote.sh"
  "04-verify.sh"
  "05-settle-happy.sh"
  "06-settle-idempotent.sh"
  "07-settle-fallback.sh"
  "08-payments-get.sh"
  "09-metrics.sh"
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

# Always tear down so we don't leak a zombie server.
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
  printf "\n%sall %d smoke steps passed%s\n" "$GREEN$BOLD" "${#steps[@]}" "$RESET"
  exit 0
fi
printf "\n%sone or more smoke steps failed (see logs at %s)%s\n" "$RED$BOLD" "$SMOKE_LOG" "$RESET"
exit 1
