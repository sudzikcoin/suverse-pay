#!/usr/bin/env bash
# suverse-pay production deploy (Task 53).
#
# One-liner:
#   ./scripts/deploy.sh            # build + restart app services
#   ./scripts/deploy.sh proxy api  # build + restart only these
#
# Builds the monorepo (full `pnpm build` — typecheck/tests alone miss
# webpack + RSC errors, see CLAUDE.md), then restarts the systemd units
# for the requested services. Restart needs sudo; the script prints the
# exact commands and runs them via sudo.
#
# Env note: runtime env lives in /etc/suverse-pay/<svc>.env (600).
# Editing the repo .env does NOT affect running services — copy changes
# over and restart.
set -euo pipefail
cd "$(dirname "$0")/.."

ALL_SERVICES=(proxy api mcp dashboard)
declare -A UNIT=(
  [proxy]=suverse-pay-proxy
  [api]=suverse-pay-api
  [mcp]=suverse-pay-mcp
  [dashboard]=suverse-pay-dashboard
)

SERVICES=("${@:-${ALL_SERVICES[@]}}")
[ $# -eq 0 ] && SERVICES=("${ALL_SERVICES[@]}")

echo "==> pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile
echo "==> pnpm build"
pnpm build

for svc in "${SERVICES[@]}"; do
  unit="${UNIT[$svc]:-}"
  if [ -z "$unit" ]; then
    echo "unknown service: $svc (known: ${!UNIT[*]})" >&2
    exit 1
  fi
  echo "==> sudo systemctl restart $unit"
  sudo systemctl restart "$unit"
  sleep 2
  systemctl is-active --quiet "$unit" \
    && echo "    $unit: active" \
    || { echo "    $unit FAILED — journalctl -u $unit -n 50"; exit 1; }
done
echo "==> deploy done"
