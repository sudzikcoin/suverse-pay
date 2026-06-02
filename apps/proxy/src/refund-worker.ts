/**
 * Refund worker — drains pending refund obligations every 5 minutes.
 *
 * Two source tables:
 *
 *   1. `swap_refunds` (mig 026) — created when a SuVerse Swap fails
 *      after the buyer's input was already pulled. We refund the
 *      input token from the swap liquidity wallet that holds it
 *      (SWAP_SOLANA_ADDRESS on Solana, SWAP_BASE_ADDRESS on Base).
 *      The amount/mint to send back comes from a JOIN against
 *      `swap_transactions.input_token`.
 *
 *   2. `refunds_pending` (mig 027) — created when an upstream-x402
 *      wrap call settles on-chain but the upstream returns 500 /
 *      times out. Refund the buyer's inbound payment from the same
 *      swap liquidity wallet (Solana or Base). The token + amount
 *      are stored on the row directly (`buyer_asset`,
 *      `buyer_amount_atomic`).
 *
 * Claim semantics (FOR UPDATE SKIP LOCKED):
 *   - One row at a time, batched up to `batchLimit` per tick.
 *   - The entire row lifecycle (claim → broadcast → mark refunded)
 *     happens inside a single Postgres transaction. The row is
 *     locked from claim until commit, so a second worker (or a
 *     redundant tick) cannot pick the same row.
 *   - Trade-off: if the worker process crashes between broadcast
 *     and UPDATE, the lock is released by the connection drop and
 *     the row is re-picked. If the on-chain transaction already
 *     went out, this is a double-refund. The 5-minute interval and
 *     low broadcast latency make this window small; we accept it
 *     for v1 and document it here. Future hardening: write a
 *     prepared-tx hash to the row before broadcast, dedupe on
 *     replay.
 *
 * Retry semantics:
 *   - Broadcast failures increment `retry_count` and stash the
 *     error in `last_error`.
 *   - At `retry_count >= maxRetries` (default 3) the worker stops
 *     claiming the row and emits a JSON alert line to
 *     `/var/log/suverse-pay/refund-alerts.log` once.
 *   - A `skipped` outcome (chain not configured / unsupported
 *     network) does NOT increment retry_count — those are operator
 *     config issues, not transient failures.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { Address } from "viem";

import type { SolanaSwapChain } from "./swap.js";
import type { BaseSwapChain } from "./swap-base.js";

export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_INITIAL_DELAY_MS = 10_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BATCH_LIMIT = 10;
export const DEFAULT_ALERT_LOG_PATH = "/var/log/suverse-pay/refund-alerts.log";

const SOLANA_CAIP2_PREFIX = "solana:";
const BASE_CAIP2 = "eip155:8453";

export interface RefundWorkerLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface RefundWorkerDeps {
  pool: Pool;
  solanaChain?: SolanaSwapChain;
  baseChain?: BaseSwapChain;
  logger: RefundWorkerLogger;
  alertLogPath?: string;
  intervalMs?: number;
  initialDelayMs?: number;
  maxRetries?: number;
  batchLimit?: number;
}

export interface RefundWorkerHandle {
  /** Stop the timer. In-flight ticks run to completion. */
  stop: () => void;
}

export type RefundOutcome = "refunded" | "failed" | "skipped";

export interface RefundTickResult {
  swapRefunds: RefundCounters;
  refundsPending: RefundCounters;
}

export interface RefundCounters {
  processed: number;
  refunded: number;
  failed: number;
  skipped: number;
}

/**
 * Start the periodic worker. Returns a handle whose `stop()` clears
 * the interval — callers SHOULD invoke it during graceful shutdown.
 */
