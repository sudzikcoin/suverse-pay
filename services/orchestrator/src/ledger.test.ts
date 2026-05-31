import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PaymentLedger } from "./ledger.js";
import { createTestStack, type TestStack } from "./_test-helpers.js";
import type {
  AttemptOutcome,
  PaymentInitialFields,
  RoutingDecision,
} from "./types.js";

let stack: TestStack;
let ledger: PaymentLedger;

const INITIAL: PaymentInitialFields = {
  network: "cosmos:noble-1",
  asset: "uusdc",
  amount: "10000",
  recipient: "noble1recipient",
  resource: "https://api.example.test/x",
  requestBody: { hello: "world" },
};

beforeEach(async () => {
  stack = await createTestStack();
  ledger = new PaymentLedger(stack.pool, stack.redis);
});

afterEach(async () => {
  await stack.close();
});

describe("PaymentLedger.createOrFetchPayment — single request", () => {
  it("creates a new payment when no idempotency key is supplied", async () => {
    const result = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      initialRow: INITIAL,
    });
    expect(result.isNew).toBe(true);
    expect(result.lockKey).toBeNull();
    expect(result.payment.status).toBe("pending");
    expect(result.payment.network).toBe("cosmos:noble-1");
    expect(result.payment.amount).toBe("10000");
    expect(result.payment.idempotencyKey).toBeUndefined();
  });

  it("creates a new payment WITH idempotency key, returns lockKey", async () => {
    const result = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      idempotencyKey: "client-key-001",
      initialRow: INITIAL,
    });
    expect(result.isNew).toBe(true);
    expect(result.lockKey).toBe(`idem:${stack.apiKeyId}:client-key-001`);
    // Lock should exist in Redis.
    const v = await stack.redis.get(result.lockKey!);
    expect(v).toBe(result.payment.paymentId);
  });
});

describe("PaymentLedger — idempotency replay (sequential)", () => {
  it("second call with same key returns the FIRST payment, isNew=false", async () => {
    const first = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      idempotencyKey: "k-1",
      initialRow: INITIAL,
    });
    await ledger.releaseLock(first.lockKey!);

    const second = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      idempotencyKey: "k-1",
      initialRow: INITIAL,
    });
    expect(second.isNew).toBe(false);
    expect(second.payment.paymentId).toBe(first.payment.paymentId);
    expect(second.lockKey).toBeNull();
  });

  it("releaseLock removes the Redis entry", async () => {
    const first = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      idempotencyKey: "k-2",
      initialRow: INITIAL,
    });
    await ledger.releaseLock(first.lockKey!);
    const v = await stack.redis.get(first.lockKey!);
    expect(v).toBeNull();
  });

  it("different api_key_id with same idempotency key are independent", async () => {
    // Seed a second api_key row.
    await stack.pool.query(
      `INSERT INTO api_keys (id, key_hash) VALUES ('apikey_other', 'h2')`,
    );

    const a = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      idempotencyKey: "shared",
      initialRow: INITIAL,
    });
    await ledger.releaseLock(a.lockKey!);

    const b = await ledger.createOrFetchPayment({
      apiKeyId: "apikey_other",
      idempotencyKey: "shared",
      initialRow: INITIAL,
    });
    expect(b.isNew).toBe(true);
    expect(b.payment.paymentId).not.toBe(a.payment.paymentId);
  });
});

describe("PaymentLedger — idempotency race (Promise.all)", () => {
  it("two concurrent requests with the same key — exactly one creates the payment", async () => {
    // Promise.all both with the same idempotency key. Whichever acquires
    // the lock first writes the row; the other observes the lock miss,
    // polls for the row, and returns isNew=false. After release, both
    // calls have resolved with the SAME paymentId.
    const [a, b] = await Promise.all([
      ledger.createOrFetchPayment({
        apiKeyId: stack.apiKeyId,
        idempotencyKey: "race-1",
        initialRow: INITIAL,
      }),
      ledger.createOrFetchPayment({
        apiKeyId: stack.apiKeyId,
        idempotencyKey: "race-1",
        initialRow: INITIAL,
      }),
    ]);

    const newCount = [a, b].filter((r) => r.isNew).length;
    expect(newCount).toBe(1);
    expect(a.payment.paymentId).toBe(b.payment.paymentId);
    const winner = a.isNew ? a : b;
    expect(winner.lockKey).toBe(`idem:${stack.apiKeyId}:race-1`);
    // Only one DB row exists for this key.
    const all = await stack.pool.query(
      `SELECT id FROM payments WHERE api_key_id = $1 AND idempotency_key = $2`,
      [stack.apiKeyId, "race-1"],
    );
    expect(all.rows).toHaveLength(1);
  });

  it("ten parallel duplicate requests still resolve to a single payment row", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ledger.createOrFetchPayment({
          apiKeyId: stack.apiKeyId,
          idempotencyKey: "race-10",
          initialRow: INITIAL,
        }),
      ),
    );
    const winners = results.filter((r) => r.isNew);
    expect(winners).toHaveLength(1);
    const ids = new Set(results.map((r) => r.payment.paymentId));
    expect(ids.size).toBe(1);
    const rows = await stack.pool.query(
      `SELECT id FROM payments WHERE api_key_id = $1 AND idempotency_key = $2`,
      [stack.apiKeyId, "race-10"],
    );
    expect(rows.rows).toHaveLength(1);
  });
});

