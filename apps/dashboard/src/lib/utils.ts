import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn idiom — class composition with Tailwind merge. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format atomic USDC units (the `amount` column on facilitator_payments
 * is a uint256 stored as TEXT) into a human-readable USD string.
 *
 * Most tokens we route are 6-decimal (USDC, EURC, USDT-on-Ethereum,
 * etc.), but BSC and Tempo stablecoins are 18-decimal. The caller
 * passes `decimals` from the registry — we never assume.
 */
export function formatUsd(atomicAmount: string, decimals = 6): string {
  if (atomicAmount === "" || atomicAmount === "0") return "$0.00";
  // BigInt to avoid precision loss for large amounts. Then we slice
  // to derive whole + fractional parts without touching JS Number.
  const value = BigInt(atomicAmount);
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = value % divisor;
  const fracStr = frac.toString().padStart(decimals, "0");
  // Show 2-4 decimal places: 2 by default, more if it would round to 0.
  const trimmed = fracStr.replace(/0+$/, "");
  const displayFrac = trimmed.length === 0
    ? "00"
    : trimmed.length === 1
    ? trimmed + "0"
    : trimmed.slice(0, Math.max(2, Math.min(4, trimmed.length)));
  return "$" + whole.toLocaleString("en-US") + "." + displayFrac;
}

/** Format an integer settle count with thousands separators. */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** Format a percent — 0.973 → "97.3%". */
export function formatPercent(ratio: number, decimals = 1): string {
  if (!Number.isFinite(ratio)) return "—";
  return (ratio * 100).toFixed(decimals) + "%";
}

/**
 * Relative time string for the settles table. Last 24h uses a
 * human-feel "5 min ago" / "2 hr ago"; older falls back to an
 * absolute timestamp because relative grows noisy past a day.
 */
export function formatRelativeTime(when: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - when.getTime();
  if (diffMs < 60_000) return "just now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  // Older — absolute Mon DD, HH:MM (locale-aware).
  return when.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Block explorer URL for a settled tx hash. Maps CAIP-2 network → the
 * canonical explorer per chain. Unknown networks fall back to null
 * (caller should render the hash without a hyperlink).
 */
const EXPLORERS: Record<string, (tx: string) => string> = {
  "eip155:1":     (tx) => `https://etherscan.io/tx/${tx}`,
  "eip155:10":    (tx) => `https://optimistic.etherscan.io/tx/${tx}`,
  "eip155:56":    (tx) => `https://bscscan.com/tx/${tx}`,
  "eip155:137":   (tx) => `https://polygonscan.com/tx/${tx}`,
  "eip155:480":   (tx) => `https://worldscan.org/tx/${tx}`,
  "eip155:4217":  (tx) => `https://explore.tempo.xyz/tx/${tx}`,
  "eip155:8453":  (tx) => `https://basescan.org/tx/${tx}`,
  "eip155:42161": (tx) => `https://arbiscan.io/tx/${tx}`,
  "eip155:43114": (tx) => `https://snowtrace.io/tx/${tx}`,
  "eip155:84532": (tx) => `https://sepolia.basescan.org/tx/${tx}`,
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": (tx) =>
    `https://solscan.io/tx/${tx}`,
  "tron:mainnet": (tx) => `https://tronscan.org/#/transaction/${tx}`,
  "cosmos:noble-1": (tx) =>
    `https://www.mintscan.io/noble/transactions/${tx}`,
};

export function explorerUrl(network: string, txHash: string): string | null {
  const f = EXPLORERS[network];
  return f ? f(txHash) : null;
}

/**
 * Render a CAIP-2 network identifier in a compact way for tables:
 * `eip155:8453` → `Base`, `tron:mainnet` → `TRON`, etc. Unknown
 * networks fall through to the raw identifier so nothing is hidden.
 */
const NETWORK_LABELS: Record<string, string> = {
  "eip155:1": "Ethereum",
  "eip155:10": "Optimism",
  "eip155:50": "XDC",
  "eip155:56": "BNB Chain",
  "eip155:137": "Polygon",
  "eip155:143": "Monad",
  "eip155:146": "Sonic",
  "eip155:480": "World Chain",
  "eip155:1329": "Sei",
  "eip155:2741": "Abstract",
  "eip155:4217": "Tempo",
  "eip155:4689": "IoTeX",
  "eip155:8453": "Base",
  "eip155:42161": "Arbitrum",
  "eip155:42220": "Celo",
  "eip155:43114": "Avalanche",
  "eip155:57073": "Ink",
  "eip155:59144": "Linea",
  "eip155:84532": "Base Sepolia",
  "tron:mainnet": "TRON",
  "tron:nile": "TRON Nile",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "Solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "Solana Devnet",
  "cosmos:noble-1": "Noble",
  "cosmos:grand-1": "Noble Grand",
};

export function networkLabel(network: string): string {
  return NETWORK_LABELS[network] ?? network;
}

export function truncateMiddle(s: string, head = 6, tail = 4): string {
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + "…" + s.slice(-tail);
}