export function startRefundWorker(deps: RefundWorkerDeps): RefundWorkerHandle {
  const interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const initialDelay = deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  let stopped = false;
  let running = false;

  const tick = (): void => {
    if (stopped || running) return;
    running = true;
    runRefundTick(deps)
      .catch((err) => {
        deps.logger.error(
          `refund-worker: tick crashed: ${(err as Error).message}`,
        );
      })
      .finally(() => {
        running = false;
      });
  };

  const initial = setTimeout(tick, initialDelay);
  const handle = setInterval(tick, interval);

  deps.logger.info(
    `refund-worker: started (interval_ms=${interval}, max_retries=${maxRetries})`,
  );

  return {
    stop: () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(handle);
    },
  };
}

/**
 * Process one tick: drain swap_refunds, then refunds_pending. Each
 * row is processed in its own transaction; failures don't abort the
 * tick.
 */
export async function runRefundTick(
  deps: RefundWorkerDeps,
): Promise<RefundTickResult> {
  const swapRefunds = await drainTable(deps, drainOneSwapRefund);
  const refundsPending = await drainTable(deps, drainOneRefundsPending);
  return { swapRefunds, refundsPending };
}

interface DrainOneResult {
  outcome: RefundOutcome;
  /** Row id — added to the tick-local exclude set when outcome=skipped. */
  id: string;
}

async function drainTable(
  deps: RefundWorkerDeps,
  drainOne: (
    deps: RefundWorkerDeps,
    excludeIds: string[],
  ) => Promise<DrainOneResult | null>,
): Promise<RefundCounters> {
  const batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const stats: RefundCounters = {
    processed: 0,
    refunded: 0,
    failed: 0,
    skipped: 0,
  };
  // Track every row we touched this tick so we don't re-pick it.
  // Successful refunds change status away from 'pending' and would
  // be filtered by the SELECT anyway; skipped rows stay 'pending'
  // (skip is for transient operator config gaps, not row-level
  // failure); failed rows stay 'pending' with retry_count below the
  // cap. We must exclude ALL touched ids — otherwise a one-row tick
  // would burn the entire retry budget in a tight loop instead of
  // spacing attempts across ~5 minute ticks.
  const touchedIds: string[] = [];
  for (let i = 0; i < batchLimit; i++) {
    const result = await drainOne(deps, touchedIds);
    if (result === null) break;
    stats.processed += 1;
    stats[result.outcome] += 1;
    touchedIds.push(result.id);
  }
  return stats;
}

// ----- swap_refunds ----------------------------------------------------------

interface SwapRefundRow {
  id: string;
  swap_id: string;
  buyer_address: string;
  network: string;
  amount: string;
  retry_count: number;
  input_token: string;
}

async function drainOneSwapRefund(
  deps: RefundWorkerDeps,
  excludeIds: string[],
): Promise<DrainOneResult | null> {
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query<SwapRefundRow>(
      `SELECT sr.id::text       AS id,
              sr.swap_id::text  AS swap_id,
              sr.buyer_address,
              sr.network,
              sr.amount::text   AS amount,
              sr.retry_count,
              st.input_token
         FROM swap_refunds sr
         JOIN swap_transactions st ON st.id = sr.swap_id
        WHERE sr.status = 'pending'
          AND sr.retry_count < $1
          AND NOT (sr.id::text = ANY($2::text[]))
        ORDER BY sr.created_at
        FOR UPDATE OF sr SKIP LOCKED
        LIMIT 1`,
      [maxRetries, excludeIds],
    );
    if (claim.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }
    const row = claim.rows[0]!;
    const result = await broadcastSwapRefund(deps, row);

    if (result.kind === "skip") {
      await client.query(
        `UPDATE swap_refunds
            SET last_retry_at = NOW(),
                last_error    = $1
          WHERE id = $2`,
        [result.reason, row.id],
      );
      await client.query("COMMIT");
      deps.logger.warn(
        `refund-worker: swap_refunds ${row.id} skipped (${result.reason})`,
      );
      return { outcome: "skipped", id: row.id };
    }
    if (result.kind === "error") {
      const next = row.retry_count + 1;
      await client.query(
        `UPDATE swap_refunds
            SET retry_count   = $1,
                last_retry_at = NOW(),
                last_error    = $2
          WHERE id = $3`,
        [next, truncate(result.error.message, 1000), row.id],
      );
      await client.query("COMMIT");
      deps.logger.warn(
        `refund-worker: swap_refunds ${row.id} retry ${next}/${maxRetries}: ${result.error.message}`,
      );
      if (next >= maxRetries) {
        emitAlert(deps, {
          table: "swap_refunds",
          id: row.id,
          buyer: row.buyer_address,
          network: row.network,
          amount: row.amount,
          last_error: result.error.message,
        });
      }
      return { outcome: "failed", id: row.id };
    }
    await client.query(
      `UPDATE swap_refunds
          SET status         = 'refunded',
              refund_tx_hash = $1,
              refunded_at    = NOW()
        WHERE id = $2`,
      [result.txHash, row.id],
    );
    await client.query("COMMIT");
    deps.logger.info(
      `refund-worker: swap_refunds ${row.id} refunded tx=${result.txHash} to=${row.buyer_address}`,
    );
    return { outcome: "refunded", id: row.id };
  } catch (err) {
    await safeRollback(client);
    deps.logger.error(
      `refund-worker: swap_refunds drain crashed: ${(err as Error).message}`,
    );
    return null;
  } finally {
    client.release();
  }
}

