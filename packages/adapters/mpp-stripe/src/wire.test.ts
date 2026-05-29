import { describe, expect, it } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  challengeFromHeaderLine,
  challengeToHeaderLine,
  challengeToHeaderValue,
  credentialFromHeaderLine,
  credentialToHeaderLine,
  MppChallengeSchema,
  type MppChallenge,
  type MppCredential,
} from "./index.js";

const SAMPLE_CHALLENGE: MppChallenge = {
  id: "chal_abc123",
  realm: "api.example.com",
  method: "tempo",
  intent: "charge",
  request: {
    amount: "1000000",
    currency: "USDC",
    recipient: "0x000000000000000000000000000000000000bEEF",
    chainId: 4217,
  },
};

describe("base64url codec", () => {
  it("round-trips ASCII strings", () => {
    const original = '{"x":1,"y":"two"}';
    expect(base64urlDecode(base64urlEncode(original))).toBe(original);
  });

  it("uses URL-safe alphabet (- and _, no + or /)", () => {
    // A payload whose plain base64 includes both `+` and `/`.
    const input = "?>>>?>>?>>";
    const encoded = base64urlEncode(input);
    expect(encoded).not.toMatch(/[+/]/);
    expect(base64urlDecode(encoded)).toBe(input);
  });

  it("omits trailing `=` padding (RFC 4648 §5)", () => {
    expect(base64urlEncode("a")).not.toContain("=");
    expect(base64urlEncode("ab")).not.toContain("=");
  });
});

describe("challengeToHeaderLine + challengeFromHeaderLine", () => {
  it("round-trips a minimal charge challenge", () => {
    const headerValue = challengeToHeaderLine(SAMPLE_CHALLENGE);
    expect(headerValue.startsWith("Payment ")).toBe(true);
    const parsed = challengeFromHeaderLine(headerValue);
    expect(parsed.id).toBe(SAMPLE_CHALLENGE.id);
    expect(parsed.realm).toBe(SAMPLE_CHALLENGE.realm);
    expect(parsed.method).toBe(SAMPLE_CHALLENGE.method);
    expect(parsed.intent).toBe(SAMPLE_CHALLENGE.intent);
    expect(parsed.request).toEqual(SAMPLE_CHALLENGE.request);
  });

  it("emits exactly the 5 required parameters when no optionals present", () => {
    const value = challengeToHeaderValue(SAMPLE_CHALLENGE);
    expect(value).toMatch(/^id="chal_abc123"/);
    expect(value).toContain('realm="api.example.com"');
    expect(value).toContain('method="tempo"');
    expect(value).toContain('intent="charge"');
    expect(value).toMatch(/request="[A-Za-z0-9_-]+"/);
    expect(value).not.toContain("description=");
    expect(value).not.toContain("expires=");
    expect(value).not.toContain("digest=");
    expect(value).not.toContain("opaque=");
  });

  it("includes optional parameters when present", () => {
    const value = challengeToHeaderValue({
      ...SAMPLE_CHALLENGE,
      description: "Pay 1 USDC for content access",
      expires: "2027-01-15T08:00:00.000Z",
      digest: "sha-256=abc123",
      opaque: "server-correlation-12345",
    });
    expect(value).toContain('description="Pay 1 USDC for content access"');
    expect(value).toContain('expires="2027-01-15T08:00:00.000Z"');
    expect(value).toContain('digest="sha-256=abc123"');
    expect(value).toContain('opaque="server-correlation-12345"');
  });

  it("escapes embedded quotes inside parameter values", () => {
    const value = challengeToHeaderValue({
      ...SAMPLE_CHALLENGE,
      description: 'A "rich" description with quotes',
    });
    expect(value).toContain('description="A \\"rich\\" description with quotes"');
    // Round-trip recovers the original.
    const parsed = challengeFromHeaderLine(`Payment ${value}`);
    expect(parsed.description).toBe('A "rich" description with quotes');
  });

  it("preserves complex `request` payloads through the base64url round-trip", () => {
    const challenge: MppChallenge = {
      ...SAMPLE_CHALLENGE,
      request: {
        amount: "1000000",
        currency: "USDC",
        recipient: "0xabc",
        meta: { user: "agent-007", purpose: "weather-api" },
        amounts: [1, 2, 3],
        flag: true,
      },
    };
    const headerValue = challengeToHeaderLine(challenge);
    const parsed = challengeFromHeaderLine(headerValue);
    expect(parsed.request).toEqual(challenge.request);
  });

  it("accepts the `Payment ` prefix case-insensitively", () => {
    const headerValue = challengeToHeaderLine(SAMPLE_CHALLENGE);
    const lower = headerValue.replace(/^Payment /, "payment ");
    expect(() => challengeFromHeaderLine(lower)).not.toThrow();
  });

  it("throws on a malformed `request` parameter (not valid base64url JSON)", () => {
    const broken =
      'Payment id="x", realm="r", method="tempo", intent="charge", request="not-base64-json!!!"';
    expect(() => challengeFromHeaderLine(broken)).toThrow();
  });

  it("throws when `request` parameter is missing entirely", () => {
    const broken =
      'Payment id="x", realm="r", method="tempo", intent="charge"';
    expect(() => challengeFromHeaderLine(broken)).toThrow(
      /missing required `request`/,
    );
  });
});

