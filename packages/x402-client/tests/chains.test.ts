import { describe, expect, it } from "vitest";
import {
  CHAINS,
  chainIdFromCaip2,
  isSupportedEvmCaip2,
  lookupByCaip2,
  lookupByChainId,
} from "../src/network/chains.js";

describe("CHAINS registry", () => {
  it("contains the expected EVM mainnets", () => {
    const mainnets = CHAINS.filter((c) => !c.testnet).map((c) => c.caip2);
    expect(mainnets).toContain("eip155:1"); // Ethereum
    expect(mainnets).toContain("eip155:10"); // Optimism
    expect(mainnets).toContain("eip155:137"); // Polygon
    expect(mainnets).toContain("eip155:8453"); // Base
    expect(mainnets).toContain("eip155:42161"); // Arbitrum
    expect(mainnets).toContain("eip155:42220"); // Celo
    expect(mainnets).toContain("eip155:43114"); // Avalanche
    expect(mainnets).toContain("eip155:59144"); // Linea
    expect(mainnets).toContain("eip155:480"); // World Chain
  });

  it("flags Tempo + BNB as eip3009Supported=false with explanation", () => {
    const tempo = lookupByCaip2("eip155:4217");
    expect(tempo?.eip3009Supported).toBe(false);
    expect(tempo?.skipReason).toMatch(/EIP-3009/);
    const bnb = lookupByCaip2("eip155:56");
    expect(bnb?.eip3009Supported).toBe(false);
    expect(bnb?.skipReason).toMatch(/Permit/);
  });

  it("every USDC entry has 6 decimals OR documents 18-decimal exception", () => {
    for (const c of CHAINS) {
      if (c.eip3009Supported) {
        expect(c.usdc.decimals).toBe(6);
      } else {
        // 18-decimal Binance-Peg is allowed for unsupported chains.
        expect([6, 18]).toContain(c.usdc.decimals);
      }
    }
  });

  it("every chain has a non-empty eip712 name + version", () => {
    for (const c of CHAINS) {
      expect(c.usdc.eip712Name.length).toBeGreaterThan(0);
      expect(c.usdc.eip712Version.length).toBeGreaterThan(0);
    }
  });

  it("USDC address is 0x + 40 hex per chain", () => {
    for (const c of CHAINS) {
      expect(c.usdc.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("includes the 3 testnets needed for development", () => {
    const testnets = CHAINS.filter((c) => c.testnet).map((c) => c.caip2);
    expect(testnets).toContain("eip155:84532"); // Base Sepolia
    expect(testnets).toContain("eip155:421614"); // Arbitrum Sepolia
    expect(testnets).toContain("eip155:43113"); // Avalanche Fuji
  });
});

describe("lookup helpers", () => {
  it("lookupByCaip2 returns Base on the canonical id", () => {
    const c = lookupByCaip2("eip155:8453");
    expect(c?.displayName).toBe("Base");
    expect(c?.chainId).toBe(8453);
  });

  it("lookupByCaip2 returns undefined for unknown chain", () => {
    expect(lookupByCaip2("eip155:999999")).toBeUndefined();
  });

  it("lookupByChainId returns Polygon for 137", () => {
    expect(lookupByChainId(137)?.displayName).toBe("Polygon");
  });

  it("chainIdFromCaip2 parses correctly", () => {
    expect(chainIdFromCaip2("eip155:8453")).toBe(8453);
    expect(chainIdFromCaip2("eip155:0")).toBeNull(); // disallow zero
    expect(chainIdFromCaip2("solana:mainnet")).toBeNull();
    expect(chainIdFromCaip2("garbage")).toBeNull();
  });

  it("isSupportedEvmCaip2 covers our registry and only our registry", () => {
    expect(isSupportedEvmCaip2("eip155:8453")).toBe(true);
    expect(isSupportedEvmCaip2("eip155:1")).toBe(true);
    expect(isSupportedEvmCaip2("eip155:99999")).toBe(false);
    expect(isSupportedEvmCaip2("solana:mainnet")).toBe(false);
  });
});
