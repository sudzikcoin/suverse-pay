import { describe, expect, it } from "vitest";
import {
  generateSecretPlaintext,
  hashSecretForStorage,
  signWebhook,
  verifyWebhook,
} from "./signer.js";

describe("generateSecretPlaintext", () => {
  it("starts with whsec_", () => {
    const s = generateSecretPlaintext();
    expect(s.startsWith("whsec_")).toBe(true);
  });

  it("returns distinct values across calls", () => {
    const a = generateSecretPlaintext();
    const b = generateSecretPlaintext();
    expect(a).not.toBe(b);
  });

  it("base64url body — no padding or unsafe chars", () => {
    const s = generateSecretPlaintext();
    const body = s.slice("whsec_".length);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body).not.toContain("=");
  });
});

describe("hashSecretForStorage", () => {
  it("is deterministic", () => {
    expect(hashSecretForStorage("hello")).toBe(hashSecretForStorage("hello"));
  });

  it("returns 64 hex chars (sha256)", () => {
    expect(hashSecretForStorage("anything")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the canonical sha256('hello') vector", () => {
    expect(hashSecretForStorage("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("signWebhook + verifyWebhook round-trip", () => {
  const secret = "whsec_test_value_only";
  const body = '{"id":"evt_123","type":"settle.succeeded"}';
  const ts = 1_700_000_000;

  it("verify accepts a signature produced by sign", () => {
    const header = signWebhook({ secret, body, timestamp: ts });
    expect(verifyWebhook({ secret, body, header, now: ts })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = signWebhook({ secret, body, timestamp: ts });
    expect(
      verifyWebhook({ secret, body: body + "X", header, now: ts }),
    ).toBe(false);
  });

  it("rejects a different secret", () => {
    const header = signWebhook({ secret, body, timestamp: ts });
    expect(
      verifyWebhook({ secret: "whsec_wrong", body, header, now: ts }),
    ).toBe(false);
  });

  it("rejects an expired timestamp (outside tolerance)", () => {
    const header = signWebhook({ secret, body, timestamp: ts });
    // 10 minutes later, default tolerance is 5min
    expect(verifyWebhook({ secret, body, header, now: ts + 600 })).toBe(false);
  });

  it("accepts a timestamp at the edge of tolerance", () => {
    const header = signWebhook({ secret, body, timestamp: ts });
    expect(verifyWebhook({ secret, body, header, now: ts + 300 })).toBe(true);
  });

  it("rejects a malformed header (missing v1)", () => {
    expect(verifyWebhook({ secret, body, header: "t=1700000000", now: ts })).toBe(
      false,
    );
  });

  it("rejects a malformed header (missing t)", () => {
    expect(verifyWebhook({ secret, body, header: "v1=deadbeef", now: ts })).toBe(
      false,
    );
  });

  it("rejects a header with non-numeric timestamp", () => {
    expect(
      verifyWebhook({ secret, body, header: "t=abc,v1=deadbeef", now: ts }),
    ).toBe(false);
  });

  it("ignores unknown schemes (forward compat for v2+)", () => {
    // Adding a v2 should NOT break v1 verification.
    const header = signWebhook({ secret, body, timestamp: ts });
    const augmented = `${header},v2=ignored_until_we_define_it`;
    expect(verifyWebhook({ secret, body, header: augmented, now: ts })).toBe(true);
  });
});

describe("signWebhook — header format invariants", () => {
  it("header is exactly `t=<int>,v1=<64hex>`", () => {
    const header = signWebhook({
      secret: "whsec_example",
      body: '{"type":"settle.succeeded","data":{"id":"fpay_abc"}}',
      timestamp: 1_700_000_000,
    });
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it("v1 hex changes when secret changes (sanity)", () => {
    const args = { body: "x", timestamp: 1 };
    const a = signWebhook({ ...args, secret: "alpha" });
    const b = signWebhook({ ...args, secret: "beta" });
    expect(a).not.toBe(b);
  });
});
