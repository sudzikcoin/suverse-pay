import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { buildBinanceAuthHeaders } from "./auth.js";

describe("buildBinanceAuthHeaders", () => {
  const FIXED_TS = 1_800_000_000_000; // 2027-01-15T08:00:00Z
  const FIXED_NONCE = "abcdefghijklmnop1234567890ABCDEF";

  it("produces the five canonical Binance Pay headers", () => {
    const headers = buildBinanceAuthHeaders({
      apiKeyId: "merchant_key_id_xyz",
      apiSecret: "merchant_secret_value",
      bodyJson: JSON.stringify({ x402Version: 2 }),
      timestampMs: FIXED_TS,
      nonce: FIXED_NONCE,
    });
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["BinancePay-Timestamp"]).toBe(String(FIXED_TS));
    expect(headers["BinancePay-Nonce"]).toBe(FIXED_NONCE);
    expect(headers["BinancePay-Certificate-SN"]).toBe("merchant_key_id_xyz");
    expect(headers["BinancePay-Signature"]).toMatch(/^[0-9A-F]{128}$/);
  });

  it("signature matches HMAC_SHA512(secret, `${ts}\\n${nonce}\\n${body}\\n`).hex.toUpperCase()", () => {
    const body = JSON.stringify({ x402Version: 2, foo: "bar" });
    const headers = buildBinanceAuthHeaders({
      apiKeyId: "id",
      apiSecret: "topsecret",
      bodyJson: body,
      timestampMs: FIXED_TS,
      nonce: FIXED_NONCE,
    });
    const payloadToSign = `${FIXED_TS}\n${FIXED_NONCE}\n${body}\n`;
    const expected = createHmac("sha512", "topsecret")
      .update(payloadToSign, "utf8")
      .digest("hex")
      .toUpperCase();
    expect(headers["BinancePay-Signature"]).toBe(expected);
  });

  it("empty body (GET request) signs correctly: `${ts}\\n${nonce}\\n\\n`", () => {
    const headers = buildBinanceAuthHeaders({
      apiKeyId: "id",
      apiSecret: "topsecret",
      bodyJson: "",
      timestampMs: FIXED_TS,
      nonce: FIXED_NONCE,
    });
    const expected = createHmac("sha512", "topsecret")
      .update(`${FIXED_TS}\n${FIXED_NONCE}\n\n`, "utf8")
      .digest("hex")
      .toUpperCase();
    expect(headers["BinancePay-Signature"]).toBe(expected);
  });

  it("generates a fresh 32-char alphanumeric nonce when not provided", () => {
    const a = buildBinanceAuthHeaders({
      apiKeyId: "id",
      apiSecret: "s",
      bodyJson: "{}",
    });
    const b = buildBinanceAuthHeaders({
      apiKeyId: "id",
      apiSecret: "s",
      bodyJson: "{}",
    });
    expect(a["BinancePay-Nonce"]).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(b["BinancePay-Nonce"]).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(a["BinancePay-Nonce"]).not.toBe(b["BinancePay-Nonce"]);
  });

  it("signature changes when ANY of body / timestamp / nonce changes", () => {
    const base = buildBinanceAuthHeaders({
      apiKeyId: "id",
      apiSecret: "s",
      bodyJson: "{}",
      timestampMs: FIXED_TS,
      nonce: FIXED_NONCE,
    });
    const diffBody = buildBinanceAuthHeaders({
      apiKeyId: "id",
      apiSecret: "s",
      bodyJson: '{"a":1}',
      timestampMs: FIXED_TS,
      nonce: FIXED_NONCE,
    });
    const diffTs = buildBinanceAuthHeaders({
      apiKeyId: "id",
      apiSecret: "s",
      bodyJson: "{}",
      timestampMs: FIXED_TS + 1,
      nonce: FIXED_NONCE,
    });
    const diffNonce = buildBinanceAuthHeaders({
      apiKeyId: "id",
      apiSecret: "s",
      bodyJson: "{}",
      timestampMs: FIXED_TS,
      nonce: "00000000000000000000000000000000",
    });
    expect(base["BinancePay-Signature"]).not.toBe(
      diffBody["BinancePay-Signature"],
    );
    expect(base["BinancePay-Signature"]).not.toBe(
      diffTs["BinancePay-Signature"],
    );
    expect(base["BinancePay-Signature"]).not.toBe(
      diffNonce["BinancePay-Signature"],
    );
  });
});
