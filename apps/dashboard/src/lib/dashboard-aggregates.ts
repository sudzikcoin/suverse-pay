/**
 * Shared SQL + helpers for the redesigned dashboard overview.
 *
 * Everything here is gated by the calling user's set of linked
 * resource keys — never returns data across tenants. The
 * "external vs self" split is driven by SELF_WALLETS, the set of
 * Claude- / SuVerse-owned test wallets that produce smoke-test
 * payments. Payments from any other payer count as external.
 */

import { dbQuery } from "./db";

/**
 * Hardcoded list of internal payer addresses. Used to split
 * dashboard revenue into "external" (real buyers) vs "self"
 * (smoke tests + automated catalog probes). The list is small
 * enough that an ANY($::text[]) NOT IN check is essentially free.
 *
 * Maintained alongside the buyer/service-wallet memory entries —
 * any new tester wallet should be appended here so it doesn't
 * inflate the "external revenue" numbers shown on the dashboard.
 */
export const SELF_WALLETS: ReadonlyArray<string> = [
  "0x3869dE7597bDEa0172B97143f3eed806D8b84bf3",
  "0x09939648B56A776de9783eaE750A7fBE725761f1",
  "8Hy7D9NAiB9FDjS4wU3LhWu6EEQE6AE5xFaBxgyyYai6",
  "noble1r56pr4wl0f305m38var66jkqdh8ve2ue89pcm0",
  "26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D",
  "HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw",
];

export type Period = "24h" | "7d" | "30d" | "all";

export function periodToSince(p: Period, now: Date = new Date()): Date | null {
  if (p === "all") return null;
  const ms =
    p === "24h" ? 86_400_000 : p === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
  return new Date(now.getTime() - ms);
}

export interface RevenueSummary {
  period: Period;
  totalRevenueAtomic: string;       // gross_amount sum, settled only
  externalRevenueAtomic: string;
  selfRevenueAtomic: string;
  totalSettles: number;
  externalSettles: number;
  uniqueExternalPayers: number;
}

/**
 * Aggregate revenue & settle counts split external vs self.
 *
 * Only settled rows are counted. Testnet rows are excluded by
 * default so the headline number reflects real money. Pass
 * `includeTestnet=true` to include them (mirrors existing
 * dashboard convention from /api/stats).
 */
export async function loadRevenueSummary(args: {
  resourceKeyIds: ReadonlyArray<string>;
  since: Date | null;
  includeTestnet?: boolean;
}): Promise<RevenueSummary> {
  if (args.resourceKeyIds.length === 0) {
    return {
      period: "24h",
      totalRevenueAtomic: "0",
      externalRevenueAtomic: "0",
      selfRevenueAtomic: "0",
      totalSettles: 0,
      externalSettles: 0,
      uniqueExternalPayers: 0,
    };
  }
  const sinceClause = args.since ? "AND fp.created_at >= $3" : "";
  const testClause = args.includeTestnet ? "" : "AND fp.is_test = FALSE";
  const params: unknown[] = [args.resourceKeyIds, SELF_WALLETS];
  if (args.since) params.push(args.since);
  const rows = await dbQuery<{
    total_revenue: string;
    external_revenue: string;
    self_revenue: string;
    total_settles: string;
    external_settles: string;
    unique_external_payers: string;
  }>(
    `
    SELECT
      COALESCE(SUM(fp.gross_amount) FILTER (WHERE fp.status = 'settled'), 0)::text
        AS total_revenue,
      COALESCE(SUM(fp.gross_amount) FILTER (
        WHERE fp.status = 'settled'
          AND (fp.payer IS NULL OR fp.payer <> ALL($2::text[]))
      ), 0)::text AS external_revenue,
      COALESCE(SUM(fp.gross_amount) FILTER (
        WHERE fp.status = 'settled'
          AND fp.payer = ANY($2::text[])
      ), 0)::text AS self_revenue,
      COUNT(*) FILTER (WHERE fp.status = 'settled')::text AS total_settles,
      COUNT(*) FILTER (
        WHERE fp.status = 'settled'
          AND (fp.payer IS NULL OR fp.payer <> ALL($2::text[]))
      )::text AS external_settles,
      COUNT(DISTINCT fp.payer) FILTER (
        WHERE fp.status = 'settled'
          AND fp.payer IS NOT NULL
          AND fp.payer <> ALL($2::text[])
      )::text AS unique_external_payers
    FROM facilitator_payments fp
    WHERE fp.resource_key_id = ANY($1::text[])
      ${sinceClause}
      ${testClause}
    `,
    params,
  );
  const r = rows[0]!;
  return {
    period: "24h",
    totalRevenueAtomic: r.total_revenue,
    externalRevenueAtomic: r.external_revenue,
    selfRevenueAtomic: r.self_revenue,
    totalSettles: Number(r.total_settles),
    externalSettles: Number(r.external_settles),
    uniqueExternalPayers: Number(r.unique_external_payers),
  };
}

