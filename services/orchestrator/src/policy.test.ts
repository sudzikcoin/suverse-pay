import { describe, expect, it } from "vitest";
import { resolvePolicy } from "./policy.js";

describe("resolvePolicy", () => {
  it("returns the schema default when both layers are absent", () => {
    const r = resolvePolicy({});
    expect(r).toEqual({ optimize: "cost", fallback: true, maxAttempts: 3 });
  });

  it("apiKeyPolicy overrides the default", () => {
    const r = resolvePolicy({
      apiKeyPolicy: { optimize: "latency", maxAttempts: 5 },
    });
    expect(r.optimize).toBe("latency");
    expect(r.maxAttempts).toBe(5);
    expect(r.fallback).toBe(true);
  });

  it("requestPolicy overrides apiKeyPolicy", () => {
    const r = resolvePolicy({
      apiKeyPolicy: { optimize: "latency", maxAttempts: 5 },
      requestPolicy: { optimize: "cost" },
    });
    expect(r.optimize).toBe("cost");
    expect(r.maxAttempts).toBe(5);
  });

  it("explicit undefined in requestPolicy keeps apiKeyPolicy's value", () => {
    const r = resolvePolicy({
      apiKeyPolicy: { optimize: "success_rate" },
      requestPolicy: { optimize: undefined, maxAttempts: 2 },
    });
    expect(r.optimize).toBe("success_rate");
    expect(r.maxAttempts).toBe(2);
  });

  it("propagates providerHint when supplied at any layer", () => {
    const r = resolvePolicy({
      requestPolicy: { providerHint: "cosmos-pay" },
    });
    expect(r.providerHint).toBe("cosmos-pay");
  });

  it("Zod parsing kicks in — invalid maxAttempts is rejected", () => {
    expect(() => resolvePolicy({ requestPolicy: { maxAttempts: 999 } })).toThrow();
  });

  it("treats null layers as absent (DB might return null for an unset row)", () => {
    const r = resolvePolicy({
      apiKeyPolicy: null,
      requestPolicy: null,
    });
    expect(r.optimize).toBe("cost");
  });
});
