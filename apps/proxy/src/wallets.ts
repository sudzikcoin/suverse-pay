/**
 * Per-namespace wallet-address validators. Shared between the proxy
 * (defence-in-depth on read) and the dashboard's proxy-config API
 * route (rejecting bad input at write time). Keep these
 * dependency-free so the dashboard can import them unchanged.
 */

export type Namespace = "evm" | "solana" | "cosmos" | "tron";

/**
 * Returns true if `address` is a syntactically valid receive address
 * for the given namespace. Does NOT check on-chain existence or
 * checksum (EVM EIP-55) — the goal is to catch typos and wrong-chain
 * confusions before they reach a 402 challenge.
 */
export function isValidAddress(ns: Namespace, address: string): boolean {
  if (typeof address !== "string" || address.length === 0) return false;
  switch (ns) {
    case "evm":
      return /^0x[0-9a-fA-F]{40}$/.test(address);
    case "solana":
      // Base58 (no 0/O/I/l), 32–44 chars covers every Solana pubkey.
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    case "cosmos":
      // Noble's bech32 prefix is "noble1". Length 39–59 covers both
      // 20- and 32-byte payloads. We do NOT validate the bech32
      // checksum here (would pull in a 50KB dependency for marginal
      // gain — wrong-checksum addresses fail at the facilitator
      // anyway).
      return /^noble1[023456789acdefghjklmnpqrstuvwxyz]{30,52}$/.test(address);
    case "tron":
      // TRON base58check addresses always start with "T" and decode
      // to 25 bytes → 34 chars.
      return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
    default: {
      const _exhaust: never = ns;
      return _exhaust;
    }
  }
}

export const NAMESPACES: readonly Namespace[] = [
  "evm",
  "solana",
  "cosmos",
  "tron",
];

/** Map a CAIP-2 id to the namespace family. */
export function namespaceFor(caip2: string): Namespace | null {
  if (caip2.startsWith("eip155:")) return "evm";
  if (caip2.startsWith("solana:")) return "solana";
  if (caip2.startsWith("cosmos:")) return "cosmos";
  if (caip2.startsWith("tron:")) return "tron";
  return null;
}
