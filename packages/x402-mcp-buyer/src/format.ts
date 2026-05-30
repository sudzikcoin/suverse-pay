/**
 * Tiny formatters shared by tool renderers. Plain string helpers, no
 * external deps — kept here so the tool modules stay focused on
 * registration + logic and not on presentation.
 */

import type { Listing } from "./catalog/types.js";

/** Atomic USDC (6 decimals) → "$0.05" / "$0.50". Other units fall back to raw atomic. */
export function formatPriceRange(listing: Pick<Listing, "priceAtomicMin" | "priceAtomicMax" | "priceUnit">): string {
  if (listing.priceUnit.toLowerCase() === "usdc") {
    const lo = atomicToUsd(listing.priceAtomicMin);
    const hi = atomicToUsd(listing.priceAtomicMax);
    return lo === hi ? `$${lo}` : `$${lo}–$${hi}`;
  }
  if (listing.priceAtomicMin === listing.priceAtomicMax) {
    return `${listing.priceAtomicMin} ${listing.priceUnit}`;
  }
  return `${listing.priceAtomicMin}–${listing.priceAtomicMax} ${listing.priceUnit}`;
}

export function atomicToUsd(atomic: string): string {
  try {
    const n = BigInt(atomic);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac
      .toString()
      .padStart(6, "0")
      .replace(/0+$/, "")}`;
  } catch {
    return atomic;
  }
}

const CHAIN_LABELS: Record<string, string> = {
  "eip155:8453": "base",
  "eip155:1": "eth",
  "eip155:137": "polygon",
  "eip155:42161": "arb",
  "eip155:10": "op",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc6wjsTLnYjz": "solana",
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG": "solana-devnet",
  "cosmos:noble-1": "noble",
  "tron:tron-mainnet": "tron",
};

/** Pretty-print CAIP-2 ids, fall back to the raw id for unknown chains. */
export function formatNetworks(networks: ReadonlyArray<string>): string {
  if (networks.length === 0) return "none";
  return networks.map((n) => CHAIN_LABELS[n] ?? n).join(", ");
}
