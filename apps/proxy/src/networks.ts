/**
 * Network catalog used by the proxy to build accepted-payment entries.
 *
 * Mirrors apps/dashboard/src/lib/networks-catalog.ts. Duplicating the
 * data here keeps the proxy free of dashboard imports (different
 * runtimes — dashboard is bundled by Next.js, proxy is plain Node).
 * Both tables must be kept in sync — the test suite asserts that.
 */

export interface NetworkEntry {
  readonly caip2: string;
  readonly label: string;
  readonly namespace: "evm" | "solana" | "cosmos" | "tron";
  readonly usdcAsset: string;
  readonly usdcDecimals: 6 | 18;
  readonly testnet?: boolean;
}

export const NETWORKS: readonly NetworkEntry[] = [
  // EVM mainnets
  {
    caip2: "eip155:8453",
    label: "Base",
    namespace: "evm",
    usdcAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcDecimals: 6,
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
  // EVM testnet
  {
    caip2: "eip155:84532",
    label: "Base Sepolia",
    namespace: "evm",
    usdcAsset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcDecimals: 6,
    testnet: true,
  },
  // Non-EVM
  {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    label: "Solana",
    namespace: "solana",
    usdcAsset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    usdcDecimals: 6,
  },
  {
    caip2: "cosmos:noble-1",
    label: "Cosmos · Noble",
    namespace: "cosmos",
    usdcAsset: "uusdc",
    usdcDecimals: 6,
  },
  {
    caip2: "tron:mainnet",
    label: "TRON",
    namespace: "tron",
    usdcAsset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    usdcDecimals: 6,
  },
];

const BY_CAIP2 = new Map(NETWORKS.map((n) => [n.caip2, n]));

export function lookupNetwork(caip2: string): NetworkEntry | undefined {
  return BY_CAIP2.get(caip2);
}

export const SUPPORTED_CAIP2: ReadonlySet<string> = new Set(
  NETWORKS.map((n) => n.caip2),
);
