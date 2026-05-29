/**
 * TRON TRC-20 token registry — used by the BofAI adapter to construct
 * its static capability list. Phase 4 Block 2 Sub-task 8.
 *
 * This is the only TRON-aware module in the workspace today;
 * suverse-pay doesn't yet have a native `signer-tron`. When the
 * Phase 5 TRON signer lands, this registry should migrate to a
 * package owned by signer-tron (so EIP-712 / TIP-712 domains and
 * token metadata live together).
 *
 * Addresses + metadata come from BofAI's
 * `specs/config.md` (cloned 2026-05-29 from BofAI/x402 main branch).
 * USDT-on-TRON canonical address verified via
 * `apilist.tronscanapi.com/api/token_trc20`:
 *   name="Tether USD", symbol="USDT", decimals=6.
 *
 * TRON address formats: the Base58 form (T-prefix, 34 chars) is what
 * goes on the wire and into PaymentRequirements.asset. The raw hex
 * form (41-prefix) is the on-chain calldata representation and EVM
 * tooling converts it by replacing `41` with `0x` — recorded here
 * for diagnostics only.
 *
 * NB: USDT-on-TRON is 6 decimals, NOT 18 like USDT-on-BSC. Each
 * registry must read this field; never hard-code scaling.
 */

export interface TronTokenEntry {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** CAIP-2 network — `tron:mainnet`, `tron:shasta`, `tron:nile`. */
  readonly network: `tron:${string}`;
  /** Base58 address (the wire / PaymentRequirements form). */
  readonly addressBase58: string;
}

/**
 * Statically known TRC-20 tokens on the three TRON networks BofAI
 * advertises. Extend when adding tokens; `discoverCapabilities`
 * cross-joins this list with BofAI's `/supported` response.
 */
export const TRON_TOKENS: ReadonlyArray<TronTokenEntry> = [
  // Tether USD on TRON mainnet — the single largest USDT deployment
  // by volume globally. Verified via Tronscan API + matches BofAI's
  // specs/config.md.
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    network: "tron:mainnet",
    addressBase58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  },
  // Tether USD on TRON Nile testnet — primary smoke target per
  // BofAI's e2e suite.
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    network: "tron:nile",
    addressBase58: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
  },
  // Tether USD on TRON Shasta testnet — historical, included for
  // completeness.
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    network: "tron:shasta",
    addressBase58: "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs",
  },
];

export function getTronUsdt(network: string): TronTokenEntry | null {
  return TRON_TOKENS.find((t) => t.network === network && t.symbol === "USDT") ?? null;
}
