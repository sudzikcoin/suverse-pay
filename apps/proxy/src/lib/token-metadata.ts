/**
 * Token metadata resolver for Solana SPL tokens.
 *
 * Source of truth is the Jupiter strict token list at
 * https://tokens.jup.ag/tokens — covers all liquid SPL tokens with
 * symbol, name, decimals, and a logo URL. Fetched once and cached
 * in-process for an hour.
 *
 * For tokens NOT on the Jupiter list (long-tail or freshly-launched
 * SPLs), we fall back to Helius `getAsset` via DAS, which returns
 * on-chain metadata. When that also misses or no Helius key is
 * configured, we return an UNKNOWN stub so callers always have a
 * non-null shape.
 *
 * No DB I/O. Pure in-memory + outbound HTTP. Safe to call from
 * request handlers (the cache absorbs the second+ call per process).
 */

export interface TokenMetadata {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

export interface GetTokenMetadataOpts {
  fetchImpl?: typeof fetch;
  /** Pass to enable Helius DAS fallback for tokens absent from Jupiter list. */
  heliusApiKey?: string;
}

interface CacheEntry {
  byMint: Map<string, TokenMetadata>;
  fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const JUPITER_TOKENS_URL = "https://tokens.jup.ag/tokens";

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

function jupiterTokenListUrl(): string {
  return process.env["JUPITER_TOKEN_LIST_URL"] ?? JUPITER_TOKENS_URL;
}

async function loadJupiterList(
  fetchImpl: typeof fetch = fetch,
): Promise<CacheEntry> {
  const res = await fetchImpl(jupiterTokenListUrl(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`jupiter_tokens_${res.status}`);
  }
  const raw = (await res.json()) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error("jupiter_tokens_unexpected_shape");
  }
  const byMint = new Map<string, TokenMetadata>();
  for (const entry of raw) {
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
    const name = typeof e["name"] === "string" ? (e["name"] as string) : symbol;
    const logoURI =
      typeof e["logoURI"] === "string" ? (e["logoURI"] as string) : undefined;
    byMint.set(address, {
      mint: address,
      symbol,
      name,
      decimals,
      ...(logoURI ? { logoURI } : {}),
    });
  }
  return { byMint, fetchedAt: Date.now() };
}

async function ensureCache(
  fetchImpl: typeof fetch = fetch,
): Promise<CacheEntry | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt <= CACHE_TTL_MS) return cache;
  if (!inflight) {
    inflight = loadJupiterList(fetchImpl)
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
    // Network/upstream failure. Return the stale cache if we still
    // have one — better to serve slightly old metadata than nothing.
    return cache;
  }
}

async function tryHelius(
  mint: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenMetadata | null> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "token-metadata",
    method: "getAsset",
    params: { id: mint },
  });
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as unknown;
    if (typeof json !== "object" || json === null) return null;
    const result = (json as Record<string, unknown>)["result"];
    if (typeof result !== "object" || result === null) return null;
    const r = result as Record<string, unknown>;
    const tokenInfo = r["token_info"] as Record<string, unknown> | undefined;
    const content = r["content"] as Record<string, unknown> | undefined;
    const metadata = content?.["metadata"] as Record<string, unknown> | undefined;
    const decimals =
      typeof tokenInfo?.["decimals"] === "number"
        ? (tokenInfo["decimals"] as number)
        : null;
    if (decimals === null) return null;
    const symbol =
      (typeof tokenInfo?.["symbol"] === "string"
        ? (tokenInfo["symbol"] as string)
        : undefined) ??
      (typeof metadata?.["symbol"] === "string"
        ? (metadata["symbol"] as string)
        : undefined);
    if (!symbol) return null;
    const name =
      (typeof metadata?.["name"] === "string"
        ? (metadata["name"] as string)
        : undefined) ?? symbol;
    const links = content?.["links"] as Record<string, unknown> | undefined;
    const logoURI =
      typeof links?.["image"] === "string"
        ? (links["image"] as string)
        : undefined;
    return {
      mint,
      symbol,
      name,
      decimals,
      ...(logoURI ? { logoURI } : {}),
    };
  } catch {
    return null;
  }
}

function unknown(mint: string): TokenMetadata {
  return { mint, symbol: "UNKNOWN", name: mint, decimals: 0 };
}

/**
 * Resolve metadata for `mint`. Order of attempts:
 *  1. In-memory Jupiter list cache (refreshed every hour).
 *  2. Helius DAS `getAsset` — only if `opts.heliusApiKey` is set.
 *  3. UNKNOWN stub — symbol="UNKNOWN", decimals=0.
 *
 * NEVER throws; NEVER returns null. Caller can assume the return is
 * safe to render straight into a quote response.
 */
export async function getTokenMetadata(
  mint: string,
  opts?: GetTokenMetadataOpts,
): Promise<TokenMetadata> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const entry = await ensureCache(fetchImpl);
  if (entry) {
    const hit = entry.byMint.get(mint);
    if (hit) return hit;
  }
  if (opts?.heliusApiKey) {
    const helius = await tryHelius(mint, opts.heliusApiKey, fetchImpl);
    if (helius) {
      // Memoize into the same cache so repeat lookups in this process
      // don't keep hitting Helius. Falls out when cache TTL rolls.
      if (entry) entry.byMint.set(mint, helius);
      return helius;
    }
  }
  return unknown(mint);
}

/**
 * Atomic-units → "X.XXXXX SYMBOL" string, using the resolved decimals.
 * For UNKNOWN tokens (decimals=0) the result is "<raw> <symbol>",
 * which is honest and not misleading.
 */
export function formatTokenAmount(
  atomic: bigint,
  meta: TokenMetadata,
): string {
  const decimals = Number.isInteger(meta.decimals) && meta.decimals >= 0
    ? meta.decimals
    : 0;
  if (decimals === 0) return `${atomic.toString()} ${meta.symbol}`;
  const sign = atomic < 0n ? "-" : "";
  const abs = atomic < 0n ? -atomic : atomic;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  if (frac === 0n) return `${sign}${whole} ${meta.symbol}`;
  const fracStr = frac
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return fracStr
    ? `${sign}${whole}.${fracStr} ${meta.symbol}`
    : `${sign}${whole} ${meta.symbol}`;
}

// --------------------------------------------------------- test helpers ----

/** Wipe in-memory state — call from test setup. */
export function _resetTokenMetadataCache(): void {
  cache = null;
  inflight = null;
}

/** Seed cache directly — call from tests to avoid network. */
export function _seedTokenMetadataCache(entries: TokenMetadata[]): void {
  cache = {
    byMint: new Map(entries.map((e) => [e.mint, e])),
    fetchedAt: Date.now(),
  };
}
