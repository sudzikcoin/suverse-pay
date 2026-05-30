/**
 * Tiny admin-role helper. v1 model is an env-var allowlist —
 * `ADMIN_EMAILS=alice@x.com,bob@y.com` — checked against the
 * authenticated session's email. Cheap to deploy, no schema, no
 * UI to flip flags. Switch to a DB-backed `dashboard_users.is_admin`
 * column once we have more than a handful of admins.
 *
 * Whitespace and case are normalised on read. An empty / unset
 * ADMIN_EMAILS means there ARE no admins and every admin-gated
 * route returns 403.
 */

let cached: Set<string> | null = null;
let cachedFromEnv = "";

function loadAdminEmails(): Set<string> {
  const raw = process.env["ADMIN_EMAILS"] ?? "";
  if (cached && raw === cachedFromEnv) return cached;
  cachedFromEnv = raw;
  cached = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
  return cached;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return loadAdminEmails().has(email.trim().toLowerCase());
}

/** Test hook — wipe the cache between tests that mutate ADMIN_EMAILS. */
export function _resetAdminCacheForTests(): void {
  cached = null;
  cachedFromEnv = "";
}