type BroadcastResult =
  | { kind: "ok"; txHash: string }
  | { kind: "error"; error: Error }
  | { kind: "skip"; reason: string };

async function broadcastSwapRefund(
  deps: RefundWorkerDeps,
  row: SwapRefundRow,
): Promise<BroadcastResult> {
  if (row.network.startsWith(SOLANA_CAIP2_PREFIX)) {
    if (!deps.solanaChain) {
      return { kind: "skip", reason: "no_solana_chain_configured" };
    }
    try {
      const { signature } = await deps.solanaChain.transferOutput({
        mint: row.input_token,
        amount: BigInt(row.amount),
        recipient: row.buyer_address,
      });
      return { kind: "ok", txHash: signature };
    } catch (err) {
      return { kind: "error", error: err as Error };
    }
  }
  if (row.network === BASE_CAIP2) {
    if (!deps.baseChain) {
      return { kind: "skip", reason: "no_base_chain_configured" };
    }
    try {
      const { txHash } = await deps.baseChain.transferERC20({
        token: row.input_token as Address,
        to: row.buyer_address as Address,
        amount: BigInt(row.amount),
      });
      return { kind: "ok", txHash };
    } catch (err) {
      return { kind: "error", error: err as Error };
    }
  }
  return { kind: "skip", reason: `unsupported_network:${row.network}` };
}

// ----- refunds_pending -------------------------------------------------------

interface RefundsPendingRow {
  id: string;
  buyer_address: string;
  buyer_network: string;
  buyer_asset: string;
  buyer_amount_atomic: string;
  retry_count: number;
}

