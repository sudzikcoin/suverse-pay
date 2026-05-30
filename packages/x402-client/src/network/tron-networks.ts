/**
 * TRON network + TRC-20 token registry. The buyer SDK ships
 * `tron:mainnet` + `tron:nile` (testnet). Asset coverage is
 * USDT-first because that's overwhelmingly the dominant stablecoin
 * on TRON; Tether on TRON is the largest USDT deployment by volume
 * globally. USDC-on-TRON exists but is rarely used.
 *
 * Sources for the registry values: the suverse-pay BofAI adapter's
 * `tron-tokens.ts` (which mirrors BofAI's `specs/config.md`,
 * verified against `apilist.tronscanapi.com/api/token_trc20`).
 *
 * IMPORTANT for buyers: USDT-on-TRON is **6 decimals**, not 18 like
 * BSC's BUSD-Pegged USDT. The amount in atomic units must always be
 * scaled by 1e6.
 */

export const TRON_MAINNET = "tron:mainnet";
export const TRON_NILE = "tron:nile";

export type TronNetwork = typeof TRON_MAINNET | typeof TRON_NILE;

export interface TronToken {
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly network: TronNetwork;
  /** Base58 address — 34 chars, "T" prefix. Wire form. */
  readonly addressBase58: string;
}

export const TRON_TOKENS: readonly TronToken[] = [
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    network: TRON_MAINNET,
    addressBase58: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    network: TRON_NILE,
    addressBase58: "TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf",
  },
];

const TOKEN_INDEX: ReadonlyMap<string, TronToken> = new Map(
  TRON_TOKENS.map((t) => [`${t.network}:${t.addressBase58}`, t] as const),
);

export function lookupTronToken(
  network: string,
  asset: string,
): TronToken | undefined {
  return TOKEN_INDEX.get(`${network}:${asset}`);
}

export function isSupportedTronNetwork(network: string): boolean {
  return network === TRON_MAINNET || network === TRON_NILE;
}

/**
 * gasfree.io minimum payment per the public docs as of 2026-05.
 * Below this the relayer rejects with a "value too low" error. The
 * buyer SDK refuses to sign at amounts < `GASFREE_MIN_USDT_ATOMIC`
 * to avoid burning signatures on doomed attempts.
 *
 * Atomic units (6 decimals) — `1_500_000` = $1.50 USDT.
 */
export const GASFREE_MIN_USDT_ATOMIC = 1_500_000n;
