#!/usr/bin/env bash
# 99-teardown.sh — revoke the resource keys bootstrapped in 00-setup
# so the database is left clean. Leaves the running services alive.
# Always exits 0 — teardown failures should NOT fail the suite.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/_lib.sh"

step_header "99-teardown" "revoke smoke resource keys"

# Mark both keys is_active=FALSE via Postgres directly. The /facilitator/*
# auth path filters on is_active, so this immediately invalidates them.
for id_file in "$SMOKE_FAC_KEY_ID_FILE" "$SMOKE_FAC_TIGHT_KEY_ID_FILE"; do
  if [[ -f "$id_file" ]]; then
    id=$(cat "$id_file")
    if psql_exec -c "UPDATE resource_api_keys SET is_active = FALSE WHERE id = '$id';" >/dev/null 2>&1; then
      pass "revoked $id"
    else
      info "could not revoke $id (suppressed — teardown is best-effort)"
    fi
  fi
done

# Wipe the plaintext files from /tmp. The hashes stay in Postgres (with
# is_active=false) for forensic visibility; the plaintext should not.
rm -f "$SMOKE_FAC_KEY_FILE" "$SMOKE_FAC_TIGHT_KEY_FILE" \
      "$SMOKE_FAC_KEY_ID_FILE" "$SMOKE_FAC_TIGHT_KEY_ID_FILE"
pass "wiped plaintext key files from $SMOKE_FAC_TMP"
exit 0
