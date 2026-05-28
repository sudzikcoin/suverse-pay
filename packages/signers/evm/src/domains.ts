/**
 * Trusted EIP-712 domains for (chain, ERC-20 contract) pairs that
 * implement EIP-3009 transferWithAuthorization.
 *
 * IMPORTANT: these `name` and `version` values must match what each
 * token's contract returns from its public `eip712Domain()` (or
 * `name()` + `version()`). Phase 2 sources them from Circle's
 * deployment metadata for native USDC and EURC; full on-chain
 * verification against a live RPC happens only when Coinbase CDP
 * settle becomes available in v0.3+. The round-trip recover test in
 * `sign.test.ts` only proves EIP-712 math is consistent; it does NOT
 * prove the (name, version, address) tuple is the real contract's
 * domain. Treat these as best-known until CDP smoke confirms.
 *
 * Phase 2 supports Base (8453), Polygon (137), Arbitrum (42161).
 * Phase 3 patch (v0.3.1) added Base Sepolia (84532) — Circle's test
 * USDC deployment, used by `scripts/smoke/real-evm/` for the real
 * Coinbase CDP smoke. Note: the test contract's EIP-712 domain name
 * is `"USDC"`, NOT `"USD Coin"` — different from the mainnet entry.
 * Phase 4 (v0.3.2) added World Chain mainnet (480) + World Sepolia
 * (4801) — bridged Circle USDC, both with EIP-712 domain
 * `name="USDC"` / `version="2"` (also verified via `eth_call`).
 * Ethereum mainnet (1), Optimism (10), Avalanche (43114), and other
 * networks are deferred — CDP does not advertise them today.
 */

export interface EvmTokenDomain {
  /** Symbol used in error messages and discovery. */
  readonly symbol: string;
  /** EIP-712 domain `name`. */
  readonly name: string;
  /** EIP-712 domain `version`. */
  readonly version: string;
  readonly chainId: number;
  /** ERC-20 contract address — `verifyingContract` for EIP-712. */
  readonly verifyingContract: `0x${string}`;
  /** Atomic-unit decimals; informational. USDC/EURC = 6. */
  readonly decimals: number;
}

/**
 * Lowercase address used as map key, since callers may pass mixed-case
 * checksummed addresses. EIP-712 `verifyingContract` itself is
 * case-insensitive for the hash.
 */
type AddressKey = `0x${string}`;
type DomainKey = `${number}:${AddressKey}`;

function key(chainId: number, address: string): DomainKey {
  return `${chainId}:${address.toLowerCase() as AddressKey}`;
}

const DOMAIN_TABLE: Record<DomainKey, EvmTokenDomain> = (() => {
  const entries: EvmTokenDomain[] = [
    // USDC — native Circle deployments on Base, Polygon, Arbitrum.
    {
      symbol: "USDC",
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
    },
    {
      symbol: "USDC",
      name: "USD Coin",
      version: "2",
      chainId: 137,
      verifyingContract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      decimals: 6,
    },
    {
      symbol: "USDC",
      name: "USD Coin",
      version: "2",
      chainId: 42161,
      verifyingContract: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      decimals: 6,
    },
    // USDC on Base Sepolia (Circle's testnet deployment). Domain name
    // is "USDC" not "USD Coin" — verified on-chain via name() at
    // 0x036CbD53842c5426634e7929541eC2318f3dCF7e.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 84532,
      verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      decimals: 6,
    },
    // USDC on World Chain mainnet (bridged Circle USDC). Domain name
    // is "USDC" — verified on-chain via name() at
    // 0x79A02482A880bCE3F13e09Da970dC34db4CD24d1. CDP /supported
    // advertises eip155:480 with all three schemes.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 480,
      verifyingContract: "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1",
      decimals: 6,
    },
    // USDC on World Sepolia (testnet). Domain name is "USDC" —
    // verified on-chain via name() at
    // 0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88. CDP /supported
    // advertises eip155:4801 with all three schemes.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 4801,
      verifyingContract: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88",
      decimals: 6,
    },

    // EURC — Circle's euro stablecoin. Currently deployed on Base; on
    // Polygon/Arbitrum it is not yet available, so we list only Base
    // here. Add other chains when Circle deploys.
    {
      symbol: "EURC",
      name: "EURC",
      version: "1",
      chainId: 8453,
      verifyingContract: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
      decimals: 6,
    },
  ];
  const map: Record<DomainKey, EvmTokenDomain> = {};
  for (const d of entries) {
    map[key(d.chainId, d.verifyingContract)] = d;
  }
  return map;
})();

export const SUPPORTED_CHAIN_IDS = [8453, 137, 42161, 84532, 480, 4801] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export function isSupportedChainId(n: number): n is SupportedChainId {
  return (SUPPORTED_CHAIN_IDS as readonly number[]).includes(n);
}

/**
 * Look up a trusted domain for a (chainId, contract address) pair.
 * Returns null if the pair is not in our table — callers should
 * surface this as "unsupported token on this network".
 */
export function getDomain(chainId: number, contract: string): EvmTokenDomain | null {
  return DOMAIN_TABLE[key(chainId, contract)] ?? null;
}

/** All domains we know about. Used by tests for round-trip coverage. */
export function allDomains(): EvmTokenDomain[] {
  return Object.values(DOMAIN_TABLE);
}

/**
 * Parse a CAIP-2 EVM network identifier ("eip155:<chainId>") into the
 * underlying chainId. Throws if the network is not CAIP-2 EVM.
 */
export function chainIdFromNetwork(network: string): number {
  if (!network.startsWith("eip155:")) {
    throw new Error(`network ${network} is not an EVM CAIP-2 identifier`);
  }
  const id = Number(network.slice("eip155:".length));
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`network ${network} has invalid chain id`);
  }
  return id;
}
