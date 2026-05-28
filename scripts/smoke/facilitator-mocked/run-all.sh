#!/usr/bin/env bash
# run-all.sh — execute every numbered facilitator-mocked step in order,
# print a PASS/FAIL summary, exit non-zero if anything failed.
#
# Steps:
#   00-setup              bootstrap two resource keys (main + tight)
#   01-supported          GET /facilitator/supported
#   02-health             GET /facilitator/health
#   03-verify-cosmos      POST /facilitator/verify, real Cosmos payload
#   04-verify-evm         POST /facilitator/verify, EVM payload (routing only)
#   05-settle-cosmos      POST /facilitator/settle, REAL on-chain Cosmos broadcast
#   06-settle-no-auth     POST /facilitator/settle without Bearer → 401
#   07-settle-bad-auth    POST /facilitator/settle with bogus Bearer → 401
#   08-rate-limit         tight key → 429 + Retry-After
#   09-idempotency        replay 05's payload → same tx, no second broadcast
#   99-teardown           always runs, even on failure
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

steps=(
  "00-setup.sh"
  "01-supported.sh"
  "02-health.sh"
  "03-verify-cosmos.sh"
  "04-verify-evm.sh"
  "05-settle-cosmos.sh"
  "06-settle-no-auth.sh"
  "07-settle-bad-auth.sh"
  "08-rate-limit.sh"
  "09-idempotency.sh"
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
  printf "\n%sall %d facilitator-mocked steps passed%s\n" "$GREEN$BOLD" "${#steps[@]}" "$RESET"
  exit 0
fi
printf "\n%sone or more facilitator-mocked steps failed%s\n" "$RED$BOLD" "$RESET"
exit 1
