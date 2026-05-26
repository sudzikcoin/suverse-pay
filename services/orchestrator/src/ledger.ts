import type {
  Caip2,
  ErrorCode,
  PaymentStatus,
} from "@suverse-pay/core-types";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { ulid } from "ulidx";
import type {
  AttemptOutcome,
  CreateOrFetchResult,
  FallbackLedgerHooks,
  PaymentInitialFields,
  PaymentRecord,
  RoutingDecision,
} from "./types.js";

const REDIS_LOCK_TTL_SEC = 30;
const REDIS_WAIT_FOR_ROW_DEADLINE_MS = 5_000;
const REDIS_WAIT_POLL_INTERVAL_MS = 100;
const PG_UNIQUE_VIOLATION = "23505";

/**
 * PaymentLedger writes the canonical record of every payment to
 * Postgres (payments, payment_attempts, routing_decisions). The
 * `(api_key_id, idempotency_key)` unique index in `payments` is the
 * authoritative idempotency guarantee. The Redis SETNX lock is a
 * fast-path that prevents two concurrent requests from racing to
 * the unique-constraint check.
 *
 * Implements FallbackLedgerHooks so the FallbackManager can write
 * attempt rows without knowing about Postgres.
 */
export class PaymentLedger implements FallbackLedgerHooks {
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
  ) {}

  /**
   * Two-layer idempotent insert.
   *
   * Returns:
   *   { payment, isNew=true, lockKey } — caller owns the lock and the
   *     settle pipeline should proceed. Caller MUST release the lock
   *     via `releaseLock(lockKey)` when the pipeline finishes.
   *   { payment, isNew=false, lockKey=null } — replay; caller should
   *     return the existing payment's recorded response.
   *
   * Race-resolution sketch:
   *   T0: A SETNX OK, B SETNX FAIL (A holds lock).
   *   T1: A INSERTs row.
   *   T2: A finalizes payment + releases lock.
   *   B sees SETNX fail, queries payments for the same idempotency_key,
   *   finds A's row, returns isNew=false. If B observed the SETNX
   *   miss BEFORE A reached INSERT, it polls payments for up to 5s.
   *   If both happen to attempt INSERT concurrently (lock window
   *   expired), the unique constraint resolves the tie.
   */
  async createOrFetchPayment(input: {
    apiKeyId: string;
    idempotencyKey?: string | undefined;
    initialRow: PaymentInitialFields;
  }): Promise<CreateOrFetchResult> {
    const paymentId = `pay_${ulid()}`;
    let lockKey: string | null = null;

    if (input.idempotencyKey !== undefined) {
      lockKey = `idem:${input.apiKeyId}:${input.idempotencyKey}`;
      const acquired = await this.redis.set(
        lockKey,
        paymentId,
        "EX",
        REDIS_LOCK_TTL_SEC,
        "NX",
      );
      if (acquired !== "OK") {
        const replay = await this.waitForExistingPayment(
          input.apiKeyId,
          input.idempotencyKey,
        );
        return { payment: replay, isNew: false, lockKey: null };
      }
    }

    try {
      const result = await this.pool.query<RawPaymentRow>(
        `INSERT INTO payments (
          id, idempotency_key, api_key_id, status, network, asset, amount,
          recipient, resource, request_body, created_at
        ) VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, NOW())
        RETURNING *`,
        [
          paymentId,
          input.idempotencyKey ?? null,
          input.apiKeyId,
          input.initialRow.network,
          input.initialRow.asset,
          input.initialRow.amount,
          input.initialRow.recipient,
          input.initialRow.resource ?? null,
          JSON.stringify(input.initialRow.requestBody),
        ],
      );
      return {
        payment: rowToPayment(result.rows[0]!),
        isNew: true,
        lockKey,
      };
    } catch (err) {
      if (isUniqueViolation(err) && input.idempotencyKey !== undefined) {
        if (lockKey !== null) await this.redis.del(lockKey);
        const existing = await this.findByIdempotencyKey(
          input.apiKeyId,
          input.idempotencyKey,
        );
        if (existing !== null) {
          return { payment: existing, isNew: false, lockKey: null };
        }
      }
      if (lockKey !== null) await this.redis.del(lockKey);
      throw err;
    }
  }

  private async waitForExistingPayment(
    apiKeyId: string,
    idempotencyKey: string,
  ): Promise<PaymentRecord> {
    const deadline = Date.now() + REDIS_WAIT_FOR_ROW_DEADLINE_MS;
    while (Date.now() < deadline) {
      const existing = await this.findByIdempotencyKey(apiKeyId, idempotencyKey);
      if (existing !== null) return existing;
      await sleep(REDIS_WAIT_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Idempotency lock held for ${apiKeyId}/${idempotencyKey} but no payment row appeared after ${REDIS_WAIT_FOR_ROW_DEADLINE_MS}ms`,
    );
  }

  async releaseLock(lockKey: string): Promise<void> {
    await this.redis.del(lockKey);
  }

  async findById(paymentId: string): Promise<PaymentRecord | null> {
    const result = await this.pool.query<RawPaymentRow>(
      `SELECT * FROM payments WHERE id = $1`,
      [paymentId],
    );
    return result.rows[0] ? rowToPayment(result.rows[0]) : null;
  }

  async findByIdempotencyKey(
    apiKeyId: string,
    idempotencyKey: string,
  ): Promise<PaymentRecord | null> {
    const result = await this.pool.query<RawPaymentRow>(
      `SELECT * FROM payments WHERE api_key_id = $1 AND idempotency_key = $2`,
      [apiKeyId, idempotencyKey],
    );
    return result.rows[0] ? rowToPayment(result.rows[0]) : null;
  }

  async startAttempt(
    paymentId: string,
    providerId: string,
    attemptNumber: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_attempts
        (payment_id, attempt_number, provider_id, outcome, started_at)
       VALUES ($1, $2, $3, 'pending', NOW())`,
      [paymentId, attemptNumber, providerId],
    );
  }

  async finishAttempt(
    paymentId: string,
    attemptNumber: number,
    outcome: AttemptOutcome,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE payment_attempts SET
         outcome = $3,
         error_code = $4,
         error_message = $5,
         latency_ms = $6,
         completed_at = $7
       WHERE payment_id = $1 AND attempt_number = $2`,
      [
        paymentId,
        attemptNumber,
        outcome.outcome,
        outcome.errorCode ?? null,
        outcome.errorMessage ?? null,
        outcome.latencyMs,
        outcome.completedAt,
      ],
    );
  }

  async listAttempts(paymentId: string): Promise<AttemptOutcome[]> {
    const result = await this.pool.query<RawAttemptRow>(
      `SELECT attempt_number, provider_id, outcome, error_code, error_message,
              latency_ms, started_at, completed_at
       FROM payment_attempts
       WHERE payment_id = $1
       ORDER BY attempt_number ASC`,
      [paymentId],
    );
    return result.rows.map(rowToAttempt);
  }

  async finalizePayment(
    paymentId: string,
    fields: {
      status: PaymentStatus;
      finalProviderId?: string;
      txHash?: string;
      payer?: string;
      errorCode?: ErrorCode;
      errorMessage?: string;
      settledAt?: Date;
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE payments SET
         status = $2,
         final_provider_id = $3,
         final_tx_hash = $4,
         payer = $5,
         error_code = $6,
         error_message = $7,
         settled_at = $8
       WHERE id = $1`,
      [
        paymentId,
        fields.status,
        fields.finalProviderId ?? null,
        fields.txHash ?? null,
        fields.payer ?? null,
        fields.errorCode ?? null,
        fields.errorMessage ?? null,
        fields.settledAt ?? null,
      ],
    );
  }

  async recordRoutingDecision(
    paymentId: string,
    decision: RoutingDecision,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO routing_decisions (
         payment_id, candidate_providers, selected_provider_id, policy, scores, decided_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        paymentId,
        JSON.stringify(decision.candidates.map((c) => c.providerId)),
        decision.selected ?? "",
        JSON.stringify(decision.policyUsed),
        JSON.stringify(decision.candidates),
        decision.decidedAt,
      ],
    );
  }
}

