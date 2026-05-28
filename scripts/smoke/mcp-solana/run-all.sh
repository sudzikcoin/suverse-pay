#!/usr/bin/env bash
# run-all.sh — execute every numbered mcp-solana step in order, print
# a PASS/FAIL summary, exit non-zero if anything failed.
#
# Pre-requisites (NOT auto-installed):
#   - suverse-pay :3000 + cosmos-pay :8402 running
#   - .env.solana-devnet present (mnemonic + address) in repo root
#   - Funded Solana devnet wallet (USDC-Dev > 0 atomic units, SOL > 0.005)
#
# 00-setup will STOP with explicit funding instructions if the wallet
# is dry, so first-time setup is: generate keypair, run this once,
# follow the on-screen faucet prompts, re-run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

steps=(
  "00-setup.sh"
  "01-init-session.sh"
  "02-discover.sh"
  "03-pay-and-call-devnet.sh"
  "04-pay-and-call-idempotent.sh"
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
  printf "\n%sall %d mcp-solana steps passed%s\n" "$GREEN$BOLD" "${#steps[@]}" "$RESET"
  exit 0
fi
printf "\n%sone or more mcp-solana steps failed%s\n" "$RED$BOLD" "$RESET"
exit 1
