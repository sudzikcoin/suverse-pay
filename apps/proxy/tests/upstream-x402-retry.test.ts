/**
 * Tests for the retry-on-pre-payment-5xx-or-network path and the
 * refund-pending invocation on post-payment failures, added by the
 * "P3" hardening of `upstream-x402.ts`.
 *
 * Each test stubs `fetchImpl` with a programmed response queue, so the
 * retry loop's request count is observable and the back-off sleeps
 * don't slow CI down. We mock setTimeout via vitest's fake timers
 * where the back-off actually fires; the test then drains them with
 * `vi.runAllTimersAsync()`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  callUpstreamWithX402,
  type RefundPendingRecorder,
  type ServiceAddresses,
  type UpstreamX402Deps,
} from "../src/upstream-x402.js";
import type { SuverseClient } from "@suverselabs/x402-client";

const UPSTREAM_URL = "https://upstream.example.com/data";
const SVM_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SVM_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function makeRefundRecorder(): RefundPendingRecorder & {
  record: ReturnType<typeof vi.fn>;
} {
  return { record: vi.fn().mockResolvedValue(undefined) };
}

function makeServiceDeps(
  fetchImpl: typeof fetch,
  refundPendingRecorder: RefundPendingRecorder | undefined = undefined,
): UpstreamX402Deps {
  const addresses: ServiceAddresses = {
    solana: "26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D",
  };
  // The buyer SDK is irrelevant for the retry tests — the tests
  // either resolve before the 402 branch, or stub the signer below.
  const client = {
    signRequirement: vi.fn().mockRejectedValue(
      new Error("signer not wired in this test"),
    ),
  } as unknown as SuverseClient;
  const deps: UpstreamX402Deps = {
    client,
    addresses,
    fetchImpl,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  if (refundPendingRecorder) {
    deps.refundPendingRecorder = refundPendingRecorder;
  }
  return deps;
}

function makeArgs() {
  return {
    upstreamUrl: UPSTREAM_URL,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
    requiredNetwork: SVM_NETWORK,
    maxPriceHumanUsdc: null,
    signerNamespace: "solana",
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function emptyResponse(status: number): Response {
  return new Response("", { status });
}

describe("upstream-x402 pre-payment retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("retries on 5xx and succeeds on the third attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(emptyResponse(502))
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true }),
      ) as unknown as typeof fetch;
    const deps = makeServiceDeps(fetchImpl);

    const promise = callUpstreamWithX402(makeArgs(), deps);
    // Drive the two back-off sleeps (200ms, 800ms) to completion.
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(800);
    const result = await promise;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.kind).toBe("passthrough");
  });

  it("retries on thrown network error and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true }),
      ) as unknown as typeof fetch;
    const deps = makeServiceDeps(fetchImpl);

    const promise = callUpstreamWithX402(makeArgs(), deps);
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("passthrough");
  });

  it("returns upstream_5xx after exhausting retries on persistent 500", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(emptyResponse(500)) as unknown as typeof fetch;
    const deps = makeServiceDeps(fetchImpl);

    const promise = callUpstreamWithX402(makeArgs(), deps);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(800);
    const result = await promise;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("upstream_5xx");
      expect(result.upstreamStatus).toBe(500);
    }
  });

  it("returns network_error after exhausting retries on thrown errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;
    const deps = makeServiceDeps(fetchImpl);

    const promise = callUpstreamWithX402(makeArgs(), deps);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(800);
    const result = await promise;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toBe("network_error");
    }
  });

  it("does NOT retry on 4xx (non-402) — passes through verbatim", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(403, { error: "forbidden" }),
      ) as unknown as typeof fetch;
    const deps = makeServiceDeps(fetchImpl);

    const result = await callUpstreamWithX402(makeArgs(), deps);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("passthrough");
  });

  it("does NOT retry on 200 — single fetch is enough", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(200, { ok: true }),
      ) as unknown as typeof fetch;
    const deps = makeServiceDeps(fetchImpl);

    const result = await callUpstreamWithX402(makeArgs(), deps);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("passthrough");
  });
});

describe("upstream-x402 refund-pending recording", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function challengeBody() {
    return {
      x402Version: 2,
      resource: { url: UPSTREAM_URL },
      accepts: [
        {
          scheme: "exact",
          network: SVM_NETWORK,
          asset: SVM_USDC,
          payTo: "9".repeat(32),
          amount: "10000",
          maxTimeoutSeconds: 60,
        },
      ],
    };
  }

  it("invokes refundPendingRecorder when X-PAYMENT retry returns 500", async () => {
    const fetchImpl = vi
      .fn()
      // Initial fetch returns 402 with a valid challenge.
      .mockResolvedValueOnce(jsonResponse(402, challengeBody()))
      // Retry after we sign and send X-PAYMENT — upstream's app errors.
      .mockResolvedValueOnce(
        jsonResponse(500, { error: "ouch" }),
      ) as unknown as typeof fetch;
    const refund = makeRefundRecorder();
    const deps = makeServiceDeps(fetchImpl, refund);
    // Wire the signer so we reach the retry branch.
    (deps.client.signRequirement as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ envelope: "stub" });

    const result = await callUpstreamWithX402(makeArgs(), deps);

    expect(result.kind).toBe("error");
    expect(refund.record).toHaveBeenCalledTimes(1);
    expect(refund.record.mock.calls[0]![0]).toMatchObject({
      reason: "upstream_post_payment_500",
      upstreamStatus: 500,
    });
  });

  it("invokes refundPendingRecorder with timeout reason when retry aborts", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(402, challengeBody()))
      .mockRejectedValueOnce(
        Object.assign(new Error("operation aborted"), { name: "AbortError" }),
      ) as unknown as typeof fetch;
    const refund = makeRefundRecorder();
    const deps = makeServiceDeps(fetchImpl, refund);
    (deps.client.signRequirement as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ envelope: "stub" });

    const result = await callUpstreamWithX402(makeArgs(), deps);

    expect(result.kind).toBe("error");
    expect(refund.record).toHaveBeenCalledTimes(1);
    expect(refund.record.mock.calls[0]![0]).toMatchObject({
      reason: "upstream_post_payment_timeout",
    });
  });

  it("invokes refundPendingRecorder with network reason on non-abort retry error", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(402, challengeBody()))
      .mockRejectedValueOnce(new Error("ECONNRESET")) as unknown as typeof fetch;
    const refund = makeRefundRecorder();
    const deps = makeServiceDeps(fetchImpl, refund);
    (deps.client.signRequirement as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ envelope: "stub" });

    const result = await callUpstreamWithX402(makeArgs(), deps);

    expect(result.kind).toBe("error");
    expect(refund.record).toHaveBeenCalledTimes(1);
    expect(refund.record.mock.calls[0]![0]).toMatchObject({
      reason: "upstream_post_payment_network",
      upstreamStatus: null,
    });
  });

  it("swallows recorder errors without affecting the upstream result", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(402, challengeBody()))
      .mockResolvedValueOnce(
        jsonResponse(500, { error: "ouch" }),
      ) as unknown as typeof fetch;
    const refund = {
      record: vi.fn().mockRejectedValue(new Error("DB unavailable")),
    };
    const deps = makeServiceDeps(fetchImpl, refund);
    (deps.client.signRequirement as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ envelope: "stub" });

    const result = await callUpstreamWithX402(makeArgs(), deps);

    expect(result.kind).toBe("error");
    expect(refund.record).toHaveBeenCalled();
  });

  // Task 57 (Defect B) inverted the next assertion: the BUYER settles
  // with us before callUpstreamWithX402 runs, so "no payment sent"
  // was only true of OUR outbound spend — the buyer was already
  // charged. Every error exit must now record a refund.
  it("DOES invoke recorder when initial fetch exhausts retries on 5xx (buyer already settled)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(emptyResponse(500)) as unknown as typeof fetch;
    const refund = makeRefundRecorder();
    const deps = makeServiceDeps(fetchImpl, refund);

    const promise = callUpstreamWithX402(makeArgs(), deps);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(800);
    const result = await promise;

    expect(result.kind).toBe("error");
    expect(refund.record).toHaveBeenCalledTimes(1);
    expect(refund.record).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "post_settle_unreachable",
        upstreamStatus: 500,
      }),
    );
  });

  it("invokes recorder with post_settle_unreachable when initial fetch network-errors out", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const refund = makeRefundRecorder();
    const deps = makeServiceDeps(fetchImpl, refund);

    const promise = callUpstreamWithX402(makeArgs(), deps);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(800);
    const result = await promise;

    expect(result.kind).toBe("error");
    expect(refund.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "post_settle_unreachable" }),
    );
  });

  it("invokes recorder with post_settle_proxy_error when the price cap blocks the upstream payment", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(402, {
        x402Version: 2,
        resource: { url: UPSTREAM_URL },
        accepts: [
          {
            scheme: "exact",
            network: SVM_NETWORK,
            asset: SVM_USDC,
            payTo: "upstreamPayTo11111111111111111111111111111",
            amount: "99000000", // 99 USDC ≫ the 0.5 cap below
            maxAmountRequired: "99000000",
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const refund = makeRefundRecorder();
    const deps = makeServiceDeps(fetchImpl, refund);

    const result = await callUpstreamWithX402(
      { ...makeArgs(), maxPriceHumanUsdc: "0.500000" },
      deps,
    );

    expect(result.kind).toBe("error");
    expect((result as { reason: string }).reason).toBe("price_cap_exceeded");
    expect(refund.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "post_settle_proxy_error" }),
    );
  });

  it("invokes recorder with post_settle_proxy_error when no accept matches the required network", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(402, {
        x402Version: 2,
        resource: { url: UPSTREAM_URL },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x" + "2".repeat(40),
            amount: "1000",
            maxAmountRequired: "1000",
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const refund = makeRefundRecorder();
    const deps = makeServiceDeps(fetchImpl, refund);

    const result = await callUpstreamWithX402(makeArgs(), deps);

    expect(result.kind).toBe("error");
    expect((result as { reason: string }).reason).toBe("no_matching_accept");
    expect(refund.record).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "post_settle_proxy_error" }),
    );
  });
});