interface RawPaymentRow {
  id: string;
  idempotency_key: string | null;
  api_key_id: string;
  status: string;
  network: string;
  asset: string;
  amount: string;
  payer: string | null;
  recipient: string;
  resource: string | null;
  final_provider_id: string | null;
  final_tx_hash: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  settled_at: Date | null;
}

interface RawAttemptRow {
  attempt_number: number;
  provider_id: string;
  outcome: string;
  error_code: string | null;
  error_message: string | null;
  latency_ms: number | null;
  started_at: Date;
  completed_at: Date | null;
}

function rowToPayment(row: RawPaymentRow): PaymentRecord {
  const out: PaymentRecord = {
    paymentId: row.id,
    apiKeyId: row.api_key_id,
    status: row.status as PaymentStatus,
    network: row.network as Caip2,
    asset: row.asset,
    // NUMERIC(78,0) — `pg` returns this as string by default (to preserve
    // precision beyond 2^53). `pg-mem` returns it as a number. Normalize.
    amount: String(row.amount),
    recipient: row.recipient,
    createdAt: row.created_at,
  };
  if (row.idempotency_key !== null) out.idempotencyKey = row.idempotency_key;
  if (row.payer !== null) out.payer = row.payer;
  if (row.resource !== null) out.resource = row.resource;
  if (row.final_provider_id !== null) out.finalProviderId = row.final_provider_id;
  if (row.final_tx_hash !== null) out.txHash = row.final_tx_hash;
  if (row.error_code !== null) out.errorCode = row.error_code as ErrorCode;
  if (row.error_message !== null) out.errorMessage = row.error_message;
  if (row.settled_at !== null) out.settledAt = row.settled_at;
  return out;
}

function rowToAttempt(row: RawAttemptRow): AttemptOutcome {
  const completedAt = row.completed_at ?? row.started_at;
  const out: AttemptOutcome = {
    attemptNumber: row.attempt_number,
    providerId: row.provider_id,
    startedAt: row.started_at,
    completedAt,
    outcome: row.outcome as AttemptOutcome["outcome"],
    latencyMs: row.latency_ms ?? 0,
  };
  if (row.error_code !== null) out.errorCode = row.error_code as ErrorCode;
  if (row.error_message !== null) out.errorMessage = row.error_message;
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: string }).code;
  return code === PG_UNIQUE_VIOLATION;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
