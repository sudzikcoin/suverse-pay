#!/usr/bin/env bash
# run-all.sh — execute every numbered real-EVM step in order, print a
# PASS/FAIL summary, exit non-zero if anything failed. 99-teardown
# always runs, even on failure.
#
# Steps:
#   00-setup                verify env + creds + wallet funding; bootstrap resource key
#   01-supported            /providers + /facilitator/supported advertise eip155:84532
#   02-quote                synthetic CDP quote for Base Sepolia USDC
#   03-verify               POST /verify — CDP accepts the EIP-3009 signature
#   04-settle               REAL on-chain settle via /settle (internal admin path)
#   05-settle-idempotent    replay with same nonce — no second on-chain tx
#   06-facilitator-settle   REAL on-chain settle via /facilitator/settle (public path)
#   99-teardown             always runs
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

steps=(
  "00-setup.sh"
  "01-supported.sh"
  "02-quote.sh"
  "03-verify.sh"
  "04-settle.sh"
  "05-settle-idempotent.sh"
  "06-facilitator-settle.sh"
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

if [[ -f "$SMOKE_REVM_TX_FILE" ]]; then
  printf "\n  %s•%s internal-settle tx:     %s/tx/%s\n" "$YELLOW" "$RESET" \
    "$SMOKE_REVM_EXPLORER" "$(cat "$SMOKE_REVM_TX_FILE")"
fi
if [[ -f "$SMOKE_REVM_FAC_TX_FILE" ]]; then
  printf "  %s•%s facilitator-settle tx:  %s/tx/%s\n" "$YELLOW" "$RESET" \
    "$SMOKE_REVM_EXPLORER" "$(cat "$SMOKE_REVM_FAC_TX_FILE")"
fi

if (( failed == 0 )); then
  printf "\n%sall %d real-EVM smoke steps passed%s\n" "$GREEN$BOLD" "${#steps[@]}" "$RESET"
  exit 0
fi
printf "\n%sone or more real-EVM smoke steps failed%s\n" "$RED$BOLD" "$RESET"
exit 1
