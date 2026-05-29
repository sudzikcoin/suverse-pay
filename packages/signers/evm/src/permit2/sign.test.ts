import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import {
  buildPermit2Domain,
  PERMIT2_CONTRACT_ADDRESS,
  PERMIT2_DEPLOYED_CHAIN_IDS,
  X402_EXACT_PERMIT2_PROXY_ADDRESS,
  X402_PERMIT2_SETTLABLE_CHAIN_IDS,
  isPermit2ChainId,
  isX402Permit2SettlableChainId,
} from "./domain.js";
import { buildPermit2Message, PERMIT2_PRIMARY_TYPE, PERMIT2_TYPES } from "./eip712.js";
import {
  signPermit2Authorization,
  signPermit2UsdtAuthorization,
} from "./sign.js";
import {
  allPermit2Tokens,
  getUsdtToken,
  isPermit2Token,
  PERMIT2_TOKEN_CHAIN_IDS,
} from "../usdt-tokens.js";

// Canonical BIP-39 test mnemonic — publicly known, NEVER associated
// with real funds. Same as sign.test.ts so the round-trip address is
// reusable across both suites.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const TEST_ADDRESS = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";

const TEST_PAY_TO = "0x000000000000000000000000000000000000bEEF" as const;

describe("Permit2 constants", () => {
  it("Permit2 contract address is the CREATE2 canonical 0x0000...22D4...8BA3", () => {
    expect(PERMIT2_CONTRACT_ADDRESS).toBe(
      "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    );
  });

  it("x402 Permit2 proxy address is canonical 0x402085...0001", () => {
    expect(X402_EXACT_PERMIT2_PROXY_ADDRESS).toBe(
      "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
    );
  });

  it("x402 settlable chains are a subset of Permit2-deployed chains", () => {
    for (const cid of X402_PERMIT2_SETTLABLE_CHAIN_IDS) {
      expect(isPermit2ChainId(cid)).toBe(true);
    }
  });

  it("isPermit2ChainId / isX402Permit2SettlableChainId agree on known IDs", () => {
    // Ethereum + Optimism + Base — both contracts deployed.
    expect(isPermit2ChainId(1)).toBe(true);
    expect(isX402Permit2SettlableChainId(1)).toBe(true);
    expect(isPermit2ChainId(8453)).toBe(true);
    expect(isX402Permit2SettlableChainId(8453)).toBe(true);
    // Linea — Permit2 deployed, proxy NOT deployed.
    expect(isPermit2ChainId(59144)).toBe(true);
    expect(isX402Permit2SettlableChainId(59144)).toBe(false);
    // BNB Chain — Sub-task 7 added it; both checks pass.
    expect(isPermit2ChainId(56)).toBe(true);
    expect(isX402Permit2SettlableChainId(56)).toBe(true);
    // Sui (mvm:101) — fictional EVM ID, neither check passes.
    expect(isPermit2ChainId(999_999)).toBe(false);
    expect(isX402Permit2SettlableChainId(999_999)).toBe(false);
  });
});

describe("Permit2 EIP-712 domain", () => {
  it("uses name='Permit2' with NO version field", () => {
    const d = buildPermit2Domain(1);
    expect(d.name).toBe("Permit2");
    expect("version" in d).toBe(false);
    expect(d.chainId).toBe(1);
    expect(d.verifyingContract).toBe(PERMIT2_CONTRACT_ADDRESS);
  });

  it("varies chainId per chain (10, 137, 8453 distinct)", () => {
    expect(buildPermit2Domain(10).chainId).toBe(10);
    expect(buildPermit2Domain(137).chainId).toBe(137);
    expect(buildPermit2Domain(8453).chainId).toBe(8453);
  });
});

describe("Permit2 token registry", () => {
  it("registers token entries on the 10 Permit2-routed chains (Sub-task 6 nine + BNB Chain Sub-task 7)", () => {
    expect(PERMIT2_TOKEN_CHAIN_IDS).toEqual(
      [1, 10, 56, 137, 1329, 8453, 42161, 42220, 43114, 59144].sort(
        (a, b) => a - b,
      ),
    );
  });

  it("hasEip3009=false on every entry (EIP-3009 path is the eip3009.ts signer)", () => {
    for (const t of allPermit2Tokens()) {
      expect(t.hasEip3009).toBe(false);
    }
  });

  it("decimals=6 on every entry EXCEPT BNB Chain (Binance-Peg = 18 decimals)", () => {
    for (const t of allPermit2Tokens()) {
      if (t.chainId === 56) {
        // BNB Chain Binance-Peg stablecoins use 18 decimals.
        expect(t.decimals).toBe(18);
      } else {
        expect(t.decimals).toBe(6);
      }
    }
  });

  it("BNB Chain has BOTH USDC and USDT registered (Sub-task 7)", () => {
    const bsc = allPermit2Tokens().filter((t) => t.chainId === 56);
    expect(bsc).toHaveLength(2);
    const symbols = bsc.map((t) => t.symbol).sort();
    expect(symbols).toEqual(["USDC", "USDT"]);
  });

  it("getUsdtToken returns the canonical Ethereum address", () => {
    const eth = getUsdtToken(1);
    expect(eth?.address).toBe("0xdAC17F958D2ee523a2206206994597C13D831ec7");
    expect(eth?.hasEip2612Permit).toBe(false);
  });

  it("getUsdtToken on BNB Chain throws (two tokens registered — caller must use getPermit2Token)", () => {
    // BNB Chain has both USDC and USDT in the registry — getUsdtToken
    // must NOT silently return USDT, since the caller might mean USDC.
    // The error tells the operator to specify the address.
    expect(() => getUsdtToken(56)).toThrow(/multiple Permit2 token entries on chain 56/);
  });

  it("getUsdtToken returns null for chains with no entry", () => {
    expect(getUsdtToken(480)).toBeNull(); // World Chain — no USDT entry
    expect(getUsdtToken(50)).toBeNull(); // XDC — no USDT entry
  });

  it("isPermit2Token is case-insensitive on the address", () => {
    const addrLower = "0xdac17f958d2ee523a2206206994597c13d831ec7";
    const addrUpper = "0xDAC17F958D2EE523A2206206994597C13D831EC7";
    expect(isPermit2Token(1, addrLower)).toBe(true);
    expect(isPermit2Token(1, addrUpper)).toBe(true);
  });
});

describe("signPermit2Authorization happy path", () => {
  it("produces a signature that recovers to the signer's address on Ethereum", async () => {
    const { payload } = await signPermit2Authorization({
      secret: TEST_MNEMONIC,
      network: "eip155:1",
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      amount: "1000000",
      payTo: TEST_PAY_TO,
      now: 1_800_000_000,
      nonce: "12345678901234567890",
    });
    const recovered = await recoverTypedDataAddress({
      domain: buildPermit2Domain(1),
      types: PERMIT2_TYPES,
      primaryType: PERMIT2_PRIMARY_TYPE,
      message: buildPermit2Message(payload.permit2Authorization),
      signature: payload.signature,
    });
    expect(recovered).toBe(TEST_ADDRESS);
    // The wire payload pins spender to the canonical x402 proxy.
    expect(payload.permit2Authorization.spender).toBe(
      X402_EXACT_PERMIT2_PROXY_ADDRESS,
    );
    // Witness binds the recipient.
    expect(payload.permit2Authorization.witness.to).toBe(TEST_PAY_TO);
  });

  it("respects validitySeconds — deadline = validAfter + validitySeconds", async () => {
    const { payload } = await signPermit2Authorization({
      secret: TEST_MNEMONIC,
      network: "eip155:1",
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      amount: "1000000",
      payTo: TEST_PAY_TO,
      now: 1_800_000_000,
      validitySeconds: 45,
    });
    const auth = payload.permit2Authorization;
    expect(auth.witness.validAfter).toBe((1_800_000_000 - 2).toString());
    expect(auth.deadline).toBe((1_800_000_000 - 2 + 45).toString());
  });

  it("generates a fresh nonce on each call (256-bit random)", async () => {
    const a = await signPermit2Authorization({
      secret: TEST_MNEMONIC,
      network: "eip155:1",
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      amount: "1000000",
      payTo: TEST_PAY_TO,
    });
    const b = await signPermit2Authorization({
      secret: TEST_MNEMONIC,
      network: "eip155:1",
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      amount: "1000000",
      payTo: TEST_PAY_TO,
    });
    expect(a.payload.permit2Authorization.nonce).not.toBe(
      b.payload.permit2Authorization.nonce,
    );
    // Sanity: both nonces fit uint256 (decimal length ≤ 78).
    expect(a.payload.permit2Authorization.nonce.length).toBeLessThanOrEqual(78);
    expect(b.payload.permit2Authorization.nonce.length).toBeLessThanOrEqual(78);
  });
});

describe("signPermit2UsdtAuthorization", () => {
  it("looks up USDT contract by chain and signs against it", async () => {
    const { payload } = await signPermit2UsdtAuthorization({
      secret: TEST_MNEMONIC,
      network: "eip155:1",
      amount: "5000000",
      payTo: TEST_PAY_TO,
    });
    // Ethereum-canonical USDT.
    expect(payload.permit2Authorization.permitted.token).toBe(
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    );
    expect(payload.permit2Authorization.permitted.amount).toBe("5000000");
  });

  it("throws when the chain has no USDT registered", async () => {
    await expect(
      signPermit2UsdtAuthorization({
        secret: TEST_MNEMONIC,
        network: "eip155:480", // World Chain — Permit2 yes, USDT no
        amount: "1000000",
        payTo: TEST_PAY_TO,
      }),
    ).rejects.toThrow(/no USDT contract registered for chain 480/);
  });
});

describe("signPermit2Authorization input validation", () => {
  it("rejects an unsupported chain", async () => {
    // Sub-task 7 added BNB Chain (56) — so we need a chain that is
    // genuinely unknown. eip155:1234 is a fictional id with no Permit2.
    await expect(
      signPermit2Authorization({
        secret: TEST_MNEMONIC,
        network: "eip155:1234",
        token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        amount: "1000000",
        payTo: TEST_PAY_TO,
      }),
    ).rejects.toThrow(/Permit2 is not deployed on chain 1234/);
  });

  it("rejects an unknown token on a supported chain", async () => {
    await expect(
      signPermit2Authorization({
        secret: TEST_MNEMONIC,
        network: "eip155:1",
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Ethereum USDC — Permit2-spendable but not in USDT registry yet
        amount: "1000000",
        payTo: TEST_PAY_TO,
      }),
    ).rejects.toThrow(/no trusted Permit2 token entry/);
  });

  it("rejects non-positive validitySeconds", async () => {
    await expect(
      signPermit2Authorization({
        secret: TEST_MNEMONIC,
        network: "eip155:1",
        token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        amount: "1000000",
        payTo: TEST_PAY_TO,
        validitySeconds: 0,
      }),
    ).rejects.toThrow(/validitySeconds must be positive/);
  });

  it("rejects a malformed mnemonic", async () => {
    await expect(
      signPermit2Authorization({
        secret: "one two three",
        network: "eip155:1",
        token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        amount: "1000000",
        payTo: TEST_PAY_TO,
      }),
    ).rejects.toThrow(/mnemonic|words/);
  });
});

describe("Permit2 tamper detection", () => {
  it("recovery returns a DIFFERENT address when witness.to is tampered", async () => {
    const { payload } = await signPermit2Authorization({
      secret: TEST_MNEMONIC,
      network: "eip155:1",
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      amount: "1000000",
      payTo: TEST_PAY_TO,
      now: 1_800_000_000,
      nonce: "999",
    });
    const tampered = {
      ...payload.permit2Authorization,
      witness: {
        ...payload.permit2Authorization.witness,
        to: "0x000000000000000000000000000000000000dEaD" as `0x${string}`,
      },
    };
    const recovered = await recoverTypedDataAddress({
      domain: buildPermit2Domain(1),
      types: PERMIT2_TYPES,
      primaryType: PERMIT2_PRIMARY_TYPE,
      message: buildPermit2Message(tampered),
      signature: payload.signature,
    });
    expect(recovered).not.toBe(TEST_ADDRESS);
  });

  it("recovery returns a DIFFERENT address when amount is tampered", async () => {
    const { payload } = await signPermit2Authorization({
      secret: TEST_MNEMONIC,
      network: "eip155:1",
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      amount: "1000000",
      payTo: TEST_PAY_TO,
      now: 1_800_000_000,
      nonce: "999",
    });
    const tampered = {
      ...payload.permit2Authorization,
      permitted: {
        ...payload.permit2Authorization.permitted,
        amount: "999999999",
      },
    };
    const recovered = await recoverTypedDataAddress({
      domain: buildPermit2Domain(1),
      types: PERMIT2_TYPES,
      primaryType: PERMIT2_PRIMARY_TYPE,
      message: buildPermit2Message(tampered),
      signature: payload.signature,
    });
    expect(recovered).not.toBe(TEST_ADDRESS);
  });

  it("recovery returns a DIFFERENT address when the signing chainId changes (cross-chain replay block)", async () => {
    const { payload } = await signPermit2Authorization({
      secret: TEST_MNEMONIC,
      network: "eip155:1", // Sign on Ethereum
      token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      amount: "1000000",
      payTo: TEST_PAY_TO,
      now: 1_800_000_000,
      nonce: "999",
    });
    // Try to recover assuming the message was for Polygon — should
    // fail because Permit2's domain includes chainId.
    const recovered = await recoverTypedDataAddress({
      domain: buildPermit2Domain(137),
      types: PERMIT2_TYPES,
      primaryType: PERMIT2_PRIMARY_TYPE,
      message: buildPermit2Message(payload.permit2Authorization),
      signature: payload.signature,
    });
    expect(recovered).not.toBe(TEST_ADDRESS);
  });
});

describe("Permit2 round-trip across all USDT-registered chains", () => {
  for (const tok of allPermit2Tokens()) {
    it(`recovers signing address for USDT on chain ${tok.chainId} (${tok.symbol}, dec ${tok.decimals})`, async () => {
      const { payload } = await signPermit2Authorization({
        secret: TEST_MNEMONIC,
        network: `eip155:${tok.chainId}`,
        token: tok.address,
        amount: "5000000",
        payTo: TEST_PAY_TO,
        now: 1_800_000_000,
      });
      const recovered = await recoverTypedDataAddress({
        domain: buildPermit2Domain(tok.chainId),
        types: PERMIT2_TYPES,
        primaryType: PERMIT2_PRIMARY_TYPE,
        message: buildPermit2Message(payload.permit2Authorization),
        signature: payload.signature,
      });
      expect(recovered).toBe(TEST_ADDRESS);
      expect(payload.permit2Authorization.permitted.token).toBe(tok.address);
    });
  }
});
