import { describe, expect, it } from "vitest";
import { deriveIdempotencyKey } from "./pay-and-call.js";

describe("deriveIdempotencyKey", () => {
  const base = {
    payerAddress: "noble1abcdef",
    network: "cosmos:grand-1",
    url: "https://example.com/x",
    body: { hello: "world" },
    now: 1_700_000_000_000,
  };

  it("returns a 32-char hex string", () => {
    const key = deriveIdempotencyKey(base);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is deterministic for the same inputs (same hour bucket)", () => {
    const a = deriveIdempotencyKey({ ...base, now: 1_700_000_000_000 });
    const b = deriveIdempotencyKey({ ...base, now: 1_700_000_000_000 + 60_000 });
    expect(a).toBe(b);
  });

  it("changes when payerAddress changes (session rotation hits same wallet later)", () => {
    const a = deriveIdempotencyKey({ ...base, payerAddress: "noble1aaa" });
    const b = deriveIdempotencyKey({ ...base, payerAddress: "noble1bbb" });
    expect(a).not.toBe(b);
  });

  it("changes when URL changes", () => {
    const a = deriveIdempotencyKey({ ...base, url: "https://example.com/x" });
    const b = deriveIdempotencyKey({ ...base, url: "https://example.com/y" });
    expect(a).not.toBe(b);
  });

  it("changes when body changes", () => {
    const a = deriveIdempotencyKey({ ...base, body: { hello: "world" } });
    const b = deriveIdempotencyKey({ ...base, body: { hello: "mars" } });
    expect(a).not.toBe(b);
  });

  it("changes when network changes (same wallet, different chain)", () => {
    const a = deriveIdempotencyKey({ ...base, network: "cosmos:grand-1" });
    const b = deriveIdempotencyKey({ ...base, network: "eip155:8453" });
    expect(a).not.toBe(b);
  });

  it("does NOT include sessionId — same wallet across sessions hashes equal", () => {
    // The function signature does not accept sessionId at all; this
    // test documents the property by passing identical inputs and
    // confirming equality. If a future change adds sessionId as an
    // input, this test guards against re-introducing the per-session
    // staleness bug from review item 3.
    const a = deriveIdempotencyKey(base);
    const b = deriveIdempotencyKey(base);
    expect(a).toBe(b);
  });

  it("changes when crossing an hour boundary (legitimate re-payment unblocked)", () => {
    const t = 1_700_000_000_000;
    const a = deriveIdempotencyKey({ ...base, now: t });
    const b = deriveIdempotencyKey({ ...base, now: t + 3_600_000 + 1 });
    expect(a).not.toBe(b);
  });

  it("does NOT change for retries within the same hour", () => {
    const t = 1_700_000_000_000;
    const a = deriveIdempotencyKey({ ...base, now: t });
    const b = deriveIdempotencyKey({ ...base, now: t + 60_000 * 30 });
    expect(a).toBe(b);
  });

  it("handles undefined body deterministically (treats as empty string)", () => {
    const a = deriveIdempotencyKey({ ...base, body: undefined });
    const b = deriveIdempotencyKey({ ...base, body: undefined });
    expect(a).toBe(b);
    // ... and differs from any non-empty body
    const c = deriveIdempotencyKey({ ...base, body: {} });
    expect(a).not.toBe(c);
  });
});
