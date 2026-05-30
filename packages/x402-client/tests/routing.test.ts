import { describe, expect, it } from "vitest";
import { selectRequirement } from "../src/network/routing.js";
import type { ChallengeBody } from "../src/types.js";
import { NoSupportedNetworkError } from "../src/types.js";

function challenge(accepts: ChallengeBody["accepts"]): ChallengeBody {
  return {
    x402Version: 2,
    resource: { url: "https://api.example/paid" },
    accepts,
  };
}

const baseAcc = (network: string, amount = "100000") => ({
  scheme: "exact",
  network,
  asset: "0xUSDC",
  payTo: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
  amount,
  maxTimeoutSeconds: 60,
});

describe("selectRequirement — cost ranking", () => {
  it("picks Cosmos Noble over EVM L2 when buyer has both wallets", () => {
    const c = challenge([baseAcc("eip155:8453"), baseAcc("cosmos:noble-1")]);
    const decision = selectRequirement(c, {
      evm: "0x" + "ab".repeat(32) as `0x${string}`,
      cosmos: "mnemonic ignored — wallet existence only",
    });
    expect(decision.requirement.network).toBe("cosmos:noble-1");
    expect(decision.reason).toMatch(/Cosmos/);
  });

  it("picks EVM L2 over Ethereum L1 when buyer has only EVM wallet", () => {
    const c = challenge([baseAcc("eip155:1"), baseAcc("eip155:8453")]);
    const decision = selectRequirement(c, {
      evm: "0x" + "ab".repeat(32) as `0x${string}`,
    });
    expect(decision.requirement.network).toBe("eip155:8453");
  });

  it("picks testnet last", () => {
    const c = challenge([
      baseAcc("eip155:84532"), // Base Sepolia
      baseAcc("eip155:8453"), // Base mainnet
    ]);
    const decision = selectRequirement(c, {
      evm: "0x" + "ab".repeat(32) as `0x${string}`,
    });
    expect(decision.requirement.network).toBe("eip155:8453");
  });
});

describe("selectRequirement — preferences", () => {
  it("honours preferredNetwork when present in candidates", () => {
    const c = challenge([baseAcc("eip155:8453"), baseAcc("eip155:42161")]);
    const decision = selectRequirement(
      c,
      { evm: "0x" + "ab".repeat(32) as `0x${string}` },
      { preferredNetwork: "eip155:42161" },
    );
    expect(decision.requirement.network).toBe("eip155:42161");
  });

  it("falls back to ranking when preferredNetwork is not offered", () => {
    const c = challenge([baseAcc("eip155:8453")]);
    const decision = selectRequirement(
      c,
      { evm: "0x" + "ab".repeat(32) as `0x${string}` },
      { preferredNetwork: "eip155:1" /* not in challenge */ },
    );
    expect(decision.requirement.network).toBe("eip155:8453");
  });

  it("respects avoidNetworks", () => {
    const c = challenge([baseAcc("eip155:8453"), baseAcc("eip155:42161")]);
    const decision = selectRequirement(
      c,
      { evm: "0x" + "ab".repeat(32) as `0x${string}` },
      { avoidNetworks: ["eip155:8453"] },
    );
    expect(decision.requirement.network).toBe("eip155:42161");
  });
});

describe("selectRequirement — wallet matching", () => {
  it("throws NoSupportedNetworkError when no wallet covers any chain", () => {
    const c = challenge([baseAcc("cosmos:noble-1"), baseAcc("solana:mainnet")]);
    expect(() =>
      selectRequirement(c, { evm: "0x" + "ab".repeat(32) as `0x${string}` }),
    ).toThrowError(NoSupportedNetworkError);
  });

  it("rejects EVM chains in the registry that disabled eip3009 (Tempo)", () => {
    const c = challenge([baseAcc("eip155:4217")]); // Tempo
    expect(() =>
      selectRequirement(c, { evm: "0x" + "ab".repeat(32) as `0x${string}` }),
    ).toThrowError(NoSupportedNetworkError);
  });

  it("declines TRON when amount is below gasfree minimum", () => {
    const c = challenge([
      { ...baseAcc("tron:mainnet", "100000"), scheme: "exact_gasfree" },
    ]); // $0.10 < $1.50 min
    expect(() =>
      selectRequirement(c, { tron: "0x" + "ab".repeat(32) }),
    ).toThrowError(NoSupportedNetworkError);
  });

  it("accepts TRON only when scheme is exact_gasfree AND amount meets the minimum", () => {
    // exact_gasfree at $1.50 — passes
    const ok = challenge([
      { ...baseAcc("tron:mainnet", "1500000"), scheme: "exact_gasfree" },
    ]);
    const decision = selectRequirement(ok, {
      tron: "0x" + "ab".repeat(32),
    });
    expect(decision.requirement.network).toBe("tron:mainnet");
    expect(decision.requirement.scheme).toBe("exact_gasfree");
  });

  it("declines TRON `exact` scheme (v0.1.0 only signs exact_gasfree)", () => {
    const c = challenge([
      { ...baseAcc("tron:mainnet", "1500000"), scheme: "exact" },
    ]);
    expect(() =>
      selectRequirement(c, { tron: "0x" + "ab".repeat(32) }),
    ).toThrowError(NoSupportedNetworkError);
  });
});
