/**
 * Buyer-side data access helpers. Keep query SQL here so route
 * handlers + server components stay focused on auth + rendering.
 *
 * All queries are scoped to a user via their registered buyer_wallets.
 * Returning an empty result when no wallets are registered is the
 * correct behaviour — the UI surfaces an "add a wallet" empty state.
 */

import { dbQuery } from "./db";

export type Mode = "seller" | "buyer";

export interface BuyerWallet {
  id: string;
  networkFamily: "evm" | "solana" | "cosmos" | "tron";
  address: string;
  label: string | null;
  linkedAt: string;
}

export async function getUserMode(userId: string): Promise<Mode> {
  const rows = await dbQuery<{ preferred_mode: Mode }>(
    `SELECT preferred_mode FROM dashboard_users WHERE id = $1`,
    [userId],
  );
  return rows[0]?.preferred_mode ?? "seller";
}

export async function setUserMode(userId: string, mode: Mode): Promise<void> {
  await dbQuery(
    `UPDATE dashboard_users SET preferred_mode = $2 WHERE id = $1`,
    [userId, mode],
  );
}

export async function listWallets(userId: string): Promise<BuyerWallet[]> {
  const rows = await dbQuery<{
    id: string;
    network_family: BuyerWallet["networkFamily"];
    address: string;
    label: string | null;
    linked_at: Date;
  }>(
    `SELECT id, network_family, address, label, linked_at
       FROM buyer_wallets
       WHERE user_id = $1
       ORDER BY linked_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    networkFamily: r.network_family,
    address: r.address,
    label: r.label,
    linkedAt:
      r.linked_at instanceof Date
        ? r.linked_at.toISOString()
        : String(r.linked_at),
  }));
}

/**
 * Returns lowercased addresses (so the EVM/TRON-mixed-case case
 * pastes resolve to the same payer entries on lookup). Solana +
 * Cosmos addresses keep their original case but are also compared
 * case-insensitively at the query layer for convenience.
 */
async function listWalletAddressesLower(userId: string): Promise<string[]> {
  const rows = await dbQuery<{ address: string }>(
    `SELECT lower(address) AS address
       FROM buyer_wallets
       WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.address);
}

export interface BuyerSummary {
  totalAtomic: string;
  txCount: number;
  settledCount: number;
  failedCount: number;
  topEndpoints: Array<{
    recipient: string;
    txCount: number;
    totalAtomic: string;
  }>;
  byNetwork: Array<{ network: string; txCount: number; totalAtomic: string }>;
}

export type SummaryPeriod = "24h" | "7d" | "30d";

const PERIOD_INTERVAL: Record<SummaryPeriod, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/**
 * Aggregate buyer spend over the period. NUMERIC sums come back as
 * strings (preserve BigInt precision; client formats via atomicToUsd).
 */
export async function getBuyerSummary(
  userId: string,
  period: SummaryPeriod,
): Promise<BuyerSummary> {
  const addrs = await listWalletAddressesLower(userId);
  if (addrs.length === 0) {
    return {
      totalAtomic: "0",
      txCount: 0,
      settledCount: 0,
      failedCount: 0,
      topEndpoints: [],
      byNetwork: [],
    };
  }
  const interval = PERIOD_INTERVAL[period];
  const since = new Date(Date.now() - intervalToMs(period));

  const summaryRows = await dbQuery<{
    total_atomic: string | null;
    tx_count: string;
    settled_count: string;
    failed_count: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'settled' THEN amount::numeric ELSE 0 END), 0)::text AS total_atomic,
       COUNT(*)::text AS tx_count,
       COUNT(*) FILTER (WHERE status = 'settled')::text AS settled_count,
       COUNT(*) FILTER (WHERE status = 'failed')::text   AS failed_count
     FROM facilitator_payments
     WHERE lower(payer) = ANY($1::text[])
       AND created_at >= $2`,
    [addrs, since],
  );

  const topRows = await dbQuery<{
    recipient: string;
    tx_count: string;
    total_atomic: string;
  }>(
    `SELECT
       recipient,
       COUNT(*)::text AS tx_count,
       SUM(amount::numeric)::text AS total_atomic
     FROM facilitator_payments
     WHERE lower(payer) = ANY($1::text[])
       AND status = 'settled'
       AND created_at >= $2
     GROUP BY recipient
     ORDER BY SUM(amount::numeric) DESC
     LIMIT 5`,
    [addrs, since],
  );

  const networkRows = await dbQuery<{
    network: string;
    tx_count: string;
    total_atomic: string;
  }>(
    `SELECT
       network,
       COUNT(*)::text AS tx_count,
       SUM(amount::numeric)::text AS total_atomic
     FROM facilitator_payments
     WHERE lower(payer) = ANY($1::text[])
       AND status = 'settled'
       AND created_at >= $2
     GROUP BY network
     ORDER BY SUM(amount::numeric) DESC`,
    [addrs, since],
  );

  const head = summaryRows[0]!;
  // `interval` is captured in PERIOD_INTERVAL but not actually used
  // in the SQL — we compute the `since` cutoff in JS for
  // portability. Kept here for documentation; intentionally
  // referenced to silence the unused-var lint.
  void interval;
  return {
    totalAtomic: head.total_atomic ?? "0",
    txCount: Number(head.tx_count),
    settledCount: Number(head.settled_count),
    failedCount: Number(head.failed_count),
    topEndpoints: topRows.map((r) => ({
      recipient: r.recipient,
      txCount: Number(r.tx_count),
      totalAtomic: r.total_atomic,
    })),
    byNetwork: networkRows.map((r) => ({
      network: r.network,
      txCount: Number(r.tx_count),
      totalAtomic: r.total_atomic,
    })),
  };
}

function intervalToMs(p: SummaryPeriod): number {
  switch (p) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
  }
}
