import type { ClientBase, Pool, PoolClient } from "pg";
import { ulid } from "ulidx";

export type FacilitatorPaymentStatus = "settled" | "failed" | "pending";

export interface CreateFacilitatorPaymentOptions {
  client: ClientBase | PoolClient | Pool;
  resourceKeyId: string;
  idempotencyKey: string;
  network: string;
  asset: string;
  scheme: string;
  amount: string;
  recipient: string;
}

export interface FacilitatorPaymentRow {
  id: string;
  resourceKeyId: string;
  idempotencyKey: string;
  network: string;
  asset: string;
  scheme: string;
  amount: string;
  payer: string | null;
  recipient: string;
  adapterUsed: string | null;
  txHash: string | null;
  status: FacilitatorPaymentStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
  settledAt: Date | null;
}

export interface CreateResult {
  /** True when the row was newly created; false when (resourceKeyId, idempotencyKey) already had a row. */
  isNew: boolean;
  row: FacilitatorPaymentRow;
}

/**
 * Insert a new pending row, or return the existing row when the
 * (resource_key_id, idempotency_key) pair is already present. The
 * route handler short-circuits on `isNew=false` and returns the
 * stored response without re-broadcasting.
 */
export async function createOrFetchFacilitatorPayment(
  opts: CreateFacilitatorPaymentOptions,
): Promise<CreateResult> {
  const id = `fpay_${ulid()}`;
  const insert = await opts.client.query(
    `INSERT INTO facilitator_payments
       (id, resource_key_id, idempotency_key, network, asset, scheme,
        amount, recipient, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
     ON CONFLICT (resource_key_id, idempotency_key) DO NOTHING
     RETURNING id, resource_key_id, idempotency_key, network, asset, scheme,
               amount, payer, recipient, adapter_used, tx_hash, status,
               error_code, error_message, created_at, settled_at`,
    [
      id,
      opts.resourceKeyId,
      opts.idempotencyKey,
      opts.network,
      opts.asset,
      opts.scheme,
      opts.amount,
      opts.recipient,
    ],
  );
  if (insert.rows.length > 0) {
    return { isNew: true, row: rowToFacilitatorPayment(insert.rows[0]) };
  }
  // Conflict — fetch the existing row.
  const { rows } = await opts.client.query(
    `SELECT id, resource_key_id, idempotency_key, network, asset, scheme,
            amount, payer, recipient, adapter_used, tx_hash, status,
            error_code, error_message, created_at, settled_at
       FROM facilitator_payments
      WHERE resource_key_id = $1 AND idempotency_key = $2
      LIMIT 1`,
    [opts.resourceKeyId, opts.idempotencyKey],
  );
  if (rows.length === 0) {
    throw new Error(
      "facilitator_payments insert hit ON CONFLICT but SELECT returned nothing — possible race or DB corruption",
    );
  }
  return { isNew: false, row: rowToFacilitatorPayment(rows[0]) };
}

export interface FinalizeFacilitatorPaymentOptions {
  client: ClientBase | PoolClient | Pool;
  id: string;
  status: FacilitatorPaymentStatus;
  adapterUsed: string;
  payer?: string;
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
}

export async function finalizeFacilitatorPayment(
  opts: FinalizeFacilitatorPaymentOptions,
): Promise<FacilitatorPaymentRow> {
  const { rows } = await opts.client.query(
    `UPDATE facilitator_payments
        SET status = $2,
            adapter_used = $3,
            payer = COALESCE($4, payer),
            tx_hash = COALESCE($5, tx_hash),
            error_code = COALESCE($6, error_code),
            error_message = COALESCE($7, error_message),
            settled_at = CASE WHEN $2 = 'settled' THEN NOW() ELSE settled_at END
      WHERE id = $1
      RETURNING id, resource_key_id, idempotency_key, network, asset, scheme,
                amount, payer, recipient, adapter_used, tx_hash, status,
                error_code, error_message, created_at, settled_at`,
    [
      opts.id,
      opts.status,
      opts.adapterUsed,
      opts.payer ?? null,
      opts.txHash ?? null,
      opts.errorCode ?? null,
      opts.errorMessage ?? null,
    ],
  );
  if (rows.length === 0) {
    throw new Error(`facilitator_payments row not found: ${opts.id}`);
  }
  return rowToFacilitatorPayment(rows[0]);
}

export interface RecordFailoverOptions {
  client: ClientBase | PoolClient | Pool;
  paymentId: string;
  primaryAdapter: string;
  backupAdapter: string;
  primaryErrorCode: string;
  primaryErrorMessage?: string;
}

export async function recordFailoverEvent(
  opts: RecordFailoverOptions,
): Promise<void> {
  await opts.client.query(
    `INSERT INTO facilitator_failover_events
       (payment_id, primary_adapter, backup_adapter, primary_error_code, primary_error_message)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      opts.paymentId,
      opts.primaryAdapter,
      opts.backupAdapter,
      opts.primaryErrorCode,
      opts.primaryErrorMessage ?? null,
    ],
  );
}

function rowToFacilitatorPayment(r: {
  id: string;
  resource_key_id: string;
  idempotency_key: string;
  network: string;
  asset: string;
  scheme: string;
  amount: string;
  payer: string | null;
  recipient: string;
  adapter_used: string | null;
  tx_hash: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  settled_at: Date | null;
}): FacilitatorPaymentRow {
  return {
    id: r.id,
    resourceKeyId: r.resource_key_id,
    idempotencyKey: r.idempotency_key,
    network: r.network,
    asset: r.asset,
    scheme: r.scheme,
    amount: r.amount,
    payer: r.payer,
    recipient: r.recipient,
    adapterUsed: r.adapter_used,
    txHash: r.tx_hash,
    status: r.status as FacilitatorPaymentStatus,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  };
}
