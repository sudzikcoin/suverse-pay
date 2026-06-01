/**
 * Token metadata resolver for ERC20 tokens on Base mainnet.
 *
 * Most swaps in our /v1/swap/base flow go USDC → one of a small set
 * of popular Base tokens, so we ship a hardcoded map for the common
 * case (zero network round-trip) and fall back to LiFi's free
 * `/v1/tokens?chains=8453` endpoint for the long tail. Last resort
 * is an UNKNOWN stub so callers never have to branch on null.
 *
 * Why not 1inch's token list: 1inch /tokens now requires a bearer
 * API key. LiFi's is anonymous and rate-limited per IP, which keeps
 * the proxy key-free for v1.
 *
 * Addresses are case-insensitive — we normalize via `getAddress` to
 * EIP-55 checksum form before lookup so callers can pass either
 * form interchangeably.
 */

import { getAddress, type Address } from "viem";
import type { TokenMetadata } from "./token-metadata.js";

export interface GetBaseTokenMetadataOpts {
  fetchImpl?: typeof fetch;
}

interface CacheEntry {
  byAddress: Map<string, TokenMetadata>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const BASE_CHAIN_ID = 8453;

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

/**
 * Popular Base tokens. Addresses are EIP-55 checksum form so map
 * keys match `getAddress(input).toString()`.
 */
const HARDCODED: TokenMetadata[] = [
  {
    mint: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
  },
  {
    mint: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
  },
  {
    mint: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    symbol: "AERO",
    name: "Aerodrome Finance",
    decimals: 18,
  },
  {
    mint: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
    symbol: "cbETH",
    name: "Coinbase Wrapped Staked ETH",
    decimals: 18,
  },
  {
    mint: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
    symbol: "DEGEN",
    name: "Degen",
    decimals: 18,
  },
  {
    mint: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    symbol: "USDbC",
    name: "USD Base Coin",
    decimals: 6,
  },
  {
    mint: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    symbol: "EURC",
    name: "EURC",
    decimals: 6,
  },
];

const HARDCODED_BY_ADDR: Map<string, TokenMetadata> = new Map(
  HARDCODED.map((m) => [m.mint, m]),
);

function lifiTokensUrl(): string {
  const base = process.env["LIFI_API_BASE_URL"] ?? "https://li.quest";
  return `${base}/v1/tokens?chains=${BASE_CHAIN_ID}`;
}

async function loadLifiList(
  fetchImpl: typeof fetch = fetch,
): Promise<CacheEntry> {
  const res = await fetchImpl(lifiTokensUrl(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`lifi_tokens_${res.status}`);
  }
  const raw = (await res.json()) as unknown;
  if (typeof raw !== "object" || raw === null) {
    throw new Error("lifi_tokens_unexpected_shape");
  }
  const tokens = (raw as Record<string, unknown>)["tokens"];
  if (typeof tokens !== "object" || tokens === null) {
    throw new Error("lifi_tokens_no_tokens_field");
  }
  const byChain = (tokens as Record<string, unknown>)[String(BASE_CHAIN_ID)];
  if (!Array.isArray(byChain)) {
    throw new Error("lifi_tokens_no_base_chain");
  }
  const byAddress = new Map<string, TokenMetadata>();
  for (const entry of byChain) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const address = e["address"];
    const symbol = e["symbol"];
    const decimals = e["decimals"];
    if (
      typeof address !== "string" ||
      typeof symbol !== "string" ||
      typeof decimals !== "number"
    ) {
      continue;
    }
    let checksum: string;
    try {
      checksum = getAddress(address as Address);
    } catch {
      continue;
    }
    const name = typeof e["name"] === "string" ? (e["name"] as string) : symbol;
    const logoURI =
      typeof e["logoURI"] === "string" ? (e["logoURI"] as string) : undefined;
    byAddress.set(checksum, {
      mint: checksum,
      symbol,
      name,
      decimals,
      ...(logoURI ? { logoURI } : {}),
    });
  }
  return { byAddress, fetchedAt: Date.now() };
}

async function ensureCache(
  fetchImpl: typeof fetch = fetch,
): Promise<CacheEntry | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt <= CACHE_TTL_MS) return cache;
  if (!inflight) {
    inflight = loadLifiList(fetchImpl)
      .then((entry) => {
        cache = entry;
        inflight = null;
        return entry;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });
  }
  try {
    return await inflight;
  } catch {
    return cache;
  }
}

function normalize(address: string): string | null {
  try {
    return getAddress(address as Address);
  } catch {
    return null;
  }
}

function unknownStub(address: string): TokenMetadata {
  return { mint: address, symbol: "UNKNOWN", name: address, decimals: 0 };
}

/**
 * Resolve metadata for an ERC20 `address` on Base. Order:
 *  1. Hardcoded popular-token map (no network).
 *  2. LiFi `/v1/tokens?chains=8453` cache, refreshed hourly.
 *  3. UNKNOWN stub — symbol="UNKNOWN", decimals=0.
 *
 * Never throws. Never returns null.
 */
export async function getBaseTokenMetadata(
  address: string,
  opts?: GetBaseTokenMetadataOpts,
): Promise<TokenMetadata> {
  const checksum = normalize(address);
  if (!checksum) return unknownStub(address);
  const hardcoded = HARDCODED_BY_ADDR.get(checksum);
  if (hardcoded) return hardcoded;
  const entry = await ensureCache(opts?.fetchImpl ?? fetch);
  if (entry) {
    const hit = entry.byAddress.get(checksum);
    if (hit) return hit;
  }
  return unknownStub(checksum);
}

// --------------------------------------------------------- test helpers ----

export function _resetBaseTokenMetadataCache(): void {
  cache = null;
  inflight = null;
}

export function _seedBaseTokenMetadataCache(entries: TokenMetadata[]): void {
  const byAddress = new Map<string, TokenMetadata>();
  for (const e of entries) {
    const checksum = normalize(e.mint);
    if (!checksum) continue;
    byAddress.set(checksum, { ...e, mint: checksum });
  }
  cache = { byAddress, fetchedAt: Date.now() };
}
