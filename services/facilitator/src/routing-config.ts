/**
 * Routing priority for /facilitator/settle.
 *
 * Keyed by `${network}:${scheme}`. Value is an ordered list of
 * adapter ids — the first id is the primary; subsequent are
 * tried on retryable errors from the primary.
 *
 * Today the table is static. Phase 4+ TODO: hot-reload from a
 * `routing_config.json` file so operators can adjust failover order
 * without redeploying (already-running settles aren't affected
 * because each settle reads the snapshot once at request entry).
 *
 * Devnet/testnet routes are present alongside mainnet so the same
 * gateway binary can serve test environments without code changes.
 */
export type RoutingPriority = ReadonlyArray<string>;

export const ROUTING_CONFIG: Readonly<Record<string, RoutingPriority>> = {
  // ---- Cosmos -------------------------------------------------------
  // cosmos-pay was repointed from Noble TESTNET (grand-1) to MAINNET
  // (noble-1) on 2026-05-30 — the running facilitator now signs with
  // the mainnet grantee `noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt`,
  // CapabilityDiscoveryCron superseded the grand-1 row in
  // provider_capabilities. We mirror that in the static routing config
  // so /facilitator/supported (which reads from this map intersected
  // with the registry) advertises noble-1 instead of grand-1.
  "cosmos:noble-1:exact_cosmos_authz": ["cosmos-pay"],
  // Sub-task 10 — Cosmos MAINNET route in the gateway via t402-io's
  // `cosmos:noble-1` advertisement (native USDT on Noble,
  // `exact-direct` scheme — direct ERC-20-style transfer, NOT the
  // Cosmos-authz variant cosmos-pay uses, and NOT plain `exact`
  // either). Single-adapter, no failover. t402-io requires an API
  // key for /settle (T402_IO_API_KEY env var); the route is registered
  // so capability discovery + dashboards work without a key.
  "cosmos:noble-1:exact-direct": ["t402-io"],

  // ---- EVM ----------------------------------------------------------
  // CDP-primary networks. PayAI added as failover in Phase 4 Block 1
  // Sub-task 2 for every (network, scheme) pair that BOTH adapters
  // advertise — gives the gateway a real second EVM facilitator
  // without new adapter code.
  "eip155:8453:exact":  ["coinbase-cdp", "payai"],
  "eip155:137:exact":   ["coinbase-cdp", "payai"],
  "eip155:42161:exact": ["coinbase-cdp", "payai"],
  // Base Sepolia — added in v0.3.1 alongside scripts/smoke/real-evm/
  // so the same gateway binary serves the real EVM smoke without code
  // changes. CDP's `/supported` advertises eip155:84532 alongside the
  // mainnet entries. PayAI also covers Base Sepolia → failover.
  "eip155:84532:exact": ["coinbase-cdp", "payai"],
  // World Chain (mainnet + Sepolia) — CDP-confirmed via /supported,
  // NOT in PayAI's EVM list — CDP-only routes.
  "eip155:480:exact":  ["coinbase-cdp"],
  "eip155:4801:exact": ["coinbase-cdp"],
  // PayAI-primary EVM routes (Phase 4 Block 1 Sub-task 2 + Sub-task 5
  // failover). CDP does NOT advertise these networks on x402; PayAI
  // does. Phase 4 Block 2 Sub-task 5 added Thirdweb as a secondary on
  // each of these three (Thirdweb /supported lists all three with the
  // identical USDC contract — see thirdweb-supported.json fixture).
  // PayAI stays primary because its EVM coverage is already exercised
  // in Sub-task 2's smoke; Thirdweb is here for resilience.
  "eip155:43114:exact":  ["payai", "thirdweb-x402"], // Avalanche C-Chain mainnet
  "eip155:43113:exact":  ["payai", "thirdweb-x402"], // Avalanche Fuji testnet
  "eip155:421614:exact": ["payai", "thirdweb-x402"], // Arbitrum Sepolia testnet
  // SKALE Base (Phase 5 Sub-task 7). L3 on top of Coinbase Base — see
  // packages/signers/evm/src/domains.ts header comment for the on-chain
  // verification of the USDC.e contract and EIP-3009 support. PayAI is
  // the only adapter advertising these networks today; no failover.
  // Known limitation documented in README until a second facilitator
  // picks up SKALE Base. Until S7 testnet smoke turns green this route
  // is not advertised as "supported" in any public materials.
  "eip155:1187947933:exact": ["payai"], // SKALE Base mainnet
  "eip155:324705682:exact":  ["payai"], // SKALE Base Sepolia testnet
  // Thirdweb-exclusive EVM routes (Phase 4 Block 1 Sub-task 3). CDP
  // does not advertise these on x402 and PayAI's /supported does not
  // list them either; Thirdweb's Nexus facilitator is the only route.
  "eip155:1:exact":  ["thirdweb-x402"], // Ethereum mainnet
  "eip155:10:exact": ["thirdweb-x402"], // Optimism mainnet
  // Phase 4 Block 2 Sub-task 5 — 9 more Thirdweb-exclusive EVM
  // mainnets. All on-chain-USDC-verified via eth_call; details and
  // RPC sources in packages/signers/evm/src/domains.ts header. No
  // failover (single adapter advertises these). Add to the routing
  // tier when another facilitator picks up the network.
  "eip155:50:exact":    ["thirdweb-x402"], // XDC
  "eip155:143:exact":   ["thirdweb-x402"], // Monad mainnet
  "eip155:146:exact":   ["thirdweb-x402"], // Sonic
  "eip155:1329:exact":  ["thirdweb-x402"], // Sei mainnet
  "eip155:2741:exact":  ["thirdweb-x402"], // Abstract (Bridged USDC Stargate)
  "eip155:4689:exact":  ["thirdweb-x402"], // IoTeX (Bridged USDC)
  "eip155:42220:exact": ["thirdweb-x402"], // Celo
  "eip155:57073:exact": ["thirdweb-x402"], // Ink
  "eip155:59144:exact": ["thirdweb-x402"], // Linea
  // BNB Chain (eip155:56) — Binance x402 primary (Sub-task 7);
  // BofAI x402 added as failover in Sub-task 8 because BofAI's
  // /supported also advertises eip155:56 with the same Binance-Peg
  // USDC + USDT contracts. Operators get adapter-level resilience on
  // BSC. Asset-level dispatch (USDC vs USDT) still happens via
  // PaymentRequirements.extra.assetTransferMethod.
  "eip155:56:exact": ["binance-x402", "bofai-x402"],
  // BSC mainnet also supports exact_permit via BofAI (Binance hasn't
  // confirmed it on their surface yet — single-adapter route to BofAI
  // until Binance advertises permit). exact_permit signing is itself
  // Phase 5 work (no signer-evm Permit support yet), so this entry
  // is for capability discovery / dashboard surfacing only today.
  "eip155:56:exact_permit": ["bofai-x402"],
  // BSC testnet via BofAI — useful staging ground for BSC integration.
  "eip155:97:exact": ["bofai-x402"],
  "eip155:97:exact_permit": ["bofai-x402"],

  // ---- TRON (Phase 4 Block 2 Sub-task 8) -----------------------------
  // First non-EVM, non-Solana, non-Cosmos routes in the gateway.
  // BofAI is the only adapter today; native signer-tron arrives in
  // Phase 5 to enable first-party signing. Adapter forwards
  // verify/settle for callers who produce TIP-712 signatures via an
  // external SDK (e.g. BofAI's TypeScript client).
  "tron:mainnet:exact":         ["bofai-x402"],
  "tron:mainnet:exact_permit":  ["bofai-x402"],
  "tron:mainnet:exact_gasfree": ["bofai-x402"], // GasFree: relayer pays gas — TRON's flagship UX
  "tron:nile:exact":            ["bofai-x402"], // testnet, primary smoke target
  "tron:nile:exact_permit":     ["bofai-x402"],
  "tron:nile:exact_gasfree":    ["bofai-x402"],

  // ---- Solana mainnet (CDP primary, PayAI failover) -----------------
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:exact": ["coinbase-cdp", "payai"],

  // ---- Solana devnet (PayAI only) -----------------------------------
  // PayAI's /supported advertises both v1 ("solana-devnet") and v2
  // ("solana:Etwt...") entries; we route the v2 form. Useful for
  // Sub-task 7 real smoke without burning mainnet USDC.
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:exact": ["payai"],
};

export function routingKey(network: string, scheme: string): string {
  return `${network}:${scheme}`;
}

export function getRoutingPriority(
  network: string,
  scheme: string,
): RoutingPriority | undefined {
  return ROUTING_CONFIG[routingKey(network, scheme)];
}
