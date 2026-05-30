import { describe, expect, it } from "vitest";
import { buildWalletsFromEnv } from "../src/wallets.js";

describe("buildWalletsFromEnv", () => {
  it("returns empty when no relevant env vars present", () => {
    const out = buildWalletsFromEnv({});
    expect(out.configured).toEqual([]);
    expect(out.wallets).toEqual({});
  });

  it("uses EVM_PRIVATE_KEY when set", () => {
    const out = buildWalletsFromEnv({
      EVM_PRIVATE_KEY: "0xabc123",
    });
    expect(out.configured).toEqual(["evm"]);
    expect(out.wallets.evm).toBe("0xabc123");
  });

  it("falls back to BASE_PRIVATE_KEY", () => {
    const out = buildWalletsFromEnv({
      BASE_PRIVATE_KEY: "0xdeadbeef",
    });
    expect(out.configured).toEqual(["evm"]);
    expect(out.wallets.evm).toBe("0xdeadbeef");
  });

  it("0x-prefixes a bare-hex EVM key", () => {
    const out = buildWalletsFromEnv({
      EVM_PRIVATE_KEY: "abc123",
    });
    expect(out.wallets.evm).toBe("0xabc123");
  });

  it("collects every configured chain", () => {
    const out = buildWalletsFromEnv({
      BASE_PRIVATE_KEY: "0xabc",
      SOLANA_KEYPAIR: "solBase58",
      COSMOS_MNEMONIC: "twelve word phrase here for noble wallet derivation always",
      TRON_PRIVATE_KEY: "deadbeef",
    });
    expect(out.configured.sort()).toEqual(
      ["cosmos", "evm", "solana", "tron"],
    );
    expect(out.wallets.solana).toBe("solBase58");
    expect(out.wallets.cosmos).toBe(
      "twelve word phrase here for noble wallet derivation always",
    );
    expect(out.wallets.tron).toBe("deadbeef");
  });
});
