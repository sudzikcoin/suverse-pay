import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dbQuery } from "./db";

/**
 * Centralized SQL for the customer dashboard. Every query that
 * touches `facilitator_payments` is gated on the user's set of
 * linked resource keys — no cross-tenant data ever surfaces.
 *
 * Period helpers: the dashboard supports 24h / 7d / 30d as a single
 * toggle. The functions below take a `since: Date` (UTC) and a list
 * of resource key ids — callers compute the `since` from period.
 */

export type Period = "24h" | "7d" | "30d";

export function periodToSince(period: Period, now: Date = new Date()): Date {
  const ms =
    period === "24h"
      ? 24 * 60 * 60 * 1000
      : period === "7d"
      ? 7 * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() - ms);
}

/** Returns the resource_key_id list a dashboard user has linked. */
export async function getLinkedResourceKeys(
  userId: string,
): Promise<string[]> {
  const rows = await dbQuery<{ resource_key_id: string }>(
    `SELECT resource_key_id FROM dashboard_user_resource_keys WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.resource_key_id);
}

export interface DashboardStats {
  totalSettles: number;
  totalVolumeAtomic: string; // atomic units, 6-decimal USDC equivalent
  successRate: number;       // 0..1
  activeNetworks: number;    // distinct networks with >=1 settle in period
  /** SUM(fee_amount) for settled rows in period — atomic units. */
  totalFeeAtomic: string;
  /** SUM(net_amount) for settled rows in period — atomic units. */
  totalNetAtomic: string;
}

/**
 * Aggregate stats for the summary cards. Uses NUMERIC math for
 * volume so we don't lose precision on large amounts. Returns zeros
 * if the user has no linked keys (instead of failing) — the
 * dashboard treats the empty case via the linker UI.
 */
export async function loadStats(args: {
  resourceKeyIds: ReadonlyArray<string>;
  since: Date;
}): Promise<DashboardStats> {
  if (args.resourceKeyIds.length === 0) {
    return {
      totalSettles: 0,
      totalVolumeAtomic: "0",
      successRate: 0,
      activeNetworks: 0,
      totalFeeAtomic: "0",
      totalNetAtomic: "0",
    };
  }
  const rows = await dbQuery<{
    total: string;
    settled: string;
    failed: string;
    volume: string;
    networks: string;
    fee: string;
    net: string;
  }>(
    `
    SELECT
      COUNT(*)::text                                                       AS total,
      COUNT(*) FILTER (WHERE status = 'settled')::text                     AS settled,
      COUNT(*) FILTER (WHERE status = 'failed')::text                      AS failed,
      COALESCE(SUM(gross_amount) FILTER (WHERE status = 'settled'), 0)::text AS volume,
      COUNT(DISTINCT network)::text                                        AS networks,
      COALESCE(SUM(fee_amount)   FILTER (WHERE status = 'settled'), 0)::text AS fee,
      COALESCE(SUM(net_amount)   FILTER (WHERE status = 'settled'), 0)::text AS net
    FROM facilitator_payments
    WHERE resource_key_id = ANY($1::text[])
      AND created_at >= $2
    `,
    [args.resourceKeyIds, args.since],
  );
  const r = rows[0]!;
  const total = Number(r.total);
  const settled = Number(r.settled);
  const successRate = total === 0 ? 0 : settled / total;
  return {
    totalSettles: total,
    totalVolumeAtomic: r.volume,
    successRate,
    activeNetworks: Number(r.networks),
    totalFeeAtomic: r.fee,
    totalNetAtomic: r.net,
  };
}

export interface SettleRow {
  id: string;
  createdAt: string;          // ISO
  network: string;            // CAIP-2
  asset: string;
  amount: string;             // atomic — equals gross for current accounting-only fee model
  feeAmount: string;          // atomic — platform fee withheld at accounting level
  status: "settled" | "failed" | "pending";
  txHash: string | null;
  adapterUsed: string | null;
  errorCode: string | null;
}

export async function loadRecentSettles(args: {
  resourceKeyIds: ReadonlyArray<string>;
  limit: number;
  filter: "all" | "settled" | "failed";
}): Promise<SettleRow[]> {
  if (args.resourceKeyIds.length === 0) return [];
  const statusClause =
    args.filter === "all" ? "" : "AND status = $3";
  const params: unknown[] = [args.resourceKeyIds, args.limit];
  if (args.filter !== "all") params.push(args.filter);
  const rows = await dbQuery<{
    id: string;
    created_at: Date;
    network: string;
    asset: string;
    amount: string;
    fee_amount: string;
    status: SettleRow["status"];
    tx_hash: string | null;
    adapter_used: string | null;
    error_code: string | null;
  }>(
    `
    SELECT id, created_at, network, asset, amount, fee_amount, status, tx_hash,
           adapter_used, error_code
    FROM facilitator_payments
    WHERE resource_key_id = ANY($1::text[]) ${statusClause}
    ORDER BY created_at DESC
    LIMIT $2
    `,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at.toISOString(),
    network: r.network,
    asset: r.asset,
    amount: r.amount,
    feeAmount: r.fee_amount,
    status: r.status,
    txHash: r.tx_hash,
    adapterUsed: r.adapter_used,
    errorCode: r.error_code,
  }));
}

export interface InvoiceLineRow {
  /** ISO timestamp of the settle. */
  createdAt: string;
  settleId: string;
  network: string;
  /** Atomic units of gross_amount. */
  grossAmount: string;
  /** Atomic units of fee_amount. */
  feeAmount: string;
  /** Atomic units of net_amount. */
  netAmount: string;
  /** On-chain tx hash if known; null on failed/pending settles. */
  txHash: string | null;
  /** Human label of the resource key used (resource_api_keys.label). */
  keyLabel: string;
}

export interface InvoiceSummary {
  from: Date;
  until: Date;
  totalSettles: number;
  totalGrossAtomic: string;
  totalFeeAtomic: string;
  totalNetAtomic: string;
}

/**
 * Load every settled row in [from, until) for the user's keys plus
 * an aggregate summary. Caller turns this into the CSV body.
 *
 * Only `status='settled'` rows are billed — failed settles produced
 * no on-chain transfer and therefore no platform fee owed.
 */
export async function loadInvoice(args: {
  resourceKeyIds: ReadonlyArray<string>;
  from: Date;
  until: Date;
}): Promise<{ lines: InvoiceLineRow[]; summary: InvoiceSummary }> {
  if (args.resourceKeyIds.length === 0) {
    return {
      lines: [],
      summary: {
        from: args.from,
        until: args.until,
        totalSettles: 0,
        totalGrossAtomic: "0",
        totalFeeAtomic: "0",
        totalNetAtomic: "0",
      },
    };
  }
  const rows = await dbQuery<{
    created_at: Date;
    id: string;
    network: string;
    gross_amount: string;
    fee_amount: string;
    net_amount: string;
    tx_hash: string | null;
    label: string;
  }>(
    `
    SELECT fp.created_at, fp.id, fp.network,
           fp.gross_amount::text AS gross_amount,
           fp.fee_amount::text   AS fee_amount,
           fp.net_amount::text   AS net_amount,
           fp.tx_hash,
           rak.label
      FROM facilitator_payments fp
      JOIN resource_api_keys    rak ON rak.id = fp.resource_key_id
     WHERE fp.resource_key_id = ANY($1::text[])
       AND fp.status = 'settled'
       AND fp.created_at >= $2
       AND fp.created_at <  $3
     ORDER BY fp.created_at ASC
    `,
    [args.resourceKeyIds, args.from, args.until],
  );
  const lines: InvoiceLineRow[] = rows.map((r) => ({
    createdAt: r.created_at.toISOString(),
    settleId: r.id,
    network: r.network,
    grossAmount: r.gross_amount,
    feeAmount: r.fee_amount,
    netAmount: r.net_amount,
    txHash: r.tx_hash,
    keyLabel: r.label,
  }));
  let totalGross = 0n;
  let totalFee = 0n;
  let totalNet = 0n;
  for (const l of lines) {
    totalGross += BigInt(l.grossAmount);
    totalFee += BigInt(l.feeAmount);
    totalNet += BigInt(l.netAmount);
  }
  return {
    lines,
    summary: {
      from: args.from,
      until: args.until,
      totalSettles: lines.length,
      totalGrossAtomic: totalGross.toString(),
      totalFeeAtomic: totalFee.toString(),
      totalNetAtomic: totalNet.toString(),
    },
  };
}

export interface NetworkBreakdownRow {
  network: string;
  settles: number;
  failed: number;
  volumeAtomic: string;
}

/**
 * Per-network breakdown — used in place of the per-endpoint panel
 * the original prompt described. `facilitator_payments` does not
 * carry an endpoint-path column today (Phase 5 carry-over: extend
 * the wire spec so resource servers attach `resource_path` on
 * settle), so grouping by network is the closest analog the
 * existing schema supports.
 */
export async function loadNetworkBreakdown(args: {
  resourceKeyIds: ReadonlyArray<string>;
  since: Date;
}): Promise<NetworkBreakdownRow[]> {
  if (args.resourceKeyIds.length === 0) return [];
  const rows = await dbQuery<{
    network: string;
    settles: string;
    failed: string;
    volume: string;
  }>(
    `
    SELECT
      network,
      COUNT(*) FILTER (WHERE status = 'settled')::text                       AS settles,
      COUNT(*) FILTER (WHERE status = 'failed')::text                        AS failed,
      COALESCE(SUM(amount::numeric) FILTER (WHERE status = 'settled'), 0)::text AS volume
    FROM facilitator_payments
    WHERE resource_key_id = ANY($1::text[])
      AND created_at >= $2
    GROUP BY network
    ORDER BY SUM(amount::numeric) FILTER (WHERE status = 'settled') DESC NULLS LAST,
             COUNT(*) DESC
    `,
    [args.resourceKeyIds, args.since],
  );
  return rows.map((r) => ({
    network: r.network,
    settles: Number(r.settles),
    failed: Number(r.failed),
    volumeAtomic: r.volume,
  }));
}

export interface VolumeChartPoint {
  bucket: string; // ISO timestamp of bucket start
  volumeAtomic: string;
  settles: number;
}

/**
 * Time-bucketed settled volume series. 24h period → hourly buckets;
 * 7d / 30d → daily buckets.
 */
export async function loadVolumeChart(args: {
  resourceKeyIds: ReadonlyArray<string>;
  since: Date;
  period: Period;
}): Promise<VolumeChartPoint[]> {
  if (args.resourceKeyIds.length === 0) return [];
  const bucket = args.period === "24h" ? "hour" : "day";
  const rows = await dbQuery<{
    bucket: Date;
    volume: string;
    settles: string;
  }>(
    `
    SELECT
      date_trunc($3, created_at)                                            AS bucket,
      COALESCE(SUM(amount::numeric) FILTER (WHERE status = 'settled'), 0)::text AS volume,
      COUNT(*) FILTER (WHERE status = 'settled')::text                      AS settles
    FROM facilitator_payments
    WHERE resource_key_id = ANY($1::text[])
      AND created_at >= $2
    GROUP BY date_trunc($3, created_at)
    ORDER BY bucket ASC
    `,
    [args.resourceKeyIds, args.since, bucket],
  );
  return rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    volumeAtomic: r.volume,
    settles: Number(r.settles),
  }));
}

/**
 * Resource key info for the header chip / key selector. Pulls
 * the human-facing label off resource_api_keys via the link table.
 */
export interface LinkedKeyInfo {
  resourceKeyId: string;
  label: string;
  linkedAt: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listLinkedKeysWithLabel(
  userId: string,
): Promise<LinkedKeyInfo[]> {
  const rows = await dbQuery<{
    resource_key_id: string;
    label: string;
    linked_at: Date;
    is_active: boolean;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `
    SELECT k.id AS resource_key_id, k.label, l.linked_at, k.is_active,
           k.created_at, k.last_used_at
    FROM dashboard_user_resource_keys l
    JOIN resource_api_keys k ON k.id = l.resource_key_id
    WHERE l.user_id = $1
    ORDER BY k.is_active DESC, l.linked_at DESC
    `,
    [userId],
  );
  return rows.map((r) => ({
    resourceKeyId: r.resource_key_id,
    label: r.label,
    linkedAt: r.linked_at.toISOString(),
    isActive: r.is_active,
    createdAt: r.created_at.toISOString(),
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  }));
}

/**
 * Validate a plaintext resource key against `resource_api_keys.key_hash`
 * and link it to the dashboard user. The key_hash column stores
 * `sha256(plaintext)` hex (see apps/api's plugin code). Returns
 * the resource key id + label on success, null if the key is unknown
 * or inactive.
 */

export interface LinkKeyResult {
  resourceKeyId: string;
  label: string;
  alreadyLinked: boolean;
}

export async function linkResourceKey(args: {
  userId: string;
  plaintext: string;
}): Promise<LinkKeyResult | null> {
  const hash = createHash("sha256").update(args.plaintext, "utf8").digest("hex");
  const found = await dbQuery<{
    id: string;
    label: string;
    is_active: boolean;
  }>(
    `SELECT id, label, is_active FROM resource_api_keys WHERE key_hash = $1`,
    [hash],
  );
  if (found.length === 0) return null;
  const key = found[0]!;
  if (!key.is_active) return null;
  // Insert the link; ON CONFLICT lets us report "already linked".
  // UUID generated app-side — see auth.ts for the rationale.
  const linked = await dbQuery<{ inserted: boolean }>(
    `
    INSERT INTO dashboard_user_resource_keys (id, user_id, resource_key_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id, resource_key_id) DO NOTHING
    RETURNING TRUE AS inserted
    `,
    [randomUUID(), args.userId, key.id],
  );
  return {
    resourceKeyId: key.id,
    label: key.label,
    alreadyLinked: linked.length === 0,
  };
}

/* -------------------------------------------------------------------------- */
/*  Self-serve resource key creation (Phase 5 Block 4 Sub-task 2)             */
/* -------------------------------------------------------------------------- */

/** Maximum active keys a single dashboard user can hold at once. */
export const MAX_KEYS_PER_USER = 5;
/** Cooldown between creations — prevents brute-spawn even within the cap. */
export const CREATE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Result of `checkCreateKeyRateLimit` — either OK or a reason the
 * request should be rejected. Reasons map directly to user-facing
 * messages so the UI can show them verbatim.
 */
export type CreateRateLimitResult =
  | { ok: true }
  | {
      ok: false;
      reason: "max-keys-reached" | "cooldown";
      activeKeys: number;
      cooldownEndsAt: string | null;
    };

/**
 * Two-rule rate limit:
 *   1. ≤ MAX_KEYS_PER_USER active (is_active=true) keys total.
 *   2. ≤ 1 new key per CREATE_COOLDOWN_MS window — measured against
 *      `resource_api_keys.created_at` on the user's most recently
 *      created (or linked, whichever is newer) key.
 *
 * DB-based, not Redis — at the rate one user creates a handful of
 * keys total, the count query is essentially free and the schema
 * stays the source of truth.
 */
export async function checkCreateKeyRateLimit(
  userId: string,
): Promise<CreateRateLimitResult> {
  const rows = await dbQuery<{
    active_count: string;
    most_recent_created_at: Date | null;
  }>(
    `
    SELECT
      COUNT(*) FILTER (WHERE k.is_active)::text       AS active_count,
      MAX(k.created_at)                                AS most_recent_created_at
    FROM dashboard_user_resource_keys l
    JOIN resource_api_keys k ON k.id = l.resource_key_id
    WHERE l.user_id = $1
    `,
    [userId],
  );
  const r = rows[0] ?? { active_count: "0", most_recent_created_at: null };
  const active = Number(r.active_count);
  if (active >= MAX_KEYS_PER_USER) {
    return {
      ok: false,
      reason: "max-keys-reached",
      activeKeys: active,
      cooldownEndsAt: null,
    };
  }
  if (r.most_recent_created_at) {
    const elapsedMs = Date.now() - r.most_recent_created_at.getTime();
    if (elapsedMs < CREATE_COOLDOWN_MS) {
      return {
        ok: false,
        reason: "cooldown",
        activeKeys: active,
        cooldownEndsAt: new Date(
          r.most_recent_created_at.getTime() + CREATE_COOLDOWN_MS,
        ).toISOString(),
      };
    }
  }
  return { ok: true };
}

/**
 * Generate a fresh resource API key id matching the existing
 * convention: `reskey_<8 lowercase hex>`. Random 4 bytes is 32 bits
 * = ~4.3B namespace; the unique index on `resource_api_keys.id`
 * catches the astronomically rare collision and the caller can
 * retry. Kept short because this id surfaces in logs.
 */
function generateKeyId(): string {
  return "reskey_" + randomBytes(4).toString("hex");
}

/**
 * Generate the plaintext key the customer copies + stores.
 * `sup_live_<32 alphanumeric>` — `sup` is the Suverse Pay namespace,
 * chosen so the prefix does not collide with Stripe (`rk_`, `sk_`),
 * GitHub (`ghp_`), AWS (`AKIA`), OpenAI/Anthropic (`sk-`, `sk-ant-`)
 * and therefore never trips upstream secret-scanning false positives.
 * 32 chars from a 62-char alphabet ≈ 190 bits of entropy — brute-
 * force is infeasible even with the hash being sha256 (no salt).
 *
 * `live` is reserved for a future split between live / test keys
 * (Phase 5+); for v1 only `live` is emitted, the segment is there so
 * `sup_test_` can be added without changing the wire format.
 */
const PLAINTEXT_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function generatePlaintextKey(): string {
  const buf = randomBytes(32);
  let out = "sup_live_";
  for (let i = 0; i < 32; i++) {
    out += PLAINTEXT_ALPHABET[buf[i]! % PLAINTEXT_ALPHABET.length];
  }
  return out;
}

export interface CreatedKey {
  resourceKeyId: string;
  /** Plaintext key — shown to the customer EXACTLY ONCE. */
  plaintext: string;
  label: string;
  createdAt: string;
}

/**
 * Self-serve key creation. Generates id + plaintext, hashes the
 * plaintext, inserts into resource_api_keys, links to the dashboard
 * user. All three writes happen in a single transaction so an
 * orphaned key row never persists if the link insert fails.
 *
 * Idempotency-wise: not idempotent by design — every call mints a
 * fresh secret. The rate limit upstream prevents accidental
 * duplicate clicks from spawning extra keys.
 */
export async function createResourceKey(args: {
  userId: string;
  label: string;
}): Promise<CreatedKey> {
  if (args.label.length === 0 || args.label.length > 80) {
    throw new Error("label must be 1-80 characters");
  }
  const plaintext = generatePlaintextKey();
  const hash = createHash("sha256").update(plaintext, "utf8").digest("hex");
  // Retry on rare id collision (8-hex namespace × insert per user is
  // tiny but the unique index makes this defensive cheap).
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateKeyId();
    const pool = (await import("./db")).getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const inserted = await client.query<{ created_at: Date }>(
          `
          INSERT INTO resource_api_keys (id, key_hash, label, metadata)
          VALUES ($1, $2, $3, $4::jsonb)
          RETURNING created_at
          `,
          [
            id,
            hash,
            args.label,
            JSON.stringify({
              createdVia: "dashboard-self-serve",
              dashboardUserId: args.userId,
            }),
          ],
        );
        await client.query(
          `
          INSERT INTO dashboard_user_resource_keys
            (id, user_id, resource_key_id)
          VALUES ($1, $2, $3)
          `,
          [randomUUID(), args.userId, id],
        );
        await client.query("COMMIT");
        return {
          resourceKeyId: id,
          plaintext,
          label: args.label,
          createdAt: inserted.rows[0]!.created_at.toISOString(),
        };
      } catch (err) {
        await client.query("ROLLBACK");
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code: unknown }).code)
            : "";
        // 23505 = unique_violation in Postgres. Only the id column
        // collides (key_hash is essentially unique by construction);
        // retry with a new id.
        if (code === "23505" && attempt < 4) continue;
        throw err;
      }
    } finally {
      client.release();
    }
  }
  throw new Error("could not generate a unique key id after 5 attempts");
}

/**
 * Soft-revoke. We never DELETE — keeps the audit trail intact (the
 * payment_attempts / facilitator_payments tables FK against
 * resource_api_keys.id, and CASCADE would orphan that history).
 * Returns false if the key isn't linked to this user (treated the
 * same as "not found" — never leak existence of someone else's key).
 */
export async function revokeResourceKey(args: {
  userId: string;
  resourceKeyId: string;
}): Promise<boolean> {
  const updated = await dbQuery<{ id: string }>(
    `
    UPDATE resource_api_keys k
       SET is_active = FALSE
      FROM dashboard_user_resource_keys l
     WHERE k.id = l.resource_key_id
       AND l.user_id = $1
       AND k.id = $2
       AND k.is_active = TRUE
    RETURNING k.id
    `,
    [args.userId, args.resourceKeyId],
  );
  return updated.length > 0;
}
