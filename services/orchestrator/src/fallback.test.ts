import type {
  DiscoveredCapability,
  GetStatusHints,
  HealthStatus,
  MerchantPolicy,
  ProviderAdapter,
  QuoteRequest,
  QuoteResponse,
  SettleOptions,
  SettleRequest,
  SettleResponse,
  StatusResponse,
  SupportQuery,
  SupportResult,
  VerifyRequest,
  VerifyResponse,
} from "@suverse-pay/core-types";
import { ProviderError } from "@suverse-pay/core-types";
import { describe, expect, it, vi } from "vitest";
import { runFallback } from "./fallback.js";
import type {
  AttemptOutcome,
  FallbackLedgerHooks,
  RegisteredProvider,
} from "./types.js";

interface RecorderEntry {
  paymentId: string;
  attemptNumber: number;
  providerId?: string;
  outcome?: AttemptOutcome;
}

function makeLedger(): {
  ledger: FallbackLedgerHooks;
  starts: RecorderEntry[];
  finishes: RecorderEntry[];
} {
  const starts: RecorderEntry[] = [];
  const finishes: RecorderEntry[] = [];
  return {
    starts,
    finishes,
    ledger: {
      async startAttempt(paymentId, providerId, attemptNumber) {
        starts.push({ paymentId, providerId, attemptNumber });
      },
      async finishAttempt(paymentId, attemptNumber, outcome) {
        finishes.push({ paymentId, attemptNumber, outcome });
      },
    },
  };
}

type SettleBehavior =
  | { kind: "settle"; response: SettleResponse }
  | { kind: "throw"; error: unknown };

function adapter(
  id: string,
  behavior: SettleBehavior,
  opts: { supports?: SupportResult } = {},
): ProviderAdapter {
  return {
    id,
    displayName: id,
    async supports(_q: SupportQuery) {
      return opts.supports ?? { supported: true };
    },
    async quote(req: QuoteRequest): Promise<QuoteResponse> {
      return {
        providerId: id,
        network: req.network,
        asset: req.asset,
        amount: req.amount,
        estimatedFeeUsd: "0.001",
        estimatedLatencyMs: 100,
        scheme: req.scheme,
        source: "synthetic",
      };
    },
    async verify(_req: VerifyRequest): Promise<VerifyResponse> {
      return { valid: true, providerId: id, verifiedAt: new Date().toISOString() };
    },
    async settle(
      _req: SettleRequest,
      _o?: SettleOptions,
    ): Promise<SettleResponse> {
      if (behavior.kind === "throw") throw behavior.error;
      return behavior.response;
    },
    async getStatus(_id: string, _h?: GetStatusHints): Promise<StatusResponse> {
      return { providerId: id, providerPaymentId: "x", status: "settled" };
    },
    async healthCheck(): Promise<HealthStatus> {
      return { status: "healthy", checkedAt: new Date().toISOString() };
    },
    async discoverCapabilities(): Promise<DiscoveredCapability[]> {
      return [];
    },
  };
}

function reg(a: ProviderAdapter): RegisteredProvider {
  return { id: a.id, displayName: a.displayName, enabled: true, config: {}, adapter: a };
}

const policy: MerchantPolicy = {
  optimize: "cost",
  fallback: true,
  maxAttempts: 3,
};

const settleReq: SettleRequest = {
  paymentPayload: {
    x402Version: 2,
    scheme: "exact_cosmos_authz",
    network: "cosmos:noble-1",
    payload: {},
  },
  paymentRequirements: {
    scheme: "exact_cosmos_authz",
    network: "cosmos:noble-1",
    maxAmountRequired: "10000",
    asset: "uusdc",
    payTo: "noble1r",
    resource: "https://x/y",
  },
};

function settleOk(id: string, txHash = "ABC"): SettleResponse {
  return {
    settled: true,
    providerId: id,
    network: "cosmos:noble-1",
    asset: "uusdc",
    amount: "10000",
    txHash,
  };
}

