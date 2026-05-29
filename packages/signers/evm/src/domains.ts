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
 * Phase 4 Block 1 Sub-task 2 added Avalanche C-Chain mainnet
 * (43114), Avalanche Fuji (43113), and Arbitrum Sepolia (421614)
 * — all native Circle USDC with EIP-712 domain `name="USD Coin"` /
 * `version="2"` (also `eth_call`-verified). These are routed
 * through the PayAI facilitator adapter (CDP doesn't advertise
 * them).
 *
 * Phase 4 Block 1 Sub-task 3 (Thirdweb adapter) added Ethereum
 * mainnet (1) and Optimism mainnet (10) — both native Circle USDC
 * with EIP-712 domain `name="USD Coin"` / `version="2"`, verified
 * on-chain via `eth_call name()` / `version()` / `decimals()`
 * against publicnode + mainnet.optimism.io RPCs respectively.
 *
 * Phase 4 Block 2 Sub-task 5 expands Thirdweb routing to 9 more EVM
 * mainnets: XDC (50), Monad mainnet (143), Sonic (146), Sei mainnet
 * (1329), Abstract (2741), IoTeX (4689), Celo (42220), Ink (57073),
 * Linea (59144). All probed via chain-specific public RPCs
 * (erpc.xinfin.network, rpc.monad.xyz, rpc.soniclabs.com,
 * evm-rpc.sei-apis.com, api.mainnet.abs.xyz,
 * babel-api.mainnet.iotex.io, forno.celo.org, rpc-gel.inkonchain.com,
 * rpc.linea.build). Domain `name` strings vary across deployments —
 * Abstract advertises `"Bridged USDC (Stargate)"`, IoTeX advertises
 * `"Bridged USDC"`, the rest are plain `"USDC"`. These are NOT
 * guesses — the strings come from `eth_call name()` on the deployed
 * contract and the EIP-712 hash depends on them being exact.
 *
 * Networks Thirdweb advertises but Sub-task 5 skipped (left for a
 * follow-up):
 *   - Flare (14): contract at advertised address returns `0x` on
 *     three public RPCs (flare-api.flare.network, ankr, public-rpc).
 *   - Gravity (1776): `rpc.gravity.xyz` returns `0x`, `gravity.drpc.org`
 *     returns `Not Found`; no working RPC discovered.
 *   - Ham (5112): no resolvable public RPC.
 *
 * BNB Chain (56) and Permit-only networks (Peaq 3338, Berachain
 * testnet 80069 advertising Honey not USDC) await a separate
 * EIP-2612 signing path — see docs/design/non-cdp-evm-adapter.md.
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
    // Native Circle USDC on Avalanche C-Chain mainnet — domain is
    // "USD Coin" (mainnet, not the "USDC" test-deployment variant),
    // verified via eth_call name(). Routed through PayAI (CDP does
    // not advertise eip155:43114 on x402).
    {
      symbol: "USDC",
      name: "USD Coin",
      version: "2",
      chainId: 43114,
      verifyingContract: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
      decimals: 6,
    },
    // Native Circle USDC on Avalanche Fuji (testnet) — verified
    // on-chain. Same domain shape as mainnet ("USD Coin", v2).
    {
      symbol: "USDC",
      name: "USD Coin",
      version: "2",
      chainId: 43113,
      verifyingContract: "0x5425890298aed601595a70AB815c96711a31Bc65",
      decimals: 6,
    },
    // Native Circle USDC on Arbitrum Sepolia (testnet) — verified
    // on-chain. Domain `name="USD Coin"` like Arbitrum mainnet.
    {
      symbol: "USDC",
      name: "USD Coin",
      version: "2",
      chainId: 421614,
      verifyingContract: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      decimals: 6,
    },
    // Native Circle USDC on Ethereum mainnet — verified on-chain via
    // eth_call name()/version() against publicnode (returns "USD Coin"
    // / "2"). Routed through Thirdweb (CDP + PayAI don't advertise
    // eip155:1 on x402 as of 2026-05-29).
    {
      symbol: "USDC",
      name: "USD Coin",
      version: "2",
      chainId: 1,
      verifyingContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
    },
    // Native Circle USDC on Optimism mainnet — verified on-chain via
    // eth_call name()/version() against mainnet.optimism.io (returns
    // "USD Coin" / "2"). Routed through Thirdweb (CDP + PayAI don't
    // advertise eip155:10 on x402 as of 2026-05-29). This is the
    // headline network Phase 4 Block 1 Sub-task 3 unlocked.
    {
      symbol: "USDC",
      name: "USD Coin",
      version: "2",
      chainId: 10,
      verifyingContract: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
      decimals: 6,
    },
    // ---- Phase 4 Block 2 Sub-task 5 — Thirdweb-routed EVM mainnets ---
    // USDC on XDC Network — verified via erpc.xinfin.network.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 50,
      verifyingContract: "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1",
      decimals: 6,
    },
    // USDC on Monad mainnet — verified via rpc.monad.xyz.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 143,
      verifyingContract: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
      decimals: 6,
    },
    // USDC on Sonic — verified via rpc.soniclabs.com.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 146,
      verifyingContract: "0x29219dd400f2Bf60E5a23d13Be72B486D4038894",
      decimals: 6,
    },
    // USDC on Sei mainnet — verified via evm-rpc.sei-apis.com.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 1329,
      verifyingContract: "0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392",
      decimals: 6,
    },
    // Bridged USDC on Abstract — verified via api.mainnet.abs.xyz.
    // Domain name is "Bridged USDC (Stargate)" — the Stargate-bridged
    // variant, NOT plain Circle USDC. EIP-712 hash differs from
    // mainnet USDC; do not collapse these into one entry.
    {
      symbol: "USDC",
      name: "Bridged USDC (Stargate)",
      version: "2",
      chainId: 2741,
      verifyingContract: "0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1",
      decimals: 6,
    },
    // Bridged USDC on IoTeX — verified via babel-api.mainnet.iotex.io.
    // Domain name is "Bridged USDC" (no parenthetical) — a third
    // distinct variant from "USD Coin" and "Bridged USDC (Stargate)".
    {
      symbol: "USDC",
      name: "Bridged USDC",
      version: "2",
      chainId: 4689,
      verifyingContract: "0xcdf79194c6c285077a58da47641d4dbe51f63542",
      decimals: 6,
    },
    // Native USDC on Celo — verified via forno.celo.org.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 42220,
      verifyingContract: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      decimals: 6,
    },
    // USDC on Ink (Optimism Superchain L2) — verified via rpc-gel.inkonchain.com.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 57073,
      verifyingContract: "0x2D270e6886d130D724215A266106e6832161EAEd",
      decimals: 6,
    },
    // USDC on Linea — verified via rpc.linea.build.
    {
      symbol: "USDC",
      name: "USDC",
      version: "2",
      chainId: 59144,
      verifyingContract: "0x176211869cA2b568f2A7D4EE941E073a821EE1ff",
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

export const SUPPORTED_CHAIN_IDS = [
  1,       // Ethereum mainnet
  10,      // Optimism mainnet
  50,      // XDC
  137,     // Polygon
  143,     // Monad mainnet
  146,     // Sonic
  480,     // World Chain mainnet
  1329,    // Sei mainnet
  2741,    // Abstract (Bridged USDC Stargate)
  4689,    // IoTeX (Bridged USDC)
  4801,    // World Sepolia
  8453,    // Base mainnet
  42161,   // Arbitrum mainnet
  42220,   // Celo
  43113,   // Avalanche Fuji
  43114,   // Avalanche C-Chain mainnet
  57073,   // Ink
  59144,   // Linea
  84532,   // Base Sepolia
  421614,  // Arbitrum Sepolia
] as const;
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
