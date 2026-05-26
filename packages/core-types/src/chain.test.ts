import { describe, expect, it } from "vitest";
import {
  Caip2Schema,
  isCaip2,
  isCosmos,
  isEvm,
  isSolana,
  parseCaip2,
  stringifyCaip2,
} from "./chain.js";

describe("CAIP-2", () => {
  describe("parseCaip2", () => {
    it("parses Base", () => {
      expect(parseCaip2("eip155:8453")).toEqual({
        namespace: "eip155",
        reference: "8453",
      });
    });

    it("parses Noble testnet", () => {
      expect(parseCaip2("cosmos:grand-1")).toEqual({
        namespace: "cosmos",
        reference: "grand-1",
      });
    });

    it("parses Solana mainnet", () => {
      expect(parseCaip2("solana:mainnet")).toEqual({
        namespace: "solana",
        reference: "mainnet",
      });
    });

    it("rejects missing colon", () => {
      expect(() => parseCaip2("eip1558453")).toThrow(/Invalid CAIP-2/);
    });

    it("rejects uppercase namespace", () => {
      expect(() => parseCaip2("EIP155:8453")).toThrow(/Invalid CAIP-2/);
    });

    it("rejects overlong reference", () => {
      const longRef = "a".repeat(33);
      expect(() => parseCaip2(`cosmos:${longRef}`)).toThrow(/Invalid CAIP-2/);
    });

    it("rejects empty string", () => {
      expect(() => parseCaip2("")).toThrow(/Invalid CAIP-2/);
    });
  });

  describe("stringifyCaip2", () => {
    it("roundtrips through parse", () => {
      const original = "cosmos:noble-1";
      expect(stringifyCaip2(parseCaip2(original))).toBe(original);
    });

    it("rejects invalid components", () => {
      expect(() =>
        stringifyCaip2({ namespace: "EVIL", reference: "x" }),
      ).toThrow(/Invalid CAIP-2/);
    });
  });

  describe("isCaip2", () => {
    it("returns true for valid", () => {
      expect(isCaip2("eip155:8453")).toBe(true);
    });

    it("returns false for invalid", () => {
      expect(isCaip2("not-a-chain-id")).toBe(false);
      expect(isCaip2(undefined)).toBe(false);
      expect(isCaip2(42)).toBe(false);
    });
  });

  describe("Caip2Schema", () => {
    it("parses valid input", () => {
      expect(Caip2Schema.parse("eip155:8453")).toBe("eip155:8453");
    });

    it("throws on invalid input", () => {
      expect(() => Caip2Schema.parse("garbage")).toThrow();
    });
  });

  describe("namespace predicates", () => {
    it("isEvm distinguishes EVM from non-EVM", () => {
      expect(isEvm("eip155:8453")).toBe(true);
      expect(isEvm("cosmos:noble-1")).toBe(false);
      expect(isEvm("solana:mainnet")).toBe(false);
    });

    it("isCosmos distinguishes Cosmos", () => {
      expect(isCosmos("cosmos:noble-1")).toBe(true);
      expect(isCosmos("eip155:8453")).toBe(false);
    });

    it("isSolana distinguishes Solana", () => {
      expect(isSolana("solana:mainnet")).toBe(true);
      expect(isSolana("eip155:8453")).toBe(false);
    });
  });
});
