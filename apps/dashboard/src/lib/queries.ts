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
    };
  }
  const rows = await dbQuery<{
    total: string;
    settled: string;
    failed: string;
    volume: string;
    networks: string;
  }>(
    `
    SELECT
      COUNT(*)::text                                                 AS total,
      COUNT(*) FILTER (WHERE status = 'settled')::text               AS settled,
      COUNT(*) FILTER (WHERE status = 'failed')::text                AS failed,
      COALESCE(SUM(amount::numeric) FILTER (WHERE status = 'settled'), 0)::text AS volume,
      COUNT(DISTINCT network)::text                                  AS networks
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
  };
}

export interface SettleRow {
  id: string;
  createdAt: string;          // ISO
  network: string;            // CAIP-2
  asset: string;
  amount: string;             // atomic
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
    status: SettleRow["status"];
    tx_hash: string | null;
    adapter_used: string | null;
    error_code: string | null;
  }>(
    `
    SELECT id, created_at, network, asset, amount, status, tx_hash,
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
    status: r.status,
    txHash: r.tx_hash,
    adapterUsed: r.adapter_used,
    errorCode: r.error_code,
  }));
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
}

export async function listLinkedKeysWithLabel(
  userId: string,
): Promise<LinkedKeyInfo[]> {
  const rows = await dbQuery<{
    resource_key_id: string;
    label: string;
    linked_at: Date;
    is_active: boolean;
  }>(
    `
    SELECT k.id AS resource_key_id, k.label, l.linked_at, k.is_active
    FROM dashboard_user_resource_keys l
    JOIN resource_api_keys k ON k.id = l.resource_key_id
    WHERE l.user_id = $1
    ORDER BY l.linked_at DESC
    `,
    [userId],
  );
  return rows.map((r) => ({
    resourceKeyId: r.resource_key_id,
    label: r.label,
    linkedAt: r.linked_at.toISOString(),
    isActive: r.is_active,
  }));
}

/**
 * Validate a plaintext resource key against `resource_api_keys.key_hash`
 * and link it to the dashboard user. The key_hash column stores
 * `sha256(plaintext)` hex (see apps/api's plugin code). Returns
 * the resource key id + label on success, null if the key is unknown
 * or inactive.
 */
import { createHash, randomUUID } from "node:crypto";

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
