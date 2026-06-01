/**
 * Activity + summary queries powering the admin /dashboard/wallets
 * routes. Two layers:
 *
 *   - per-wallet activity:   inbound + outbound x402 settles from
 *     `facilitator_payments`, plus swap_transactions + pending
 *     swap_refunds when the wallet is a swap-kind wallet. Returned
 *     as a unified time-ordered event stream so the UI can render
 *     "recent across all wallets" without further glue.
 *
 *   - aggregate summary:      operational-capital snapshot (sum of
 *     USDC across all SuVerse wallets, expensive — done in-RPC by
 *     the route handler), fees-earned for today/week/month from
 *     `swap_transactions.fee_amount WHERE status='completed'`,
 *     pending refund total, and a 30-day fees-per-day series for
 *     the bar chart.
 *
 * The orphan-USD figure is left to commit E; this file leaves a
 * hook (`orphanTokensUsd`) defaulting to "0" so the response shape
 * is stable.
 */

import { dbQuery } from "./db";
import { SUVERSE_WALLETS } from "./suverse-wallets";

/** USD value of one USDC atomic unit, expressed in USDC atomic. */
const USDC_DECIMALS = 6;

export type ActivityKind =
  | "x402_in"
  | "x402_out"
  | "swap_quoted"
  | "swap_completed"
  | "swap_failed"
  | "refund_pending"
  | "refund_voided";

export interface ActivityEvent {
  /** ISO timestamp; the stream is sorted desc by this. */
  occurredAt: string;
  /** Stable id (table name + pk) — lets the UI dedupe across refreshes. */
  id: string;
  walletId: string;
  kind: ActivityKind;
  /**
   * Amount in atomic USDC for x402 settles + swap fees + refunds;
   * for swap_quoted / swap_completed it's the input amount in USDC.
   * The UI renders by dividing by 1e6.
   */
  amountUsdcAtomic: string;
  /**
   * Counterparty / route hint: payer address for x402_in, recipient
   * for x402_out, output_token for swap events, buyer for refunds.
   */
  counterparty: string | null;
  /** Tx hash where one exists; nullable for quote events. */
  txHash: string | null;
  /** Free-form short subtitle ("Sushi route", "RPC retry race"). */
  detail: string | null;
}

/**
 * Load up to `limit` recent events touching one wallet, sorted
 * newest first. Pull each source table independently, then merge
 * + sort in app code — small N keeps the merge cheap and avoids
 * an opinionated UNION that's hard to extend.
 */