async function drainOneRefundsPending(
  deps: RefundWorkerDeps,
  excludeIds: string[],
): Promise<DrainOneResult | null> {
  const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query<RefundsPendingRow>(
      `SELECT id,
              buyer_address,
              buyer_network,
              buyer_asset,
              buyer_amount_atomic::text AS buyer_amount_atomic,
              retry_count
         FROM refunds_pending
        WHERE status = 'pending'
          AND retry_count < $1
          AND NOT (id::text = ANY($2::text[]))
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [maxRetries, excludeIds],
    );
    if (claim.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }
    const row = claim.rows[0]!;
    const result = await broadcastRefundsPending(deps, row);

    if (result.kind === "skip") {
      await client.query(
        `UPDATE refunds_pending
            SET last_retry_at = NOW(),
                last_error    = $1
          WHERE id = $2`,
        [result.reason, row.id],
      );
      await client.query("COMMIT");
      deps.logger.warn(
        `refund-worker: refunds_pending ${row.id} skipped (${result.reason})`,
      );
      return { outcome: "skipped", id: row.id };
    }
    if (result.kind === "error") {
      const next = row.retry_count + 1;
      await client.query(
        `UPDATE refunds_pending
            SET retry_count   = $1,
                last_retry_at = NOW(),
                last_error    = $2
          WHERE id = $3`,
        [next, truncate(result.error.message, 1000), row.id],
      );
      await client.query("COMMIT");
      deps.logger.warn(
        `refund-worker: refunds_pending ${row.id} retry ${next}/${maxRetries}: ${result.error.message}`,
      );
      if (next >= maxRetries) {
        emitAlert(deps, {
          table: "refunds_pending",
          id: row.id,
          buyer: row.buyer_address,
          network: row.buyer_network,
          amount: row.buyer_amount_atomic,
          last_error: result.error.message,
        });
      }
      return { outcome: "failed", id: row.id };
    }
    await client.query(
      `UPDATE refunds_pending
          SET status         = 'refunded',
              refund_tx_hash = $1,
              refunded_at    = NOW()
        WHERE id = $2`,
      [result.txHash, row.id],
    );
    await client.query("COMMIT");
    deps.logger.info(
      `refund-worker: refunds_pending ${row.id} refunded tx=${result.txHash} to=${row.buyer_address}`,
    );
    return { outcome: "refunded", id: row.id };
  } catch (err) {
    await safeRollback(client);
    deps.logger.error(
      `refund-worker: refunds_pending drain crashed: ${(err as Error).message}`,
    );
    return null;
  } finally {
    client.release();
  }
}

async function broadcastRefundsPending(
  deps: RefundWorkerDeps,
  row: RefundsPendingRow,
): Promise<BroadcastResult> {
  if (row.buyer_network.startsWith(SOLANA_CAIP2_PREFIX)) {
    if (!deps.solanaChain) {
      return { kind: "skip", reason: "no_solana_chain_configured" };
    }
    try {
      const { signature } = await deps.solanaChain.transferOutput({
        mint: row.buyer_asset,
        amount: BigInt(row.buyer_amount_atomic),
        recipient: row.buyer_address,
      });
      return { kind: "ok", txHash: signature };
    } catch (err) {
      return { kind: "error", error: err as Error };
    }
  }
  if (row.buyer_network === BASE_CAIP2) {
    if (!deps.baseChain) {
      return { kind: "skip", reason: "no_base_chain_configured" };
    }
    try {
      const { txHash } = await deps.baseChain.transferERC20({
        token: row.buyer_asset as Address,
        to: row.buyer_address as Address,
        amount: BigInt(row.buyer_amount_atomic),
      });
      return { kind: "ok", txHash };
    } catch (err) {
      return { kind: "error", error: err as Error };
    }
  }
  return { kind: "skip", reason: `unsupported_network:${row.buyer_network}` };
}

// ----- helpers ---------------------------------------------------------------

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    /* connection may already be aborted — ignore */
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

interface AlertPayload {
  table: "swap_refunds" | "refunds_pending";
  id: string;
  buyer: string;
  network: string;
  amount: string;
  last_error: string;
}

function emitAlert(deps: RefundWorkerDeps, p: AlertPayload): void {
  const line =
    JSON.stringify({ ts: new Date().toISOString(), ...p }) + "\n";
  const path = deps.alertLogPath ?? DEFAULT_ALERT_LOG_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    /* parent may already exist or be unwritable — appendFileSync will surface it */
  }
  try {
    appendFileSync(path, line, { mode: 0o640 });
  } catch (err) {
    deps.logger.error(
      `refund-worker: failed to write alert log at ${path}: ${(err as Error).message}`,
    );
  }
  deps.logger.error(
    `refund-worker: alert — ${p.table} ${p.id} exhausted retries (${p.last_error})`,
  );
}
