import { createHash, randomBytes } from "node:crypto";
import type { ClientBase, Pool, PoolClient } from "pg";

/**
 * Resource API key row as returned by the store. Plaintext NEVER
 * appears in this shape — only the hash and metadata.
 */
export interface ResourceKeyRow {
  id: string;
  keyHash: string;
  label: string;
  rateLimitPerMinute: number;
  monthlySettleCap: number | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
}

export interface CreatedResourceKey {
  /** "reskey_<8 hex>" — used as the row id and surfaced in logs/metrics. */
  id: string;
  /** Plaintext key — returned ONCE, NEVER stored. Caller hands this to the resource server out-of-band. */
  plaintext: string;
  row: ResourceKeyRow;
}

/** Deterministic hash — see auth-hash.ts for the same rationale (cheap O(1) lookup on the hot path). */
export function hashResourceKey(plain: string): string {
  return createHash("sha256").update(plain, "utf8").digest("hex");
}

function randomKeyId(): string {
  // 8 random hex chars is enough entropy to avoid PK collisions across
  // a few-million keys without making the id hard to type or paste.
  return `reskey_${randomBytes(4).toString("hex")}`;
}

function randomPlaintext(): string {
  // 32 bytes of CSPRNG entropy → 64 hex chars. Length-extension safe
  // is irrelevant for our hash usage; entropy is what matters.
  return randomBytes(32).toString("hex");
}

export interface CreateResourceKeyOptions {
  client: ClientBase | PoolClient | Pool;
  label: string;
  rateLimitPerMinute?: number;
  monthlySettleCap?: number | null;
  metadata?: Record<string, unknown>;
}

export async function createResourceKey(
  opts: CreateResourceKeyOptions,
): Promise<CreatedResourceKey> {
  if (opts.label.length === 0) {
    throw new Error("label is required");
  }
  const id = randomKeyId();
  const plaintext = randomPlaintext();
  const keyHash = hashResourceKey(plaintext);
  const rateLimit = opts.rateLimitPerMinute ?? 60;
  const cap = opts.monthlySettleCap ?? null;
  const metadata = opts.metadata ?? {};

  const { rows } = await opts.client.query<{
    id: string;
    key_hash: string;
    label: string;
    rate_limit_per_minute: number;
    monthly_settle_cap: number | null;
    created_at: Date;
    last_used_at: Date | null;
    is_active: boolean;
    metadata: Record<string, unknown>;
  }>(
    `INSERT INTO resource_api_keys
       (id, key_hash, label, rate_limit_per_minute, monthly_settle_cap, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, key_hash, label, rate_limit_per_minute,
               monthly_settle_cap, created_at, last_used_at, is_active, metadata`,
    [id, keyHash, opts.label, rateLimit, cap, JSON.stringify(metadata)],
  );
  const r = rows[0]!;
  return {
    id,
    plaintext,
    row: rowToResourceKey(r),
  };
}

export interface FindResourceKeyOptions {
  client: ClientBase | PoolClient | Pool;
  plaintext: string;
}

/**
 * Look up a key by its plaintext value. Returns null when:
 *   - No row matches the hash
 *   - The row exists but is_active=false (revoked)
 * The auth plugin uses this on every /facilitator/settle request.
 */
export async function findResourceKey(
  opts: FindResourceKeyOptions,
): Promise<ResourceKeyRow | null> {
  if (opts.plaintext.length === 0) return null;
  const keyHash = hashResourceKey(opts.plaintext);
  const { rows } = await opts.client.query(
    `SELECT id, key_hash, label, rate_limit_per_minute, monthly_settle_cap,
            created_at, last_used_at, is_active, metadata
       FROM resource_api_keys
      WHERE key_hash = $1 AND is_active = TRUE
      LIMIT 1`,
    [keyHash],
  );
  if (rows.length === 0) return null;
  return rowToResourceKey(rows[0]);
}

export interface RevokeResourceKeyOptions {
  client: ClientBase | PoolClient | Pool;
  id: string;
}

export async function revokeResourceKey(
  opts: RevokeResourceKeyOptions,
): Promise<boolean> {
  const { rowCount } = await opts.client.query(
    `UPDATE resource_api_keys SET is_active = FALSE WHERE id = $1`,
    [opts.id],
  );
  return (rowCount ?? 0) > 0;
}

export interface TouchResourceKeyOptions {
  client: ClientBase | PoolClient | Pool;
  id: string;
}

/** Best-effort last-used update. Fire-and-forget from the hot path. */
export async function touchResourceKey(
  opts: TouchResourceKeyOptions,
): Promise<void> {
  await opts.client.query(
    `UPDATE resource_api_keys SET last_used_at = NOW() WHERE id = $1`,
    [opts.id],
  );
}

export interface MonthlySettleCountOptions {
  client: ClientBase | PoolClient | Pool;
  resourceKeyId: string;
  /** Override "now" — tests use a pinned clock. */
  now?: Date;
}

/**
 * Count successful settles for a key in the current calendar month
 * (UTC). Used to enforce monthlySettleCap at request time.
 */
export async function monthlySettleCount(
  opts: MonthlySettleCountOptions,
): Promise<number> {
  const now = opts.now ?? new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const { rows } = await opts.client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM facilitator_payments
      WHERE resource_key_id = $1
        AND status = 'settled'
        AND created_at >= $2`,
    [opts.resourceKeyId, monthStart],
  );
  return Number(rows[0]?.n ?? "0");
}

function rowToResourceKey(r: {
  id: string;
  key_hash: string;
  label: string;
  rate_limit_per_minute: number;
  monthly_settle_cap: number | null;
  created_at: Date;
  last_used_at: Date | null;
  is_active: boolean;
  metadata: Record<string, unknown>;
}): ResourceKeyRow {
  return {
    id: r.id,
    keyHash: r.key_hash,
    label: r.label,
    rateLimitPerMinute: r.rate_limit_per_minute,
    monthlySettleCap: r.monthly_settle_cap,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    isActive: r.is_active,
    metadata: r.metadata,
  };
}