describe("PaymentLedger — attempt lifecycle", () => {
  it("startAttempt writes a pending row immediately", async () => {
    const p = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      initialRow: INITIAL,
    });
    await ledger.startAttempt(p.payment.paymentId, "cosmos-pay", 1);
    const rows = await stack.pool.query(
      `SELECT outcome FROM payment_attempts WHERE payment_id = $1`,
      [p.payment.paymentId],
    );
    expect(rows.rows[0]!.outcome).toBe("pending");
  });

  it("finishAttempt updates to terminal outcome with the recorded details", async () => {
    const p = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      initialRow: INITIAL,
    });
    await ledger.startAttempt(p.payment.paymentId, "cosmos-pay", 1);
    const finished: AttemptOutcome = {
      attemptNumber: 1,
      providerId: "cosmos-pay",
      startedAt: new Date(),
      completedAt: new Date(),
      outcome: "success",
      latencyMs: 250,
      txHash: "0xabc",
    };
    await ledger.finishAttempt(p.payment.paymentId, 1, finished);
    const attempts = await ledger.listAttempts(p.payment.paymentId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe("success");
    expect(attempts[0]!.latencyMs).toBe(250);
  });

  it("listAttempts returns attempts ordered by attempt_number", async () => {
    const p = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      initialRow: INITIAL,
    });
    await ledger.startAttempt(p.payment.paymentId, "cosmos-pay", 1);
    await ledger.startAttempt(p.payment.paymentId, "coinbase-cdp", 2);
    await ledger.finishAttempt(p.payment.paymentId, 1, {
      attemptNumber: 1,
      providerId: "cosmos-pay",
      startedAt: new Date(),
      completedAt: new Date(),
      outcome: "failed",
      latencyMs: 100,
      errorCode: "rate_limited",
    });
    await ledger.finishAttempt(p.payment.paymentId, 2, {
      attemptNumber: 2,
      providerId: "coinbase-cdp",
      startedAt: new Date(),
      completedAt: new Date(),
      outcome: "success",
      latencyMs: 200,
    });
    const attempts = await ledger.listAttempts(p.payment.paymentId);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
  });
});

describe("PaymentLedger.finalizePayment", () => {
  it("updates payment fields after settlement", async () => {
    const p = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      initialRow: INITIAL,
    });
    const settledAt = new Date();
    await ledger.finalizePayment(p.payment.paymentId, {
      status: "settled",
      finalProviderId: "cosmos-pay",
      txHash: "0xabc",
      payer: "noble1payer",
      settledAt,
    });
    const after = await ledger.findById(p.payment.paymentId);
    expect(after?.status).toBe("settled");
    expect(after?.finalProviderId).toBe("cosmos-pay");
    expect(after?.txHash).toBe("0xabc");
    expect(after?.payer).toBe("noble1payer");
    expect(after?.settledAt).toBeInstanceOf(Date);
  });
});

describe("PaymentLedger — protocol field (Phase 2 T7)", () => {
  // x402 is the default protocol; existing call sites that omit
  // `protocol` keep working unchanged. MPP writes opt in via
  // protocol="mpp" together with mppMethod + mppIntent.

  it("defaults protocol to x402 when omitted from initialRow", async () => {
    const result = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      initialRow: INITIAL,
    });
    expect(result.payment.protocol).toBe("x402");
    expect(result.payment.mppMethod).toBeUndefined();
    expect(result.payment.mppIntent).toBeUndefined();
  });

  it("persists protocol=mpp + mppMethod + mppIntent and reads them back via findById", async () => {
    const result = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      initialRow: {
        ...INITIAL,
        protocol: "mpp",
        mppMethod: "tempo",
        mppIntent: "charge",
        network: "eip155:42431",
        asset: "0x20c0000000000000000000000000000000000000",
      },
    });
    expect(result.payment.protocol).toBe("mpp");
    expect(result.payment.mppMethod).toBe("tempo");
    expect(result.payment.mppIntent).toBe("charge");
    const refetched = await ledger.findById(result.payment.paymentId);
    expect(refetched?.protocol).toBe("mpp");
    expect(refetched?.mppMethod).toBe("tempo");
    expect(refetched?.mppIntent).toBe("charge");
  });

  it("rejects protocol=mpp rows that omit mppMethod (invariant guard)", async () => {
    await expect(
      ledger.createOrFetchPayment({
        apiKeyId: stack.apiKeyId,
        initialRow: {
          ...INITIAL,
          protocol: "mpp",
          mppIntent: "charge",
        },
      }),
    ).rejects.toThrow(/mppMethod \+ mppIntent/);
  });

  it("rejects x402 rows that include MPP fields (invariant guard)", async () => {
    await expect(
      ledger.createOrFetchPayment({
        apiKeyId: stack.apiKeyId,
        initialRow: {
          ...INITIAL,
          mppMethod: "tempo",
        },
      }),
    ).rejects.toThrow(/reserved for protocol=mpp/);
  });
});

describe("PaymentLedger.recordRoutingDecision", () => {
  it("inserts a routing_decisions row capturing candidate + scores", async () => {
    const p = await ledger.createOrFetchPayment({
      apiKeyId: stack.apiKeyId,
      initialRow: INITIAL,
    });
    const decision: RoutingDecision = {
      candidates: [
        { providerId: "cosmos-pay", rank: 0, score: 0.0001, reason: "lowest_cost" },
        { providerId: "coinbase-cdp", rank: 1, score: 0.001, reason: "lowest_cost" },
      ],
      selected: "cosmos-pay",
      policyUsed: { optimize: "cost", fallback: true, maxAttempts: 3 },
      optimize: "cost",
      decidedAt: new Date(),
    };
    await ledger.recordRoutingDecision(p.payment.paymentId, decision);
    const rows = await stack.pool.query(
      `SELECT selected_provider_id, policy, scores FROM routing_decisions WHERE payment_id = $1`,
      [p.payment.paymentId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.selected_provider_id).toBe("cosmos-pay");
  });
});
