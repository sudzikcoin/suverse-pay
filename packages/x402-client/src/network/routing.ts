/**
 * Network selection: pick which of the seller's `accepts` entries
 * the buyer pays. Honours user-supplied preferences and a coarse
 * cost-class ranking.
 *
 * Ranking (cheapest first):
 *   1. cosmos:noble-1                          — sub-cent fees
 *   2. solana:<mainnet>                         — sub-cent fees
 *   3. tron:* (mainnet only)                    — sponsored relay (if amount ≥ minimum)
 *   4. EVM L2 mainnets (Base, Arbitrum, …)      — single-cent gas
 *   5. EVM L1 (Ethereum)                        — multi-dollar gas
 *   6. testnets                                 — only if no mainnet match
 */

import { lookupByCaip2 } from "./chains.js";
import type {
  AcceptedRequirement,
  ChallengeBody,
  MultiChainWallets,
  Preferences,
} from "../types.js";
import {
  NoSupportedNetworkError,
  X402ClientError,
} from "../types.js";

export interface RoutingDecision {
  readonly requirement: AcceptedRequirement;
  readonly reason: string;
}

const COSMOS_NOBLE_NETWORK = "cosmos:noble-1";
const TRON_MIN_AMOUNT_ATOMIC = 1_500_000n; // $1.50 USDT (6 decimals) — gasfree min sanity

export function selectRequirement(
  challenge: ChallengeBody,
  wallets: MultiChainWallets,
  prefs: Preferences = {},
): RoutingDecision {
  if (challenge.accepts.length === 0) {
    throw new X402ClientError(
      "empty_challenge",
      "challenge.accepts is empty — nothing to pay against",
    );
  }
  const candidates = challenge.accepts.filter((r) =>
    canSign(r, wallets, prefs),
  );
  if (candidates.length === 0) {
    throw new NoSupportedNetworkError(
      [
        `none of the seller's accepted networks match this client's configured wallets.`,
        `  seller accepts: ${challenge.accepts.map((r) => r.network).join(", ")}`,
        `  client has wallets for: ${describeWallets(wallets) || "(none)"}`,
        prefs.avoidNetworks && prefs.avoidNetworks.length > 0
          ? `  avoidNetworks: ${prefs.avoidNetworks.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  // Preference: if user pinned `preferredNetwork`, take it if present.
  if (prefs.preferredNetwork) {
    const pinned = candidates.find(
      (r) => r.network === prefs.preferredNetwork,
    );
    if (pinned) {
      return {
        requirement: pinned,
        reason: `preferred network ${prefs.preferredNetwork}`,
      };
    }
  }
  const ranked = [...candidates].sort(
    (a, b) => costRank(a.network) - costRank(b.network),
  );
  return {
    requirement: ranked[0]!,
    reason: `cheapest by class (${describeRank(costRank(ranked[0]!.network))})`,
  };
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function canSign(
  r: AcceptedRequirement,
  wallets: MultiChainWallets,
  prefs: Preferences,
): boolean {
  if (prefs.avoidNetworks?.includes(r.network)) return false;
  if (r.network.startsWith("eip155:")) {
    if (wallets.evm === undefined) return false;
    const chain = lookupByCaip2(r.network);
    return chain !== undefined && chain.eip3009Supported;
  }
  if (r.network.startsWith("solana:")) {
    return wallets.solana !== undefined;
  }
  if (r.network === COSMOS_NOBLE_NETWORK) {
    return wallets.cosmos !== undefined;
  }
  if (r.network.startsWith("tron:")) {
    if (wallets.tron === undefined) return false;
    // v0.1.0 ships only `exact_gasfree` for TRON — refuse other
    // schemes here so the client doesn't pick them and fail at sign
    // time. When future releases add `exact` / `exact_permit`, widen
    // this check to mirror TronSigner.supportedSchemes().
    if (r.scheme !== "exact_gasfree") return false;
    // Decline if amount is below the gasfree.io minimum so the client
    // doesn't burn signatures on attempts that will fail at the relay.
    try {
      return BigInt(r.amount) >= TRON_MIN_AMOUNT_ATOMIC;
    } catch {
      return false;
    }
  }
  return false;
}

function costRank(network: string): number {
  if (network === COSMOS_NOBLE_NETWORK) return 1;
  if (network.startsWith("solana:")) return 2;
  if (network.startsWith("tron:")) return 3;
  if (network === "eip155:1") return 5; // Ethereum L1
  if (network.startsWith("eip155:")) {
    const chain = lookupByCaip2(network);
    if (chain?.testnet) return 9;
    return 4; // EVM L2
  }
  return 8;
}

function describeRank(n: number): string {
  switch (n) {
    case 1:
      return "Cosmos Noble";
    case 2:
      return "Solana";
    case 3:
      return "TRON";
    case 4:
      return "EVM L2";
    case 5:
      return "EVM L1";
    case 9:
      return "testnet";
    default:
      return "unknown";
  }
}

function describeWallets(w: MultiChainWallets): string {
  const families: string[] = [];
  if (w.evm !== undefined) families.push("evm");
  if (w.solana !== undefined) families.push("solana");
  if (w.cosmos !== undefined) families.push("cosmos");
  if (w.tron !== undefined) families.push("tron");
  return families.join(", ");
}
