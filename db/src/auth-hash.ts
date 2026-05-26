import { createHash } from "node:crypto";

/**
 * The id of the bootstrapped admin api_key row. v0.1 has exactly one
 * row. Phase 4 will keep this id for the gateway's own admin key and
 * mint additional rows for tenants.
 */
export const ADMIN_API_KEY_ID = "apikey_admin_default";

/**
 * v0.1 hash function for `api_keys.key_hash`.
 *
 * MUST be deterministic — bootstrap (write side) and the auth plugin
 * (read side) both compute it on the plaintext and compare the hex
 * strings. Anything with a per-call salt (bcrypt, argon2 with
 * random salt) would prevent the equality check and is reserved for
 * Phase 4 when api_keys grows a `hash_version` column.
 *
 * The plaintext key is always 32+ random bytes by user convention,
 * so a length-extension-safe construction is not required at this
 * stage.
 */
export function sha256ApiKeyHash(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}
