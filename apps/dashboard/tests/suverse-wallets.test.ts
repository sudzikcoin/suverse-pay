/**
 * Static-registry sanity tests. Catches typos / drift in
 * suverse-wallets.ts before they reach the dashboard.
 */
import { describe, expect, it } from "vitest";
import {
  SUVERSE_WALLETS,
  chainOf,
  getWalletById,
  tryGetWalletById,
  walletsByChain,
  type SuverseWallet,
} from "../src/lib/suverse-wallets";

describe("SUVERSE_WALLETS registry", () => {
  it("has all expected ids", () => {
    const ids = SUVERSE_WALLETS.map((w) => w.id).sort();
    expect(ids).toEqual([
      "base-buyer",
      "base-merchant",
      "base-swap",
      "cosmos-merchant",
      "solana-merchant",
      "solana-service",
      "solana-swap",
    ]);
  });

  it("ids are unique", () => {
    const ids = SUVERSE_WALLETS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("addresses are unique (case-insensitively)", () => {
    const norm = SUVERSE_WALLETS.map((w) => w.address.toLowerCase());
    expect(new Set(norm).size).toBe(norm.length);
  });

  it("EVM addresses are 0x + 40 hex", () => {
    for (const w of SUVERSE_WALLETS.filter((w) => w.network === "eip155:8453")) {
      expect(w.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("Solana addresses are 32-44 char base58", () => {
    for (const w of SUVERSE_WALLETS.filter((w) => w.network.startsWith("solana:"))) {
      expect(w.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    }
  });

  it("Cosmos addresses are bech32 noble1…", () => {
    for (const w of SUVERSE_WALLETS.filter((w) => w.network.startsWith("cosmos:"))) {
      expect(w.address).toMatch(/^noble1[02-9ac-hj-np-z]{38,58}$/);
    }
  });

  it("explorerUrl contains the address verbatim", () => {
    for (const w of SUVERSE_WALLETS) {
      expect(w.explorerUrl).toContain(w.address);
    }
  });

  it("swap wallets all have an operatingCapitalAtomic field", () => {
    const swaps = SUVERSE_WALLETS.filter((w) => w.kind === "swap");
    expect(swaps.length).toBeGreaterThan(0);
    for (const w of swaps) {
      expect(w.operatingCapitalAtomic).toBeDefined();
      expect(w.operatingCapitalAtomic).toMatch(/^\d+$/);
    }
  });

  it("at least one wallet per kind exists", () => {
    const kinds = new Set(SUVERSE_WALLETS.map((w) => w.kind));
    expect(kinds.has("merchant")).toBe(true);
    expect(kinds.has("swap")).toBe(true);
    expect(kinds.has("service")).toBe(true);
    expect(kinds.has("test-buyer")).toBe(true);
  });
});

describe("getWalletById / tryGetWalletById", () => {
  it("returns the matching wallet", () => {
    const w = getWalletById("base-swap");
    expect(w.address).toBe("0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E");
    expect(w.kind).toBe("swap");
  });
  it("throws on unknown id", () => {
    expect(() => getWalletById("nope")).toThrow(/unknown_wallet_id/);
  });
  it("tryGet returns undefined on unknown id", () => {
    expect(tryGetWalletById("nope")).toBeUndefined();
  });
  it("tryGet returns the matching wallet", () => {
    expect(tryGetWalletById("solana-merchant")?.kind).toBe("merchant");
  });
});

describe("walletsByChain / chainOf", () => {
  it("groups wallets by chain bucket", () => {
    const g = walletsByChain();
    // Base: merchant + buyer + swap = 3
    expect(g.base.length).toBe(3);
    // Solana: merchant + service + swap = 3
    expect(g.solana.length).toBe(3);
    // Cosmos: merchant = 1
    expect(g.cosmos.length).toBe(1);
  });

  it("chainOf returns the right bucket", () => {
    const base = SUVERSE_WALLETS.find((w) => w.id === "base-merchant") as SuverseWallet;
    const sol = SUVERSE_WALLETS.find((w) => w.id === "solana-merchant") as SuverseWallet;
    const cos = SUVERSE_WALLETS.find((w) => w.id === "cosmos-merchant") as SuverseWallet;
    expect(chainOf(base)).toBe("base");
    expect(chainOf(sol)).toBe("solana");
    expect(chainOf(cos)).toBe("cosmos");
  });
});
