/**
 * Refund bookkeeping for the upstream-x402 wrap flow.
 *
 * When `seller_proxy_configs.upstream_x402_enabled = true` the proxy
 * is both seller (collecting from the buyer) and buyer (paying the
 * upstream). If the upstream succeeds-then-fails (e.g. our X-PAYMENT
 * retry settles on-chain but the upstream returns 500, or the retry
 * times out / network-errors after we've broadcast) the buyer has
 * paid us for a response they will not receive. The honest fix is to
 * refund the buyer.
 *
 * Refund execution itself is operator-driven — separate signer, separate
 * approvals — so the proxy only inserts into `refunds_pending` and
 * lets a worker / dashboard action drain the queue.
 */
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type RefundPendingReason =
  // Upstream-x402 wrap flow: the X-PAYMENT retry failed AFTER our
  // service wallet may have settled on-chain (original migration 027
  // vocabulary).
  | "upstream_post_payment_500"
  | "upstream_post_payment_timeout"
  | "upstream_post_payment_network"
  // Task 57 (Defect B): ANY settled buyer payment whose final
  // response is a failure we caused must enqueue a refund — the
  // original three reasons only covered the upstream-x402 post-retry
  // window, which is how two settled 502s bypassed the queue
  // (morning-report 20260612, payer 0x9CC42f…, $0.30).
  //
  // post_settle_upstream_5xx — the upstream (or internal handler)
  //   answered with a 5xx after the buyer settled.
  | "post_settle_upstream_5xx"
  // post_settle_unreachable — we could not reach the upstream at all
  //   after the buyer settled (fetch threw / 5xx-after-retries).
  | "post_settle_unreachable"
  // post_settle_proxy_error — proxy-side failure after settlement
  //   (header decrypt failed, unknown internal handler, handler
  //   threw, upstream-x402 misconfiguration, challenge unusable).
  | "post_settle_proxy_error";

export interface RecordRefundPendingInput {
  proxyConfigId: string;
  resourceKeyId: string;
  buyerAddress: string;
  buyerNetwork: string;
  buyerAsset: string;
  buyerAmountAtomic: string;
  buyerTxHash: string | null;
  reason: RefundPendingReason;
  upstreamStatus?: number | null;
  upstreamErrorSnippet?: string | null;
  inboundFacilitatorPaymentId?: string | null;
}

/**
 * Insert a row into `refunds_pending`. Idempotent on
 * (proxy_config_id, buyer_tx_hash) when buyer_tx_hash is non-null:
 * the unique partial index lets two paths racing on the same failed
 * upstream call collapse onto a single refund queue entry. When
 * buyer_tx_hash is NULL (rare — facilitator gave us no on-chain
 * reference) the uniqueness guarantee doesn't fire and duplicates are
 * accepted; the operator deduplicates at refund time.
 *
 * Returns the existing or newly-inserted row id so the caller can
 * link it from the request log.
 */
export async function recordRefundPending(
  client: Pool | PoolClient,
  input: RecordRefundPendingInput,
): Promise<string> {
  // The partial unique index doesn't cover NULL tx_hash rows, so the
  // ON CONFLICT clause must reference the same predicate. Two-step
  // insert + lookup keeps the SQL portable across pg versions where
  // partial-index ON CONFLICT support varies.
  const freshId = randomUUID();
  const insert = await client.query<{ id: string }>(
    `INSERT INTO refunds_pending
       (id, proxy_config_id, resource_key_id,
        buyer_address, buyer_network, buyer_asset, buyer_amount_atomic,
        buyer_tx_hash, reason, upstream_status, upstream_error_snippet,
        inbound_facilitator_payment_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10, $11, $12)
     ON CONFLICT (proxy_config_id, buyer_tx_hash)
       WHERE buyer_tx_hash IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      freshId,
      input.proxyConfigId,
      input.resourceKeyId,
      input.buyerAddress,
      input.buyerNetwork,
      input.buyerAsset,
      input.buyerAmountAtomic,
      input.buyerTxHash,
      input.reason,
      input.upstreamStatus ?? null,
      input.upstreamErrorSnippet?.slice(0, 500) ?? null,
      input.inboundFacilitatorPaymentId ?? null,
    ],
  );
  if (insert.rows.length > 0) return insert.rows[0]!.id;

  // Conflict — fetch the existing row (only reachable when
  // buyer_tx_hash is non-null, since the partial index excludes NULL).
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM refunds_pending
      WHERE proxy_config_id = $1 AND buyer_tx_hash = $2
      LIMIT 1`,
    [input.proxyConfigId, input.buyerTxHash],
  );
  if (rows.length === 0) {
    throw new Error(
      "refunds_pending: ON CONFLICT DO NOTHING returned no row but SELECT also found nothing — possible race or schema drift",
    );
  }
  return rows[0]!.id;
}
