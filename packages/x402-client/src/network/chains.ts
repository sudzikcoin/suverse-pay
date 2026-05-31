/**
 * Registry of EVM chains the client knows how to sign for.
 *
 * Every per-chain `usdc.eip712Name` / `eip712Version` here came from
 * `eth_call name()` / `version()` against the deployed contract — NOT
 * guessed. The EIP-712 domain hash is sensitive to these strings; one
 * character off and the signature will fail at the contract's
 * recover step. Source of truth + verification trail lives in
 * `packages/signers/evm/src/domains.ts` in this monorepo; this file
 * vendors the values so the public client package is self-contained.
 *
 * Adding a new chain here without `eth_call`-verifying the domain
 * strings will break payments on that chain. Do not skip the
 * verification step.
 */

export type CostClass = "l1" | "l2" | "testnet";

export interface UsdcOnChain {
  /** ERC-20 contract address (checksum-cased per EIP-55). */
  readonly address: `0x${string}`;
  readonly decimals: number;
  /** EIP-712 domain `name` returned by `name()` on the contract. */
  readonly eip712Name: string;
  /** EIP-712 domain `version` returned by `version()` on the contract. */
  readonly eip712Version: string;
}

export interface ChainEntry {
  /** CAIP-2 id used in x402 challenge `network` field. */
  readonly caip2: `eip155:${number}`;
  readonly chainId: number;
  readonly displayName: string;
  /** Native gas token symbol — informational only. */
  readonly nativeToken: string;
  readonly usdc: UsdcOnChain;
  /**
   * Rough routing cost class. Used to pick the cheapest chain when
   * the seller accepts several and the buyer hasn't expressed a
   * preference. testnet is treated as free and is selected last when
   * the buyer has both mainnet and testnet wallets — to avoid
   * accidentally paying on testnet for a mainnet good.
   */
  readonly costClass: CostClass;
  /**
   * Whether the deployed USDC contract implements EIP-3009
   * `transferWithAuthorization`. `false` for chains where the
   * canonical "USDC" is a bridged 18-decimal token (BSC) or a
   * variant whose `version()` reverts (Tempo) — the EVM signer
   * refuses these with a clear message rather than producing
   * unverifiable signatures.
   */
  readonly eip3009Supported: boolean;
  readonly testnet: boolean;
  /**
   * Free-text note shown in error messages when this chain is
   * declined for `eip3009Supported: false`. Keeps the explanation
   * grep-able without a switch statement elsewhere.
   */
  readonly skipReason?: string;
}