export interface VolumePoint {
  bucket: string; // ISO timestamp of bucket start
  externalVolumeAtomic: string;
  externalSettles: number;
}

/**
 * External-only time series for the volume chart on the redesigned
 * dashboard. 24h period uses hourly buckets, 7d/30d daily.
 *
 * Self-test payments are intentionally excluded — the chart is
 * meant to surface real-buyer activity at a glance, not noise from
 * our own smoke tests.
 */
export async function loadExternalVolumeChart(args: {
  resourceKeyIds: ReadonlyArray<string>;
  since: Date;
  period: Period;
  includeTestnet?: boolean;
}): Promise<VolumePoint[]> {
  if (args.resourceKeyIds.length === 0) return [];
  const bucket = args.period === "24h" ? "hour" : "day";
  const testClause = args.includeTestnet ? "" : "AND fp.is_test = FALSE";
  const rows = await dbQuery<{
    bucket: Date;
    volume: string;
    settles: string;
  }>(
    `
    SELECT
      date_trunc($4, fp.created_at)                                       AS bucket,
      COALESCE(SUM(fp.gross_amount) FILTER (WHERE fp.status = 'settled'), 0)::text AS volume,
      COUNT(*) FILTER (WHERE fp.status = 'settled')::text                  AS settles
    FROM facilitator_payments fp
    WHERE fp.resource_key_id = ANY($1::text[])
      AND fp.created_at >= $2
      AND (fp.payer IS NULL OR fp.payer <> ALL($3::text[]))
      ${testClause}
    GROUP BY date_trunc($4, fp.created_at)
    ORDER BY bucket ASC
    `,
    [args.resourceKeyIds, args.since, SELF_WALLETS, bucket],
  );
  return rows.map((r) => ({
    bucket: r.bucket.toISOString(),
    externalVolumeAtomic: r.volume,
    externalSettles: Number(r.settles),
  }));
}

export interface TopEndpointRow {
  proxyId: string;
  endpointSlug: string;
  displayName: string | null;
  priceAtomic: string;
  internalHandler: string | null;
  externalSettles: number;
  externalRevenueAtomic: string;
}

/**
 * Top-N proxy endpoints ordered by external revenue in [since, now).
 *
 * We aggregate over `proxy_request_logs` because that's the only
 * table that carries `proxy_config_id` — `facilitator_payments` is
 * shared with the non-proxy flow. The join through
 * `facilitator_payment_id` lets us filter by payer and reuse the
 * proper gross/fee/net split.
 */
