import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptHeaders,
  encryptHeaders,
  loadMasterKey,
} from "../src/crypto.js";

describe("crypto", () => {
  const key = randomBytes(32);

  it("round-trips headers through AES-256-GCM", () => {
    const headers = {
      "x-api-key": "abc123",
      authorization: "Bearer eyJhbGciOiJ...",
    };
    const blob = encryptHeaders(headers, key);
    expect(blob).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(blob.length).toBeGreaterThan(0);
    expect(decryptHeaders(blob, key)).toEqual(headers);
  });

  it("produces a different ciphertext per call (random IV)", () => {
    const headers = { x: "1" };
    expect(encryptHeaders(headers, key)).not.toEqual(
      encryptHeaders(headers, key),
    );
  });

  it("rejects ciphertext encrypted under a different key", () => {
    const blob = encryptHeaders({ a: "1" }, key);
    expect(() => decryptHeaders(blob, randomBytes(32))).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const blob = encryptHeaders({ a: "1" }, key);
    const tampered =
      Buffer.from(blob, "base64").map((b, i) => (i === 30 ? b ^ 1 : b))
        .toString("base64");
    expect(() => decryptHeaders(tampered, key)).toThrow();
  });

  it("rejects a blob shorter than the IV+tag overhead", () => {
    expect(() => decryptHeaders("AAA=", key)).toThrow(/too short/);
  });

  describe("loadMasterKey", () => {
    it("loads a valid base64 32-byte key", () => {
      const k = randomBytes(32).toString("base64");
      const loaded = loadMasterKey({ PROXY_HEADER_KEY: k });
      expect(loaded.length).toBe(32);
    });

    it("throws on missing env", () => {
      expect(() => loadMasterKey({})).toThrow(/PROXY_HEADER_KEY/);
    });

    it("throws on wrong-length decoded key", () => {
      const tooShort = randomBytes(16).toString("base64");
      expect(() => loadMasterKey({ PROXY_HEADER_KEY: tooShort })).toThrow(
        /32 bytes/,
      );
    });
  });
});