export const CHAINS: readonly ChainEntry[] = [
  // ---- L2 mainnets (cheapest gas, first preference) -----------------
  {
    caip2: "eip155:8453",
    chainId: 8453,
    displayName: "Base",
    nativeToken: "ETH",
    usdc: {
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
      eip712Name: "USD Coin",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:10",
    chainId: 10,
    displayName: "Optimism",
    nativeToken: "ETH",
    usdc: {
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      decimals: 6,
      eip712Name: "USD Coin",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:42161",
    chainId: 42161,
    displayName: "Arbitrum",
    nativeToken: "ETH",
    usdc: {
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      decimals: 6,
      eip712Name: "USD Coin",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:137",
    chainId: 137,
    displayName: "Polygon",
    nativeToken: "MATIC",
    usdc: {
      address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      decimals: 6,
      eip712Name: "USD Coin",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:480",
    chainId: 480,
    displayName: "World Chain",
    nativeToken: "ETH",
    usdc: {
      address: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:43114",
    chainId: 43114,
    displayName: "Avalanche C-Chain",
    nativeToken: "AVAX",
    usdc: {
      address: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      decimals: 6,
      eip712Name: "USD Coin",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:42220",
    chainId: 42220,
    displayName: "Celo",
    nativeToken: "CELO",
    usdc: {
      address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:59144",
    chainId: 59144,
    displayName: "Linea",
    nativeToken: "ETH",
    usdc: {
      address: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:57073",
    chainId: 57073,
    displayName: "Ink",
    nativeToken: "ETH",
    usdc: {
      address: "0x2D270e6886d130D724215A266106e6832161EAEd",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:50",
    chainId: 50,
    displayName: "XDC Network",
    nativeToken: "XDC",
    usdc: {
      address: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:143",
    chainId: 143,
    displayName: "Monad",
    nativeToken: "MON",
    usdc: {
      address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:146",
    chainId: 146,
    displayName: "Sonic",
    nativeToken: "S",
    usdc: {
      address: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:1329",
    chainId: 1329,
    displayName: "Sei",
    nativeToken: "SEI",
    usdc: {
      address: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:2741",
    chainId: 2741,
    displayName: "Abstract",
    nativeToken: "ETH",
    usdc: {
      address: "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1",
      decimals: 6,
      eip712Name: "Bridged USDC (Stargate)",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  {
    caip2: "eip155:4689",
    chainId: 4689,
    displayName: "IoTeX",
    nativeToken: "IOTX",
    usdc: {
      address: "0xcdf79194c6c285077a58da47641d4dbe51f63542",
      decimals: 6,
      eip712Name: "Bridged USDC",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },
  // SKALE Base — Phase 5 Sub-task 7. L3 atop Coinbase Base. The native
  // gas token is CREDIT (pre-paid by the operator/facilitator), so the
  // buyer never sees gas costs. USDC.e is the SKALE Bridge-issued
  // USDC; on-chain name() returns "Bridged USDC (SKALE Bridge)" —
  // verified 2026-05-31 via eth_call against
  // skale-base.skalenodes.com.
  {
    caip2: "eip155:1187947933",
    chainId: 1187947933,
    displayName: "SKALE Base",
    nativeToken: "CREDIT",
    usdc: {
      address: "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20",
      decimals: 6,
      eip712Name: "Bridged USDC (SKALE Bridge)",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: true,
    testnet: false,
  },

  // ---- L1 mainnets (expensive gas — selected last by cost rank) ----
  {
    caip2: "eip155:1",
    chainId: 1,
    displayName: "Ethereum",
    nativeToken: "ETH",
    usdc: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
      eip712Name: "USD Coin",
      eip712Version: "2",
    },
    costClass: "l1",
    eip3009Supported: true,
    testnet: false,
  },

  // ---- EVM chains where USDC does NOT implement EIP-3009 -----------
  // Kept in the registry so the signer rejects them with a clear
  // message instead of silently failing at on-chain recover.
  {
    caip2: "eip155:4217",
    chainId: 4217,
    displayName: "Tempo",
    nativeToken: "(stablecoin gas)",
    usdc: {
      address: "0x20C000000000000000000000b9537d11c60E8b50",
      decimals: 6,
      eip712Name: "Bridged USDC (Stargate)",
      eip712Version: "2",
    },
    costClass: "l2",
    eip3009Supported: false,
    testnet: false,
    skipReason:
      "Tempo USDC's `version()` reverts on-chain; EIP-3009 signatures cannot be verified. Use the MPP / Stripe settlement path advertised by the seller's facilitator instead.",
  },
  {
    caip2: "eip155:56",
    chainId: 56,
    displayName: "BNB Chain",
    nativeToken: "BNB",
    usdc: {
      // Binance-Peg USDC — 18-decimal, NOT EIP-3009.
      address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      decimals: 18,
      eip712Name: "BUSDC",
      eip712Version: "1",
    },
    costClass: "l1",
    eip3009Supported: false,
    testnet: false,
    skipReason:
      "BNB Chain's Binance-Peg USDC is 18-decimal and uses EIP-2612 permit (not EIP-3009). Pay through the Binance x402 adapter or Permit2 path.",
  },

  // ---- Testnets ----------------------------------------------------
  {
    caip2: "eip155:84532",
    chainId: 84532,
    displayName: "Base Sepolia",
    nativeToken: "ETH",
    usdc: {
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "testnet",
    eip3009Supported: true,
    testnet: true,
  },
  {
    caip2: "eip155:43113",
    chainId: 43113,
    displayName: "Avalanche Fuji",
    nativeToken: "AVAX",
    usdc: {
      address: "0x5425890298aed601595a70AB815c96711a31Bc65",
      decimals: 6,
      eip712Name: "USD Coin",
      eip712Version: "2",
    },
    costClass: "testnet",
    eip3009Supported: true,
    testnet: true,
  },
  {
    caip2: "eip155:421614",
    chainId: 421614,
    displayName: "Arbitrum Sepolia",
    nativeToken: "ETH",
    usdc: {
      address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      decimals: 6,
      eip712Name: "USD Coin",
      eip712Version: "2",
    },
    costClass: "testnet",
    eip3009Supported: true,
    testnet: true,
  },
  {
    caip2: "eip155:4801",
    chainId: 4801,
    displayName: "World Sepolia",
    nativeToken: "ETH",
    usdc: {
      address: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88",
      decimals: 6,
      eip712Name: "USDC",
      eip712Version: "2",
    },
    costClass: "testnet",
    eip3009Supported: true,
    testnet: true,
  },
  // SKALE Base Sepolia — Phase 5 Sub-task 7 test surface. Same on-chain
  // shape as mainnet (Bridged USDC (SKALE Bridge) / version "2"),
  // verified via eth_call against base-sepolia-testnet.skalenodes.com.
  {
    caip2: "eip155:324705682",
    chainId: 324705682,
    displayName: "SKALE Base Sepolia",
    nativeToken: "CREDIT",
    usdc: {
      address: "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD",
      decimals: 6,
      eip712Name: "Bridged USDC (SKALE Bridge)",
      eip712Version: "2",
    },
    costClass: "testnet",
    eip3009Supported: true,
    testnet: true,
  },
];

// ---------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------

const BY_CAIP2: ReadonlyMap<string, ChainEntry> = new Map(
  CHAINS.map((c) => [c.caip2, c] as const),
);
const BY_CHAIN_ID: ReadonlyMap<number, ChainEntry> = new Map(
  CHAINS.map((c) => [c.chainId, c] as const),
);

export function lookupByCaip2(caip2: string): ChainEntry | undefined {
  return BY_CAIP2.get(caip2);
}

export function lookupByChainId(chainId: number): ChainEntry | undefined {
  return BY_CHAIN_ID.get(chainId);
}

/**
 * Parse the numeric chainId out of a CAIP-2 `eip155:<id>` string.
 * Returns `null` for non-EVM ids (`solana:`, `cosmos:`, `tron:`).
 */
export function chainIdFromCaip2(caip2: string): number | null {
  if (!caip2.startsWith("eip155:")) return null;
  const tail = caip2.slice("eip155:".length);
  if (!/^[1-9][0-9]*$/.test(tail)) return null;
  const n = Number(tail);
  return Number.isSafeInteger(n) ? n : null;
}

export function isSupportedEvmCaip2(caip2: string): boolean {
  return BY_CAIP2.has(caip2);
}