export async function loadTopEndpoints(args: {
  resourceKeyIds: ReadonlyArray<string>;
  since: Date;
  limit: number;
  includeTestnet?: boolean;
}): Promise<TopEndpointRow[]> {
  if (args.resourceKeyIds.length === 0) return [];
  const testClause = args.includeTestnet ? "" : "AND fp.is_test = FALSE";
  const rows = await dbQuery<{
    proxy_id: string;
    endpoint_slug: string;
    display_name: string | null;
    price_atomic: string;
    internal_handler: string | null;
    external_settles: string;
    external_revenue: string;
  }>(
    `
    SELECT
      c.id                                                                AS proxy_id,
      c.endpoint_slug,
      c.display_name,
      c.price_atomic::text                                                AS price_atomic,
      c.internal_handler,
      COUNT(fp.id)::text                                                  AS external_settles,
      COALESCE(SUM(fp.gross_amount), 0)::text                             AS external_revenue
    FROM proxy_request_logs prl
    JOIN seller_proxy_configs c ON c.id = prl.proxy_config_id
    JOIN facilitator_payments fp ON fp.id = prl.facilitator_payment_id
    WHERE prl.resource_key_id = ANY($1::text[])
      AND fp.created_at >= $2
      AND fp.status = 'settled'
      AND (fp.payer IS NULL OR fp.payer <> ALL($3::text[]))
      ${testClause}
    GROUP BY c.id, c.endpoint_slug, c.display_name, c.price_atomic, c.internal_handler
    ORDER BY SUM(fp.gross_amount) DESC NULLS LAST,
             COUNT(fp.id) DESC
    LIMIT $4
    `,
    [args.resourceKeyIds, args.since, SELF_WALLETS, args.limit],
  );
  return rows.map((r) => ({
    proxyId: r.proxy_id,
    endpointSlug: r.endpoint_slug,
    displayName: r.display_name,
    priceAtomic: r.price_atomic,
    internalHandler: r.internal_handler,
    externalSettles: Number(r.external_settles),
    externalRevenueAtomic: r.external_revenue,
  }));
}

export interface RecentPayment {
  id: string;
  createdAt: string;
  network: string;
  amountAtomic: string;
  payer: string | null;
  txHash: string | null;
  endpointSlug: string | null;
  displayName: string | null;
}

/**
 * Last N settled payments — optionally filtered to external payers
 * only. Joins through `proxy_request_logs` so we can surface the
 * endpoint name; settles that didn't go through a proxy (catalog
 * probes etc.) come back with NULL slug/display.
 */
export async function loadRecentPayments(args: {
  resourceKeyIds: ReadonlyArray<string>;
  limit: number;
  externalOnly: boolean;
  includeTestnet?: boolean;
}): Promise<RecentPayment[]> {
  if (args.resourceKeyIds.length === 0) return [];
  const testClause = args.includeTestnet ? "" : "AND fp.is_test = FALSE";
  const externalClause = args.externalOnly
    ? "AND (fp.payer IS NULL OR fp.payer <> ALL($3::text[]))"
    : "";
  const params: unknown[] = [args.resourceKeyIds, args.limit];
  if (args.externalOnly) params.push(SELF_WALLETS);
  const rows = await dbQuery<{
    id: string;
    created_at: Date;
    network: string;
    amount: string;
    payer: string | null;
    tx_hash: string | null;
    endpoint_slug: string | null;
    display_name: string | null;
  }>(
    `
    SELECT
      fp.id,
      fp.created_at,
      fp.network,
      fp.amount,
      fp.payer,
      fp.tx_hash,
      c.endpoint_slug,
      c.display_name
    FROM facilitator_payments fp
    LEFT JOIN proxy_request_logs prl ON prl.facilitator_payment_id = fp.id
    LEFT JOIN seller_proxy_configs c ON c.id = prl.proxy_config_id
    WHERE fp.resource_key_id = ANY($1::text[])
      AND fp.status = 'settled'
      ${externalClause}
      ${testClause}
    ORDER BY fp.created_at DESC
    LIMIT $2
    `,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at.toISOString(),
    network: r.network,
    amountAtomic: r.amount,
    payer: r.payer,
    txHash: r.tx_hash,
    endpointSlug: r.endpoint_slug,
    displayName: r.display_name,
  }));
}

export interface ProxyListRow {
  id: string;
  resourceKeyId: string;
  endpointSlug: string;
  displayName: string | null;
  priceAtomic: string;
  acceptedNetworks: string[];
  isActive: boolean;
  /** "internal" | "x402-wrap" | "http-proxy". */
  type: "internal" | "x402-wrap" | "http-proxy";
  totalRequests: number;
  settledCount: number;
  errorCount: number;
  externalRevenueAtomic: string;
  selfRevenueAtomic: string;
  externalSettledCount: number;
  lastSettleAt: string | null;
  createdAt: string;
}

/**
 * Single-shot list of every proxy under the user's keys with the
 * stats columns the new /dashboard/proxies table needs.
 *
 * Aggregates over `proxy_request_logs` (per-proxy outcome counts)
 * with a side-join to `facilitator_payments` to split external vs
 * self revenue. Costs one scan + one hash join — sub-second on the
 * current row counts.
 */
