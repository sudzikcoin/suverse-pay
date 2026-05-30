import { describe, expect, it } from "vitest";
import { isValidAddress, namespaceFor } from "../src/wallets.js";

describe("isValidAddress", () => {
  it("accepts a checksummed EVM address", () => {
    expect(
      isValidAddress("evm", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    ).toBe(true);
  });

  it("rejects an EVM address with wrong length", () => {
    expect(isValidAddress("evm", "0x123")).toBe(false);
  });

  it("rejects an EVM address missing the 0x prefix", () => {
    expect(
      isValidAddress("evm", "833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    ).toBe(false);
  });

  it("accepts a real Solana pubkey", () => {
    expect(
      isValidAddress("solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    ).toBe(true);
  });

  it("rejects a Solana address with base58-forbidden chars", () => {
    expect(isValidAddress("solana", "0OOOlllIIIxxxxxxxxxxxxxxxxxxxxxx")).toBe(
      false,
    );
  });

  it("accepts a Noble bech32 address", () => {
    expect(
      isValidAddress("cosmos", "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt"),
    ).toBe(true);
  });

  it("rejects a non-noble cosmos prefix", () => {
    expect(
      isValidAddress("cosmos", "cosmos1abcdefghijklmnopqrstuvwxyz23456789"),
    ).toBe(false);
  });

  it("accepts a TRON address", () => {
    expect(
      isValidAddress("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"),
    ).toBe(true);
  });

  it("rejects empty input", () => {
    expect(isValidAddress("evm", "")).toBe(false);
  });
});

describe("namespaceFor", () => {
  it.each([
    ["eip155:8453", "evm"],
    ["eip155:84532", "evm"],
    ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "solana"],
    ["cosmos:noble-1", "cosmos"],
    ["tron:mainnet", "tron"],
  ])("maps %s → %s", (caip2, ns) => {
    expect(namespaceFor(caip2)).toBe(ns);
  });

  it("returns null for unknown prefixes", () => {
    expect(namespaceFor("polkadot:0")).toBeNull();
  });
});
