import { describe, expect, it } from "vitest";
import {
  ConfigInputSchema,
  payToLabel,
  validateConfig,
  validatePayToFor,
} from "../src/lib/seller-config";

/**
 * Pure-logic tests for the seller-config layer. DB helpers
 * (findOwnedResourceKey, getConfig, upsertConfig) need a live
 * Postgres pool — covered by the dashboard integration suite when
 * Phase 5 sub-task spins one up.
 */

describe("validatePayToFor", () => {
  it("accepts canonical EVM address", () => {
    expect(
      validatePayToFor(
        "evm",
        "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
      ),
    ).toBeNull();
  });
  it("rejects short EVM address", () => {
    expect(validatePayToFor("evm", "0xabc")).toMatch(/40 hex/);
  });
  it("rejects EVM missing 0x", () => {
    expect(
      validatePayToFor(
        "evm",
        "260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
      ),
    ).toMatch(/40 hex/);
  });

  it("accepts a canonical Solana address", () => {
    expect(
      validatePayToFor(
        "solana",
        "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM",
      ),
    ).toBeNull();
  });
  it("rejects Solana with banned 0/O", () => {
    expect(
      validatePayToFor(
        "solana",
        "0BYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM",
      ),
    ).toMatch(/base58/);
  });

  it("accepts a canonical Noble cosmos address", () => {
    expect(
      validatePayToFor(
        "cosmos",
        "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj",
      ),
    ).toBeNull();
  });
  it("rejects cosmos without noble1 prefix", () => {
    expect(
      validatePayToFor(
        "cosmos",
        "cosmos1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5l9999",
      ),
    ).toMatch(/noble1/);
  });

  it("accepts a canonical TRON address", () => {
    expect(
      validatePayToFor("tron", "TMpNsK3Dj2ehBwQ9Hv5PeFZboynD7JX2is"),
    ).toBeNull();
  });
  it("rejects TRON without leading T", () => {
    expect(
      validatePayToFor("tron", "MpNsK3Dj2ehBwQ9Hv5PeFZboynD7JX2isx"),
    ).toMatch(/begin with 'T'/);
  });

  it("payToLabel returns non-empty for every family", () => {
    for (const family of ["evm", "solana", "cosmos", "tron"] as const) {
      expect(payToLabel(family).length).toBeGreaterThan(0);
    }
  });
});

describe("ConfigInputSchema", () => {
  const base = {
    defaultPriceAtomic: "70000",
    acceptedNetworks: ["eip155:8453"],
    payToEvm: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
    payToSolana: null,
    payToCosmos: null,
    payToTron: null,
    description: null,
  };

  it("accepts a minimal valid input", () => {
    expect(ConfigInputSchema.safeParse(base).success).toBe(true);
  });

  it("rejects price below 1000 atomic", () => {
    const r = ConfigInputSchema.safeParse({
      ...base,
      defaultPriceAtomic: "999",
    });
    expect(r.success).toBe(false);
  });

  it("rejects price above 10_000_000 atomic", () => {
    const r = ConfigInputSchema.safeParse({
      ...base,
      defaultPriceAtomic: "10000001",
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown CAIP-2 id", () => {
    const r = ConfigInputSchema.safeParse({
      ...base,
      acceptedNetworks: ["eip155:99999"],
    });
    expect(r.success).toBe(false);
  });

  it("accepts empty acceptedNetworks (UX-level rule blocks empty save)", () => {
    const r = ConfigInputSchema.safeParse({
      ...base,
      acceptedNetworks: [],
    });
    expect(r.success).toBe(true);
  });

  it("description max 500 chars", () => {
    const tooLong = "x".repeat(501);
    const r = ConfigInputSchema.safeParse({ ...base, description: tooLong });
    expect(r.success).toBe(false);
  });
});

describe("validateConfig (cross-field)", () => {
  it("requires payToEvm when Base is selected", () => {
    const errors = validateConfig({
      defaultPriceAtomic: "70000",
      acceptedNetworks: ["eip155:8453"],
      payToEvm: null,
      payToSolana: null,
      payToCosmos: null,
      payToTron: null,
      description: null,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("payToEvm");
  });

  it("no errors when payTo is supplied for every selected family", () => {
    const errors = validateConfig({
      defaultPriceAtomic: "70000",
      acceptedNetworks: [
        "eip155:8453",
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        "cosmos:noble-1",
        "tron:mainnet",
      ],
      payToEvm: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
      payToSolana: "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM",
      payToCosmos: "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj",
      payToTron: "TMpNsK3Dj2ehBwQ9Hv5PeFZboynD7JX2is",
      description: null,
    });
    expect(errors).toEqual([]);
  });

  it("flags bad address even when present", () => {
    const errors = validateConfig({
      defaultPriceAtomic: "70000",
      acceptedNetworks: ["eip155:8453"],
      payToEvm: "0xnotahex",
      payToSolana: null,
      payToCosmos: null,
      payToTron: null,
      description: null,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe("payToEvm");
  });

  it("ignores payTo for unselected families", () => {
    const errors = validateConfig({
      defaultPriceAtomic: "70000",
      acceptedNetworks: ["eip155:8453"],
      payToEvm: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
      payToSolana: "garbage", // not selected → not validated
      payToCosmos: null,
      payToTron: null,
      description: null,
    });
    expect(errors).toEqual([]);
  });
});