function settleErr(id: string, code: string): SettleResponse {
  return {
    settled: false,
    providerId: id,
    network: "cosmos:noble-1",
    asset: "uusdc",
    amount: "10000",
    errorCode: code as SettleResponse["errorCode"],
    errorMessage: code,
  };
}

describe("runFallback — happy paths", () => {
  it("first provider succeeds → returns response, single attempt", async () => {
    const { ledger, starts, finishes } = makeLedger();
    const result = await runFallback({
      paymentId: "pay_1",
      request: settleReq,
      options: {},
      policy,
      candidates: [reg(adapter("a", { kind: "settle", response: settleOk("a") }))],
      ledger,
    });
    expect(result.finalResponse?.settled).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(starts).toHaveLength(1);
    expect(finishes[0]!.outcome!.outcome).toBe("success");
  });

  it("writes payment_attempts row BEFORE network call (invariant 4)", async () => {
    // Drive an adapter that records the call order vs. the ledger startAttempt.
    const events: string[] = [];
    const ledger: FallbackLedgerHooks = {
      async startAttempt() {
        events.push("ledger.start");
      },
      async finishAttempt() {
        events.push("ledger.finish");
      },
    };
    const tracingAdapter = adapter("a", {
      kind: "settle",
      response: settleOk("a"),
    });
    const origSettle = tracingAdapter.settle.bind(tracingAdapter);
    tracingAdapter.settle = async (...args) => {
      events.push("adapter.settle");
      return origSettle(...args);
    };
    await runFallback({
      paymentId: "pay_1",
      request: settleReq,
      options: {},
      policy,
      candidates: [reg(tracingAdapter)],
      ledger,
    });
    expect(events).toEqual(["ledger.start", "adapter.settle", "ledger.finish"]);
  });

  it("forwards opts.idempotencyKey to adapter.settle on every attempt", async () => {
    const settleSpy = vi.fn(async () => settleOk("a"));
    const a = adapter("a", { kind: "settle", response: settleOk("a") });
    a.settle = settleSpy as typeof a.settle;
    const { ledger } = makeLedger();
    await runFallback({
      paymentId: "pay_x",
      request: settleReq,
      options: { idempotencyKey: "client-key-q" },
      policy,
      candidates: [reg(a)],
      ledger,
    });
    expect(settleSpy).toHaveBeenCalledWith(settleReq, {
      idempotencyKey: "client-key-q",
    });
  });
});