export async function loadWalletActivity(
  walletId: string,
  days: number,
  limit: number,
): Promise<ActivityEvent[]> {
  const wallet = SUVERSE_WALLETS.find((w) => w.id === walletId);
  if (!wallet) return [];

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const events: ActivityEvent[] = [];

  // facilitator_payments — match by recipient or payer (`payer` is
  // nullable; coalesce to empty string so the `=` works either way).
  const fpRows = await dbQuery<{
    id: string;
    created_at: Date;
    direction: string;
    payer: string | null;
    recipient: string;
    gross_amount: string;
    tx_hash: string | null;
    asset: string;
    status: string;
  }>(
    `SELECT id, created_at, direction, payer, recipient, gross_amount, tx_hash, asset, status
       FROM facilitator_payments
      WHERE created_at >= $1
        AND (lower(recipient) = lower($2) OR lower(coalesce(payer, '')) = lower($2))
      ORDER BY created_at DESC
      LIMIT $3`,
    [since, wallet.address, limit],
  );
  for (const r of fpRows) {
    const isIn = r.recipient.toLowerCase() === wallet.address.toLowerCase();
    events.push({
      id: `fp:${r.id}`,
      occurredAt: r.created_at.toISOString(),
      walletId: wallet.id,
      kind: isIn ? "x402_in" : "x402_out",
      amountUsdcAtomic: r.gross_amount,
      counterparty: isIn ? r.payer : r.recipient,
      txHash: r.tx_hash,
      detail: `${r.status}/${r.asset}`,
    });
  }

  // swap_transactions and swap_refunds only apply to swap wallets.
  if (wallet.kind === "swap") {
    const network = wallet.id === "base-swap"
      ? "eip155:8453"
      : "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    const stRows = await dbQuery<{
      id: string;
      created_at: Date;
      completed_at: Date | null;
      status: string;
      input_amount: string;
      fee_amount: string | null;
      output_token: string;
      swap_tx_hash: string | null;
      error: string | null;
    }>(
      `SELECT id, created_at, completed_at, status, input_amount, fee_amount,
              output_token, swap_tx_hash, error
         FROM swap_transactions
        WHERE created_at >= $1 AND network = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [since, network, limit],
    );
    for (const r of stRows) {
      const ts = (r.completed_at ?? r.created_at).toISOString();
      let kind: ActivityKind = "swap_quoted";
      if (r.status === "completed") kind = "swap_completed";
      else if (r.status === "failed" || r.status === "failed_slippage")
        kind = "swap_failed";
      events.push({
        id: `st:${r.id}`,
        occurredAt: ts,
        walletId: wallet.id,
        kind,
        amountUsdcAtomic: r.input_amount,
        counterparty: r.output_token,
        txHash: r.swap_tx_hash,
        detail: r.error ?? r.status,
      });
    }

    const refRows = await dbQuery<{
      id: string;
      created_at: Date;
      buyer_address: string;
      amount: string;
      status: string;
      reason: string | null;
      refund_tx_hash: string | null;
    }>(
      `SELECT r.id, r.created_at, r.buyer_address, r.amount, r.status, r.reason,
              r.refund_tx_hash
         FROM swap_refunds r
         JOIN swap_transactions s ON s.id = r.swap_id
        WHERE r.created_at >= $1 AND s.network = $2
        ORDER BY r.created_at DESC
        LIMIT $3`,
      [since, network, limit],
    );
    for (const r of refRows) {
      events.push({
        id: `rf:${r.id}`,
        occurredAt: r.created_at.toISOString(),
        walletId: wallet.id,
        kind: r.status === "voided" ? "refund_voided" : "refund_pending",
        amountUsdcAtomic: r.amount,
        counterparty: r.buyer_address,
        txHash: r.refund_tx_hash,
        detail: r.reason,
      });
    }
  }

  events.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  return events.slice(0, limit);
}

// ----------------------------------------------------- aggregates -----

export interface FeesByPeriod {
  todayAtomic: string;
  weekAtomic: string;
  monthAtomic: string;
  /** Day-by-day series for the last 30 days, oldest first. */
  daily: Array<{ date: string; feeAtomic: string }>;
}

/**
 * Sum fee_amount from completed swaps over 3 trailing windows
 * (today UTC, last 7 days, last 30 days) plus a daily series for
 * the 30-day chart. One SQL with GROUP BY + a follow-up roll-up
 * keeps this to a single round-trip.
 */
export async function loadFeesByPeriod(): Promise<FeesByPeriod> {
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const rows = await dbQuery<{ day: string; fees: string }>(
    `SELECT to_char(date_trunc('day', completed_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
            sum(fee_amount)::text AS fees
       FROM swap_transactions
      WHERE status = 'completed'
        AND completed_at IS NOT NULL
        AND completed_at >= $1
      GROUP BY day
      ORDER BY day`,
    [since30],
  );

  const map = new Map<string, bigint>();
  for (const r of rows) map.set(r.day, BigInt(r.fees ?? "0"));

  const daily: FeesByPeriod["daily"] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const day = d.toISOString().slice(0, 10);
    daily.push({ date: day, feeAtomic: (map.get(day) ?? 0n).toString() });
  }

  const today = new Date().toISOString().slice(0, 10);
  const week = sumRange(daily, 7);
  const month = sumRange(daily, 30);
  return {
    todayAtomic: (map.get(today) ?? 0n).toString(),
    weekAtomic: week,
    monthAtomic: month,
    daily,
  };
}

function sumRange(daily: ReadonlyArray<{ feeAtomic: string }>, days: number): string {
  const slice = daily.slice(-days);
  let total = 0n;
  for (const d of slice) total += BigInt(d.feeAtomic);
  return total.toString();
}

export interface PendingRefundsAggregate {
  countRows: number;
  totalAtomic: string;
}

export async function loadPendingRefunds(): Promise<PendingRefundsAggregate> {
  const rows = await dbQuery<{ count: string; total: string | null }>(
    `SELECT count(*)::text AS count, coalesce(sum(amount), 0)::text AS total
       FROM swap_refunds
      WHERE status = 'pending'`,
  );
  const r = rows[0]!;
  return { countRows: Number(r.count), totalAtomic: r.total ?? "0" };
}

export interface TopActiveWallet {
  walletId: string;
  events24h: number;
  netUsdcAtomic: string;
}

/**
 * Top active wallets across the last 24h. Counts facilitator_payments
 * touching the wallet (inbound + outbound) and tallies net USDC.
 */
export async function loadTopActiveWallets(): Promise<TopActiveWallet[]> {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const out: TopActiveWallet[] = [];
  for (const w of SUVERSE_WALLETS) {
    const rows = await dbQuery<{ events: string; net: string }>(
      `SELECT count(*)::text AS events,
              coalesce(sum(CASE WHEN lower(recipient) = lower($2) THEN gross_amount
                                ELSE -gross_amount END), 0)::text AS net
         FROM facilitator_payments
        WHERE created_at >= $1
          AND (lower(recipient) = lower($2) OR lower(coalesce(payer,'')) = lower($2))`,
      [since, w.address],
    );
    const r = rows[0]!;
    out.push({
      walletId: w.id,
      events24h: Number(r.events),
      netUsdcAtomic: r.net,
    });
  }
  out.sort((a, b) => b.events24h - a.events24h);
  return out.slice(0, 5);
}

export { USDC_DECIMALS };
