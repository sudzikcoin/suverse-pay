#!/usr/bin/env bash
# run-all.sh — execute every numbered real-smoke step in order, print a
# PASS/FAIL summary, exit non-zero if anything failed.
#
# Steps:
#   00-prepare-fixtures   regenerate signed-settle-fresh.json (single-use)
#   00-setup              sanity-check gateway, facilitator, env
#   01-health             liveness
#   02-providers          cosmos-pay must be healthy
#   03-quote              synthetic quote returns cosmos-pay
#   04-verify             ADR-036 signature + grant + window all pass
#   05-settle             REAL on-chain broadcast on Noble grand-1
#   06-settle-idempotent  replay with same Idempotency-Key, no second tx
#   07-payments-get       /payments/:id reports the on-chain txHash
#   99-teardown           always runs, even on failure
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

steps=(
  "00-prepare-fixtures.sh"
  "00-setup.sh"
  "01-health.sh"
  "02-providers.sh"
  "03-quote.sh"
  "04-verify.sh"
  "05-settle.sh"
  "06-settle-idempotent.sh"
  "07-payments-get.sh"
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
  printf "\n%sall %d real-smoke steps passed%s\n" "$GREEN$BOLD" "${#steps[@]}" "$RESET"
  exit 0
fi
printf "\n%sone or more real-smoke steps failed%s\n" "$RED$BOLD" "$RESET"
exit 1