describe("runFallback — fallback behavior", () => {
  it("retryable errorCode → moves to next candidate; second succeeds", async () => {
    const { ledger, starts } = makeLedger();
    const result = await runFallback({
      paymentId: "pay_2",
      request: settleReq,
      options: {},
      policy,
      candidates: [
        reg(adapter("a", { kind: "settle", response: settleErr("a", "provider_internal_error") })),
        reg(adapter("b", { kind: "settle", response: settleOk("b") })),
      ],
      ledger,
    });
    expect(result.finalResponse?.settled).toBe(true);
    expect(result.finalResponse?.providerId).toBe("b");
    expect(starts.map((s) => s.providerId)).toEqual(["a", "b"]);
    expect(result.attempts).toHaveLength(2);
  });

  it("retryable thrown ProviderError → moves to next candidate", async () => {
    const { ledger } = makeLedger();
    const result = await runFallback({
      paymentId: "pay_3",
      request: settleReq,
      options: {},
      policy,
      candidates: [
        reg(
          adapter("a", {
            kind: "throw",
            error: new ProviderError("timeout", "slow"),
          }),
        ),
        reg(adapter("b", { kind: "settle", response: settleOk("b") })),
      ],
      ledger,
    });
    expect(result.finalResponse?.providerId).toBe("b");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.errorCode).toBe("timeout");
  });

  it("non-retryable errorCode → stops, returns the failure as-is", async () => {
    const { ledger, starts } = makeLedger();
    const result = await runFallback({
      paymentId: "pay_4",
      request: settleReq,
      options: {},
      policy,
      candidates: [
        reg(adapter("a", { kind: "settle", response: settleErr("a", "invalid_signature") })),
        reg(adapter("b", { kind: "settle", response: settleOk("b") })),
      ],
      ledger,
    });
    expect(result.finalResponse?.settled).toBe(false);
    expect(result.finalResponse?.errorCode).toBe("invalid_signature");
    expect(starts).toHaveLength(1);
  });

  it("non-retryable thrown ProviderError → stops with synthetic failure response", async () => {
    const { ledger } = makeLedger();
    const result = await runFallback({
      paymentId: "pay_5",
      request: settleReq,
      options: {},
      policy,
      candidates: [
        reg(
          adapter("a", {
            kind: "throw",
            error: new ProviderError("invalid_authorization", "bad nonce"),
          }),
        ),
        reg(adapter("b", { kind: "settle", response: settleOk("b") })),
      ],
      ledger,
    });
    expect(result.finalResponse?.settled).toBe(false);
    expect(result.finalResponse?.errorCode).toBe("invalid_authorization");
    expect(result.attempts).toHaveLength(1);
  });

  it("respects policy.maxAttempts — stops after limit", async () => {
    const { ledger, starts } = makeLedger();
    const result = await runFallback({
      paymentId: "pay_6",
      request: settleReq,
      options: {},
      policy: { ...policy, maxAttempts: 2 },
      candidates: [
        reg(adapter("a", { kind: "settle", response: settleErr("a", "rate_limited") })),
        reg(adapter("b", { kind: "settle", response: settleErr("b", "rate_limited") })),
        reg(adapter("c", { kind: "settle", response: settleOk("c") })),
      ],
      ledger,
    });
    expect(starts.map((s) => s.providerId)).toEqual(["a", "b"]);
    expect(result.finalResponse?.settled).toBe(false);
    expect(result.attempts).toHaveLength(2);
  });

  it("skips a candidate whose supports() now returns false (no attempt row written)", async () => {
    const { ledger, starts } = makeLedger();
    const result = await runFallback({
      paymentId: "pay_7",
      request: settleReq,
      options: {},
      policy,
      candidates: [
        reg(
          adapter(
            "a",
            { kind: "settle", response: settleOk("a") },
            { supports: { supported: false, reason: "quota_exceeded" } },
          ),
        ),
        reg(adapter("b", { kind: "settle", response: settleOk("b") })),
      ],
      ledger,
    });
    expect(starts.map((s) => s.providerId)).toEqual(["b"]);
    expect(result.finalResponse?.providerId).toBe("b");
    expect(result.attempts).toHaveLength(1);
  });
});

describe("runFallback — exhausted candidate list", () => {
  it("all candidates fail retryably → returns last failure", async () => {
    const { ledger } = makeLedger();
    const result = await runFallback({
      paymentId: "pay_8",
      request: settleReq,
      options: {},
      policy: { ...policy, maxAttempts: 3 },
      candidates: [
        reg(adapter("a", { kind: "settle", response: settleErr("a", "rate_limited") })),
        reg(adapter("b", { kind: "settle", response: settleErr("b", "network_error") })),
      ],
      ledger,
    });
    expect(result.finalResponse?.settled).toBe(false);
    expect(result.finalResponse?.errorCode).toBe("network_error");
    expect(result.attempts).toHaveLength(2);
  });

  it("empty candidate list → no attempts, finalResponse null", async () => {
    const { ledger, starts } = makeLedger();
    const result = await runFallback({
      paymentId: "pay_9",
      request: settleReq,
      options: {},
      policy,
      candidates: [],
      ledger,
    });
    expect(starts).toHaveLength(0);
    expect(result.finalResponse).toBeNull();
    expect(result.attempts).toHaveLength(0);
  });
});
