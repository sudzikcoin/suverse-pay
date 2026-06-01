/**
 * Static registry of every SuVerse-controlled wallet that the
 * admin /dashboard/wallets page needs to surface. The dashboard
 * deliberately does NOT consult the proxy's seller_proxy_configs
 * table for this: those rows describe customer-facing payTo
 * addresses, while this registry tracks the infra wallets we
 * operate ourselves (merchants for our own endpoints + the swap
 * liquidity wallets + smoke-test buyers).
 *
 * Adding a wallet here is a one-line code change — no migrations,
 * no env, no admin UI. That trades a tiny bit of friction for a
 * very small attack surface: nobody can register an arbitrary
 * address as "SuVerse infrastructure" by mutating a row.
 *
 * The IDs are stable URL slugs (used in
 * `/dashboard/wallets/<id>` and `/api/wallets/<id>/...`); never
 * rename one in place — add a new entry and deprecate.
 */

export type WalletNetwork =
  | "eip155:8453" // Base mainnet
  | "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" // Solana mainnet
  | "cosmos:noble-1"; // Noble mainnet

/**
 * Coarse functional category — drives UI grouping and rules:
 *  - `merchant`   receives x402 payments for our own endpoints.
 *  - `swap`       runs Jupiter / LiFi swaps; holds liquidity + fees.
 *  - `service`    outbound payer for upstream OATP wraps + ops.
 *  - `test-buyer` Claude-owned for internal smoke tests; safe to
 *                 surface alongside real wallets only because the
 *                 page is admin-gated.
 */
export type WalletKind = "merchant" | "swap" | "service" | "test-buyer";

export interface SuverseWallet {
  /** URL-safe slug — stable identifier. */
  id: string;
  /** On-chain address (EVM checksum / Solana base58 / bech32). */
  address: string;
  network: WalletNetwork;
  kind: WalletKind;
  /** Short label for cards / nav. */
  label: string;
  /** One-sentence description of what the wallet does. */
  purpose: string;
  /**
   * Whether SuVerse holds the private key. Drives "can refund"
   * decisions in the orphan-detection UI; never sent to the
   * client without an admin session.
   */
  hasPrivateKey: boolean;
  /** BaseScan / Solscan / mintscan link, prebuilt. */
  explorerUrl: string;
  /**
   * Optional initial operating capital (USDC atomic, 6 dp). For
   * swap wallets, the "earned fees" metric subtracts this from
   * total balance to reveal pure profit. Set to "0" when not
   * meaningful or unknown.
   */
  operatingCapitalAtomic?: string;
}

export const SUVERSE_WALLETS: readonly SuverseWallet[] = [
  {
    id: "base-merchant",
    address: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
    network: "eip155:8453",
    kind: "merchant",
    label: "Base Merchant",
    purpose:
      "Receives x402 payments from SuVerse-owned data endpoints (CoinGecko, DeFiLlama, etc.) on Base.",
    hasPrivateKey: false,
    explorerUrl:
      "https://basescan.org/address/0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
  },
  {
    id: "base-buyer",
    address: "0x3869dE7597bDEa0172B97143f3eed806D8b84bf3",
    network: "eip155:8453",
    kind: "test-buyer",
    label: "Base Buyer (smoke)",
    purpose:
      "Claude-owned buyer wallet used for internal smoke tests against Base endpoints.",
    hasPrivateKey: true,
    explorerUrl:
      "https://basescan.org/address/0x3869dE7597bDEa0172B97143f3eed806D8b84bf3",
  },
  {
    id: "base-swap",
    address: "0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E",
    network: "eip155:8453",
    kind: "swap",
    label: "Base Swap",
    purpose:
      "Receives buyer USDC, executes LiFi-routed Base swaps, holds the 1% service fee.",
    hasPrivateKey: true,
    explorerUrl:
      "https://basescan.org/address/0x4261701A4dDf4625EBfA80CEefB5B3B2b5453B2E",
    // Seeded operating capital (USDC, 6 dp). Adjust as deposits change.
    operatingCapitalAtomic: "5000000",
  },
  {
    id: "solana-merchant",
    address: "CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    kind: "merchant",
    label: "Solana Merchant",
    purpose:
      "Receives x402 payments from SuVerse-owned data endpoints on Solana.",
    hasPrivateKey: false,
    explorerUrl:
      "https://solscan.io/account/CBYMYxfMGdA98qkzrYqTzTiQhP3H2scU95EB4ZxoRxuM",
  },
  {
    id: "solana-service",
    address: "26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    kind: "service",
    label: "Solana Service",
    purpose:
      "Outbound payer for upstream OATP wraps and internal Solana operations.",
    hasPrivateKey: true,
    explorerUrl:
      "https://solscan.io/account/26edvkZ99Lfs6LEwfSbfbJG17NM6z4BqrWMk7Z8hTe4D",
  },
  {
    id: "solana-swap",
    address: "HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    kind: "swap",
    label: "Solana Swap",
    purpose:
      "Receives buyer USDC, executes Jupiter-routed Solana swaps, holds the 1% service fee.",
    hasPrivateKey: true,
    explorerUrl:
      "https://solscan.io/account/HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw",
    operatingCapitalAtomic: "0",
  },
  {
    id: "cosmos-merchant",
    address: "noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj",
    network: "cosmos:noble-1",
    kind: "merchant",
    label: "Cosmos (Noble) Merchant",
    purpose:
      "Receives x402 payments from SuVerse-owned endpoints on Noble mainnet.",
    hasPrivateKey: false,
    explorerUrl:
      "https://www.mintscan.io/noble/address/noble1z5g7vts3pfjsgschfjrhq5s3ze6etxjl5lj2rj",
  },
] as const;

/** Indexed lookup by id. Throws on unknown id — caller guards with `tryGet`. */
export function getWalletById(id: string): SuverseWallet {
  const w = SUVERSE_WALLETS.find((w) => w.id === id);
  if (!w) throw new Error(`unknown_wallet_id: ${id}`);
  return w;
}

/** Soft variant — returns undefined on unknown id. */
export function tryGetWalletById(id: string): SuverseWallet | undefined {
  return SUVERSE_WALLETS.find((w) => w.id === id);
}

/** Convenience: addresses keyed by network for batch RPC calls. */
export function walletsByChain(): {
  base: SuverseWallet[];
  solana: SuverseWallet[];
  cosmos: SuverseWallet[];
} {
  return {
    base: SUVERSE_WALLETS.filter((w) => w.network === "eip155:8453"),
    solana: SUVERSE_WALLETS.filter((w) =>
      w.network.startsWith("solana:"),
    ),
    cosmos: SUVERSE_WALLETS.filter((w) => w.network.startsWith("cosmos:")),
  };
}

/**
 * Coarse chain bucket (for RPC routing). Returns "base" / "solana" /
 * "cosmos" — matches the existing onchain-balances chain enum.
 */
export function chainOf(w: SuverseWallet): "base" | "solana" | "cosmos" {
  if (w.network === "eip155:8453") return "base";
  if (w.network.startsWith("solana:")) return "solana";
  return "cosmos";
}