export async function loadProxyListWithStats(args: {
  userId: string;
  since: Date;
  includeTestnet?: boolean;
}): Promise<ProxyListRow[]> {
  const testClause = args.includeTestnet
    ? ""
    : "AND (fp.is_test IS NULL OR fp.is_test = FALSE)";
  const rows = await dbQuery<{
    id: string;
    resource_key_id: string;
    endpoint_slug: string;
    display_name: string | null;
    price_atomic: string;
    accepted_networks: string[];
    is_active: boolean;
    internal_handler: string | null;
    upstream_x402_enabled: boolean | null;
    total_requests: string;
    settled_count: string;
    error_count: string;
    external_revenue: string;
    self_revenue: string;
    external_settled: string;
    last_settle_at: Date | null;
    created_at: Date;
  }>(
    `
    SELECT
      c.id,
      c.resource_key_id,
      c.endpoint_slug,
      c.display_name,
      c.price_atomic::text                                                AS price_atomic,
      c.accepted_networks,
      c.is_active,
      c.internal_handler,
      c.upstream_x402_enabled,
      COALESCE(s.total_requests, 0)::text                                 AS total_requests,
      COALESCE(s.settled_count, 0)::text                                  AS settled_count,
      COALESCE(s.error_count,   0)::text                                  AS error_count,
      COALESCE(s.external_revenue, 0)::text                               AS external_revenue,
      COALESCE(s.self_revenue,     0)::text                               AS self_revenue,
      COALESCE(s.external_settled, 0)::text                               AS external_settled,
      s.last_settle_at,
      c.created_at
    FROM seller_proxy_configs c
    JOIN dashboard_user_resource_keys l ON l.resource_key_id = c.resource_key_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)                                                          AS total_requests,
        COUNT(*) FILTER (WHERE prl.outcome = 'settled')                   AS settled_count,
        COUNT(*) FILTER (WHERE prl.outcome IN
                              ('settle_failed','upstream_error',
                               'rate_limited','invalid_config'))          AS error_count,
        COALESCE(SUM(fp.gross_amount) FILTER (
          WHERE prl.outcome = 'settled'
            AND (fp.payer IS NULL OR fp.payer <> ALL($3::text[]))
            ${testClause}
        ), 0)                                                             AS external_revenue,
        COALESCE(SUM(fp.gross_amount) FILTER (
          WHERE prl.outcome = 'settled'
            AND fp.payer = ANY($3::text[])
            ${testClause}
        ), 0)                                                             AS self_revenue,
        COUNT(*) FILTER (
          WHERE prl.outcome = 'settled'
            AND (fp.payer IS NULL OR fp.payer <> ALL($3::text[]))
        )                                                                 AS external_settled,
        MAX(fp.created_at) FILTER (WHERE prl.outcome = 'settled')         AS last_settle_at
      FROM proxy_request_logs prl
      LEFT JOIN facilitator_payments fp ON fp.id = prl.facilitator_payment_id
      WHERE prl.proxy_config_id = c.id
        AND prl.created_at >= $2
    ) s ON TRUE
    WHERE l.user_id = $1
    ORDER BY c.created_at DESC
    `,
    [args.userId, args.since, SELF_WALLETS],
  );
  return rows.map((r) => ({
    id: r.id,
    resourceKeyId: r.resource_key_id,
    endpointSlug: r.endpoint_slug,
    displayName: r.display_name,
    priceAtomic: r.price_atomic,
    acceptedNetworks: r.accepted_networks,
    isActive: r.is_active,
    type: r.internal_handler
      ? "internal"
      : r.upstream_x402_enabled
        ? "x402-wrap"
        : "http-proxy",
    totalRequests: Number(r.total_requests),
    settledCount: Number(r.settled_count),
    errorCount: Number(r.error_count),
    externalRevenueAtomic: r.external_revenue,
    selfRevenueAtomic: r.self_revenue,
    externalSettledCount: Number(r.external_settled),
    lastSettleAt: r.last_settle_at ? r.last_settle_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  }));
}
