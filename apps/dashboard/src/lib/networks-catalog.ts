/**
 * Curated catalog of networks a seller can accept payments on through
 * the suverse-pay facilitator.
 *
 * Source of truth: services/facilitator/src/routing-config.ts in this
 * repo. When a new network is added there, mirror it here so the
 * dashboard's "Accepted networks" picker stays in sync.
 *
 * This is the UI-facing list — display labels, recommended flags,
 * and the per-network USDC asset address that gets inlined into the
 * generated middleware snippets.
 */

/**
 * Address families ("namespaces" in CAIP-10 vocabulary). A seller
 * needs exactly one receiving address per family they enable; the
 * configure UI hides payTo inputs for families with no enabled
 * networks.
 */
export type NamespaceFamily = "evm" | "solana" | "cosmos" | "tron";

export interface NetworkEntry {
  /** CAIP-2-style id used in 402 challenges + facilitator routing. */
  readonly caip2: string;
  /** Display label shown in the picker. */
  readonly label: string;
  /** Address family the seller's payTo must come from. */
  readonly namespace: NamespaceFamily;
  /**
   * Asset address (token contract / mint) that gets inlined into the
   * generated middleware snippet. Always native Circle USDC where
   * available; falls back to documented bridged USDC for chains
   * Circle hasn't shipped natively (e.g. Avalanche, World).
   */
  readonly usdcAsset: string;
  /**
   * USDC decimals on this chain. Always 6 today (Circle is consistent
   * across deployments) but kept per-row so a future BNB-Chain-style
   * 18-decimal token can be plugged in without changing the schema.
   */
  readonly usdcDecimals: 6 | 18;
  /** "recommended" badge in the picker. */
  readonly recommended?: boolean;
  /**
   * Optional short hint shown under the row (e.g. "cheapest gas",
   * "testnet — for development only").
   */
  readonly hint?: string;
  /** "testnet" flag groups testnets at the bottom of the picker. */
  readonly testnet?: boolean;
}

export const NETWORKS_CATALOG: readonly NetworkEntry[] = [
  // ---- EVM mainnets ------------------------------------------------
  {
    caip2: "eip155:8453",
    label: "Base (Coinbase L2)",
    namespace: "evm",
    usdcAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
    recommended: true,
    hint: "cheapest gas, sponsored by CDP",
  },
  // SKALE Base — Phase 5 Sub-task 7. L3 chain on top of Coinbase Base
  // (eip155:8453 above); different chain entirely. USDC.e is the SKALE
  // Bridge-issued USDC. End-user UX is gasless (the L3 uses a CREDIT
  // model where the facilitator pre-pays compute). Routed via PayAI
  // only — no failover until another facilitator picks up SKALE Base.
  {
    caip2: "eip155:1187947933",
    label: "SKALE Base",
    namespace: "evm",
    usdcAsset: "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20",
    usdcDecimals: 6,
    hint: "zero gas fees — gasless UX via SKALE L3",
  },
  {
    caip2: "eip155:137",
    label: "Polygon",
    namespace: "evm",
    usdcAsset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    usdcDecimals: 6,
  },
  {
    caip2: "eip155:42161",
    label: "Arbitrum",
    namespace: "evm",
    usdcAsset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcDecimals: 6,
  },
  {
    caip2: "eip155:10",
    label: "Optimism",
    namespace: "evm",
    usdcAsset: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    usdcDecimals: 6,
  },
  {
    caip2: "eip155:43114",
    label: "Avalanche C-Chain",
    namespace: "evm",
    usdcAsset: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    usdcDecimals: 6,
  },
  {
    caip2: "eip155:56",
    label: "BNB Chain",
    namespace: "evm",
    usdcAsset: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    usdcDecimals: 18,
    hint: "18-decimal Binance-Peg USDC",
  },
  {
    caip2: "eip155:1",
    label: "Ethereum mainnet",
    namespace: "evm",
    usdcAsset: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdcDecimals: 6,
  },
  {
    caip2: "eip155:42220",
    label: "Celo",
    namespace: "evm",
    usdcAsset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    usdcDecimals: 6,
  },
  {
    caip2: "eip155:59144",
    label: "Linea",
    namespace: "evm",
    usdcAsset: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
    usdcDecimals: 6,
  },
  {
    caip2: "eip155:480",
    label: "World Chain",
    namespace: "evm",
    usdcAsset: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
    usdcDecimals: 6,
  },

  // ---- EVM testnet (kept short, just Base Sepolia) -----------------
  {
    caip2: "eip155:84532",
    label: "Base Sepolia",
    namespace: "evm",
    usdcAsset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcDecimals: 6,
    testnet: true,
    hint: "for testing — CDP minimum 1000 atomic ($0.001)",
  },
  {
    caip2: "eip155:324705682",
    label: "SKALE Base Sepolia",
    namespace: "evm",
    usdcAsset: "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD",
    usdcDecimals: 6,
    testnet: true,
    hint: "faucet: base-sepolia-faucet.skale.space",
  },

  // ---- Non-EVM mainnets --------------------------------------------
  {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    label: "Solana",
    namespace: "solana",
    usdcAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    usdcDecimals: 6,
    hint: "via PayAI / Coinbase CDP",
  },
  {
    caip2: "cosmos:noble-1",
    label: "Cosmos · Noble",
    namespace: "cosmos",
    usdcAsset: "uusdc",
    usdcDecimals: 6,
    hint: "native USDC on Noble Cosmos chain",
  },
  {
    caip2: "tron:mainnet",
    label: "TRON",
    namespace: "tron",
    usdcAsset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    usdcDecimals: 6,
    hint: "Tether is dominant on TRON — USDC routing via BofAI",
  },
];

/** O(1) lookup by CAIP-2 id. */
const BY_CAIP2: ReadonlyMap<string, NetworkEntry> = new Map(
  NETWORKS_CATALOG.map((n) => [n.caip2, n] as const),
);

export function lookupNetwork(caip2: string): NetworkEntry | undefined {
  return BY_CAIP2.get(caip2);
}

/** Whitelist used by Zod / API route validation. */
export const SUPPORTED_CAIP2_IDS: ReadonlySet<string> = new Set(
  NETWORKS_CATALOG.map((n) => n.caip2),
);

/** Group networks by namespace for the picker layout. */
export function groupByNamespace(): Record<NamespaceFamily, NetworkEntry[]> {
  const out: Record<NamespaceFamily, NetworkEntry[]> = {
    evm: [],
    solana: [],
    cosmos: [],
    tron: [],
  };
  for (const n of NETWORKS_CATALOG) out[n.namespace].push(n);
  return out;
}

/**
 * Which namespace families are represented in a selection? Used by
 * the UI to decide which payTo input rows to show and by the API
 * route to decide which payTo* fields are required.
 */
export function selectionNamespaces(
  caip2Ids: readonly string[],
): ReadonlySet<NamespaceFamily> {
  const out = new Set<NamespaceFamily>();
  for (const id of caip2Ids) {
    const entry = BY_CAIP2.get(id);
    if (entry) out.add(entry.namespace);
  }
  return out;
}
