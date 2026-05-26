import type { ClientBase, Pool, PoolClient } from "pg";
import { ADMIN_API_KEY_ID, sha256ApiKeyHash } from "./auth-hash.js";

export type BootstrapAction = "created" | "skipped" | "rotated";

export interface BootstrapResult {
  action: BootstrapAction;
  keyId: string;
}

export class AdminKeyRotationRequiredError extends Error {
  constructor() {
    super(
      `admin api_key '${ADMIN_API_KEY_ID}' already exists with a different hash. ` +
        `Re-run with --force (or ADMIN_API_KEY_FORCE=1) to rotate.`,
    );
    this.name = "AdminKeyRotationRequiredError";
  }
}

export interface BootstrapAdminApiKeyOptions {
  /** Existing pool/client. Caller owns its lifecycle. */
  client: ClientBase | PoolClient | Pool;
  /** The plaintext admin api key — hashed before storage. NEVER logged. */
  adminApiKey: string;
  /**
   * When true, an existing row whose hash differs from the supplied
   * key will be UPDATEd. When false (the safe default), a mismatched
   * existing row throws `AdminKeyRotationRequiredError`.
   */
  force?: boolean;
}

/**
 * Seeds (or rotates) the single `apikey_admin_default` row in
 * `api_keys`. Idempotent: a matching row is a no-op and returns
 * `action='skipped'`. A row with a different hash is treated as an
 * accidental rotation attempt and refuses to proceed unless
 * `force=true`. The migration runner (`pnpm db:migrate`) must have
 * been applied first so the `api_keys` table exists.
 *
 * Pure logic — caller supplies the connection. Tests drive it
 * against `pg-mem`; the CLI wrapper drives it against the real
 * `pg.Pool` from `DATABASE_URL`.
 */
export async function bootstrapAdminApiKey(
  opts: BootstrapAdminApiKeyOptions,
): Promise<BootstrapResult> {
  if (opts.adminApiKey.length === 0) {
    throw new Error("adminApiKey is empty");
  }
  const hash = sha256ApiKeyHash(opts.adminApiKey);

  const existing = await opts.client.query<{ key_hash: string }>(
    `SELECT key_hash FROM api_keys WHERE id = $1 AND revoked_at IS NULL`,
    [ADMIN_API_KEY_ID],
  );

  if (existing.rows.length > 0) {
    const currentHash = existing.rows[0]!.key_hash;
    if (currentHash === hash) {
      return { action: "skipped", keyId: ADMIN_API_KEY_ID };
    }
    if (opts.force !== true) {
      throw new AdminKeyRotationRequiredError();
    }
    await opts.client.query(
      `UPDATE api_keys SET key_hash = $2 WHERE id = $1`,
      [ADMIN_API_KEY_ID, hash],
    );
    return { action: "rotated", keyId: ADMIN_API_KEY_ID };
  }

  await opts.client.query(
    `INSERT INTO api_keys (id, key_hash, label)
     VALUES ($1, $2, 'default-admin')
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_API_KEY_ID, hash],
  );
  return { action: "created", keyId: ADMIN_API_KEY_ID };
}
