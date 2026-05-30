/**
 * Solana network + SPL token registry. CAIP-2 ids are the
 * genesis-hash form per the x402 SVM spec
 * (`specs/schemes/exact/scheme_exact_svm.md`).
 */

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

export const SUPPORTED_SOLANA_NETWORKS = [
  SOLANA_MAINNET,
  SOLANA_DEVNET,
] as const;

export type SolanaNetwork = (typeof SUPPORTED_SOLANA_NETWORKS)[number];

export function isSupportedSolanaNetwork(network: string): boolean {
  return (SUPPORTED_SOLANA_NETWORKS as readonly string[]).includes(network);
}

/** Default JSON-RPC URL per network. Used when no override is passed. */
export const DEFAULT_RPC_URL: Record<SolanaNetwork, string> = {
  [SOLANA_MAINNET]: "https://api.mainnet-beta.solana.com",
  [SOLANA_DEVNET]: "https://api.devnet.solana.com",
};

/**
 * Known SPL token mints we recognise across both Solana networks.
 * `decimals` is the on-chain decimals — used to build a safe
 * `transferChecked` instruction when the seller's
 * `requirement.extra.decimals` is missing.
 *
 * Adding a new mint here without verifying `decimals` against the
 * deployed Token program will produce signatures that the recipient
 * rejects. The values here come from Circle (USDC), Tether (USDT),
 * and the standard PayAI devnet USDC contract used by the suverse-pay
 * solana smoke suite.
 */
export interface SolanaToken {
  /** SPL mint pubkey (base58). */
  readonly mint: string;
  readonly decimals: number;
  readonly symbol: string;
  readonly network: SolanaNetwork;
}

export const SOLANA_TOKENS: readonly SolanaToken[] = [
  // ---- Mainnet ----
  {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
    symbol: "USDC",
    network: SOLANA_MAINNET,
  },
  {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
    symbol: "USDT",
    network: SOLANA_MAINNET,
  },
  // ---- Devnet ----
  {
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    decimals: 6,
    symbol: "USDC-devnet",
    network: SOLANA_DEVNET,
  },
];

const TOKEN_INDEX: ReadonlyMap<string, SolanaToken> = new Map(
  SOLANA_TOKENS.map((t) => [`${t.network}:${t.mint}`, t] as const),
);

export function lookupToken(
  network: string,
  mint: string,
): SolanaToken | undefined {
  return TOKEN_INDEX.get(`${network}:${mint}`);
}