describe("credentialToHeaderLine + credentialFromHeaderLine", () => {
  it("round-trips a tempo charge credential", () => {
    const credential: MppCredential = {
      challengeId: "chal_abc123",
      method: "tempo",
      intent: "charge",
      payload: {
        type: "transaction",
        signature: "0x" + "ab".repeat(65),
      },
    };
    const headerValue = credentialToHeaderLine(credential);
    expect(headerValue.startsWith("Payment ")).toBe(true);
    const parsed = credentialFromHeaderLine(headerValue);
    expect(parsed).toEqual(credential);
  });

  it("round-trips a stripe SPT credential", () => {
    const credential: MppCredential = {
      challengeId: "chal_stripe_001",
      method: "stripe",
      intent: "charge",
      payload: {
        type: "spt",
        sptToken: "csmrpd_test_abc",
        amount: 5000,
        currency: "usd",
      },
    };
    const parsed = credentialFromHeaderLine(credentialToHeaderLine(credential));
    expect(parsed).toEqual(credential);
  });

  it("accepts the `Payment ` prefix case-insensitively", () => {
    const credential: MppCredential = {
      challengeId: "c", method: "tempo", intent: "charge",
      payload: { type: "hash", hash: "0x" + "00".repeat(32) },
    };
    const line = credentialToHeaderLine(credential);
    const lower = line.replace(/^Payment /, "payment ");
    expect(() => credentialFromHeaderLine(lower)).not.toThrow();
  });

  it("throws on a malformed credential", () => {
    expect(() => credentialFromHeaderLine("Payment not-base64-json")).toThrow();
  });
});

describe("MppChallengeSchema", () => {
  it("rejects empty `id`", () => {
    const r = MppChallengeSchema.safeParse({
      ...SAMPLE_CHALLENGE,
      id: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects empty `method`", () => {
    const r = MppChallengeSchema.safeParse({
      ...SAMPLE_CHALLENGE,
      method: "",
    });
    expect(r.success).toBe(false);
  });

  it("accepts forward-compatible methods + intents (any string)", () => {
    const r = MppChallengeSchema.safeParse({
      ...SAMPLE_CHALLENGE,
      method: "brand_new_method_2027",
      intent: "stream",
    });
    expect(r.success).toBe(true);
  });

  it("rejects digests not prefixed with `sha-256=`", () => {
    const r = MppChallengeSchema.safeParse({
      ...SAMPLE_CHALLENGE,
      digest: "md5=oldhash",
    });
    expect(r.success).toBe(false);
  });
});
