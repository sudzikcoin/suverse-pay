#!/usr/bin/env bash
# 99-teardown.sh — revoke the resource API key bootstrapped in 00-setup
# (so the DB is left clean) and wipe per-run plaintext from /tmp. Leaves
# the running services alive — they have their own lifecycles. Always
# exits 0 because teardown failures should NOT fail the suite.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "99-teardown" "revoke resource key + wipe per-run plaintext"

if [[ -f "$SMOKE_REVM_RESOURCE_KEY_ID_FILE" ]]; then
  keyid=$(cat "$SMOKE_REVM_RESOURCE_KEY_ID_FILE")
  # Mark is_active=FALSE via Postgres directly. The /facilitator/* auth
  # path filters on is_active, so this immediately invalidates the key.
  if docker compose -f "$SMOKE_REVM_ROOT/docker-compose.yml" exec -T -e PGPASSWORD=suverse postgres \
       psql -U suverse -d suverse_pay -t -A -c \
       "UPDATE resource_api_keys SET is_active = FALSE WHERE id = '$keyid';" >/dev/null 2>&1; then
    pass "revoked $keyid"
  else
    info "could not revoke $keyid (suppressed — teardown is best-effort)"
  fi
fi

rm -f "$SMOKE_REVM_RESOURCE_KEY_FILE" "$SMOKE_REVM_RESOURCE_KEY_ID_FILE" \
      "$SMOKE_REVM_IDEM_FILE" "$SMOKE_REVM_PAYMENT_ID_FILE"
# Leave the signed fixtures + tx hash files in place so a failed run
# can be inspected after the fact (e.g. cross-reference BaseScan with
# the exact signed payload that produced the tx).
pass "wiped plaintext resource key + per-run state from $SMOKE_REVM_TMP"
exit 0
