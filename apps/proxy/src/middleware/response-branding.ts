/**
 * Response-branding middleware. Adds X-Suverse-* HTTP headers to
 * settled proxy responses so AI buyer agents can discover the rest of
 * the SuVerse catalog without us touching the response payload.
 *
 * Why headers and not JSON fields:
 *   - Upstream bodies are arbitrary shapes (object, array, primitive,
 *     binary, NDJSON). Wrapping them would break parsers that key off
 *     the existing shape.
 *   - CDP Bazaar caches `output.example`. Adding marketing fields to
 *     the example payload would either pollute the catalog entry on
 *     re-index, or get silently dropped by CDP's schema validator.
 *   - Headers are out-of-band: clients that don't care never see
 *     them; clients that do can read them from their fetch wrapper.
 *
 * Headers emitted on settled-200 responses:
 *   X-Suverse-Provider   — static "SuVerse"
 *   X-Suverse-Catalog    — link to the public catalog
 *   X-Suverse-Search     — search URL template (YOUR_QUERY placeholder)
 *   X-Suverse-Mcp        — npx command for the buyer MCP
 *   X-Suverse-Swap       — chain-aware swap quote URL (see pickSwapUrl)
 *   X-Suverse-Related    — JSON array of 3 related endpoints (omitted
 *                          for swap endpoints to avoid recursion)
 *   X-Suverse-Tip        — context-aware text (see pickTip)
 *
 * Rollout strategy: BRANDING_ENABLED=false by default. Per-slug
 * allowlist (BRANDING_ALLOWLIST_SLUGS) lets the operator dark-launch
 * on a handful of endpoints before flipping the global flag.
 */

import { createHash } from "node:crypto";
import type { Pool } from "pg";

// ---------------------------------------------------------------- types

export interface BrandingConfig {
  /** Master switch. When false, only allowlisted slugs (if any) get branded. */
  enabled: boolean;
  /** Comma-split slug list; when non-empty, restricts branding to these slugs. */
  allowlistSlugs: string[];
  /** Comma-split slug list; these slugs never get branding even when enabled. */
  blacklistSlugs: string[];
}

export interface BrandingInput {
  /** Public identifier of the endpoint (publicSlug ?? endpointSlug). */
  slug: string;
  /** CAIP-2 networks the endpoint accepts. Drives swap/tip context. */
  acceptedNetworks: string[];
  /** Human-readable name. Used as a secondary signal in slug heuristics. */
  displayName: string | null;
  /** Final HTTP status the proxy is about to return. */
  status: number;
  /** True for any swap-* endpoint — _related is skipped to avoid recursion. */
  isSwapEndpoint: boolean;
  /**
   * Deterministic seed for the 1/5 MCP-tip rotation. Falls back to a
   * fresh random pick when null (rare — only when neither txHash nor
   * idempotency key is available, which shouldn't happen post-settle).
   */
  rotationSeed: string | null;
}

export interface BrandingResult {
  /** Headers to merge into the outgoing response. Empty when skipped. */
  headers: Record<string, string>;
  /** One-word diagnostic when headers is empty; useful for logs. */
  skipped: string | null;
}

// ---------------------------------------------------------- constants

const HEADER_PROVIDER = "X-Suverse-Provider";
const HEADER_CATALOG = "X-Suverse-Catalog";
const HEADER_SEARCH = "X-Suverse-Search";
const HEADER_MCP = "X-Suverse-Mcp";
const HEADER_SWAP = "X-Suverse-Swap";
const HEADER_RELATED = "X-Suverse-Related";
const HEADER_TIP = "X-Suverse-Tip";

/**
 * All branding-header names — used by the integration to extend the
 * `Access-Control-Expose-Headers` value so browser-side buyers can
 * read them off the `Response` object.
 */
export const BRANDING_HEADER_NAMES: readonly string[] = [
  HEADER_PROVIDER,
  HEADER_CATALOG,
  HEADER_SEARCH,
  HEADER_MCP,
  HEADER_SWAP,
  HEADER_RELATED,
  HEADER_TIP,
];

const STATIC = {
  catalog: "https://suverse-pay.suverse.io/catalog",
  search: "https://suverse-pay.suverse.io/api/search?q=YOUR_QUERY",
  mcp: "npx @suverselabs/x402-mcp",
  swapBase: "https://proxy.suverse.io/v1/swap/base/quote",
  swapSolana: "https://proxy.suverse.io/v1/swap/solana/quote",
  proxyDataBase: "https://proxy.suverse.io/v1/data",
  roadmap: "https://suverse-pay.suverse.io",
} as const;

/** TTL for the in-process _related cache. Trades freshness for DB load. */
const RELATED_TTL_MS = 60_000;

/** How many related endpoints we emit on each settled-200 response. */
const RELATED_LIMIT = 3;

// ------------------------------------------------------ config loader

/**
 * Reads BRANDING_* env vars into a frozen config object. Defaults are
 * conservative: disabled with empty allowlist/blacklist. Whitespace
 * around comma-separated tokens is trimmed; empty tokens dropped.
 */
export function loadBrandingConfig(env: NodeJS.ProcessEnv): BrandingConfig {
  const enabled = (env["BRANDING_ENABLED"] ?? "false").toLowerCase() === "true";
  return Object.freeze({
    enabled,
    allowlistSlugs: parseSlugList(env["BRANDING_ALLOWLIST_SLUGS"]),
    blacklistSlugs: parseSlugList(env["BRANDING_BLACKLIST_SLUGS"]),
  });
}

function parseSlugList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ----------------------------------------------------- core selectors

/**
 * Decides whether branding should be applied at all. Returns the
 * reason for skipping so callers can log it; null means "go".
 */
function gate(input: BrandingInput, cfg: BrandingConfig): string | null {
  if (cfg.blacklistSlugs.includes(input.slug)) return "slug_blacklisted";
  if (input.status !== 200) return "non_200_status";
  if (!cfg.enabled) {
    // Allowlist still wins so dark-launch can target individual slugs
    // before the global flag is flipped.
    if (cfg.allowlistSlugs.length === 0) return "branding_disabled";
    if (!cfg.allowlistSlugs.includes(input.slug)) return "branding_disabled";
    return null;
  }
  // Globally enabled, but a non-empty allowlist narrows the set.
  if (
    cfg.allowlistSlugs.length > 0 &&
    !cfg.allowlistSlugs.includes(input.slug)
  ) {
    return "not_in_allowlist";
  }
  return null;
}

/**
 * Picks the swap-quote URL most relevant to the buyer's chain context.
 * Solana-tagged endpoints surface the Solana quote; everything else
 * (including Cosmos data endpoints — we don't ship a Cosmos swap yet)
 * defaults to Base, which is our most-liquid swap route.
 */
export function pickSwapUrl(input: BrandingInput): string {
  if (isSolanaContext(input)) return STATIC.swapSolana;
  return STATIC.swapBase;
}

/**
 * Picks the X-Suverse-Tip text. Rules (in priority order):
 *   1. 1/5 of settles → MCP discovery tip (rotation by rotationSeed).
 *   2. Cosmos context → "swap routing coming soon" pointer at the catalog.
 *   3. Solana context → Solana swap-quote URL.
 *   4. Base / EVM context → Base swap-quote URL.
 *   5. Generic data endpoint → Base swap-quote URL with a softer hook.
 *
 * The 1/5 rotation is deterministic on rotationSeed so repeated calls
 * with the same idempotency key / tx hash return the same tip; without
 * a seed we fall back to a fresh random pick.
 */
export function pickTip(input: BrandingInput): string {
  if (rotationSlot(input.rotationSeed) === 0) {
    return "AI agent integration: npx @suverselabs/x402-mcp";
  }
  if (isCosmosContext(input)) {
    return `Cosmos x402 swap routing coming soon. Track at ${STATIC.roadmap}`;
  }
  if (isSolanaContext(input)) {
    return `Trade Solana tokens via x402 at ${STATIC.swapSolana}`;
  }
  if (isBaseContext(input)) {
    return `Swap ERC20 tokens via x402 at ${STATIC.swapBase}`;
  }
  return `Need to swap tokens based on this data? Use ${STATIC.swapBase}`;
}

// ----------------------------------------------- context-detection logic

const COSMOS_KEYWORDS = [
  "cosmos",
  "atom",
  "noble",
  "osmosis",
  "celestia",
  "injective",
  "ibc",
];
const SOLANA_KEYWORDS = ["solana", "helius", "jupiter", "spl"];
const BASE_KEYWORDS = [
  "base",
  "ethereum",
  "erc20",
  "evm",
  "geckoterminal-base",
  "blockscout-base",
  "etherscan-base",
];

function haystack(input: BrandingInput): string {
  return `${input.slug} ${input.displayName ?? ""}`.toLowerCase();
}

function isCosmosContext(input: BrandingInput): boolean {
  if (input.acceptedNetworks.some((n) => n.startsWith("cosmos:"))) return true;
  const h = haystack(input);
  return COSMOS_KEYWORDS.some((kw) => h.includes(kw));
}

function isSolanaContext(input: BrandingInput): boolean {
  if (input.acceptedNetworks.some((n) => n.startsWith("solana:"))) return true;
  const h = haystack(input);
  return SOLANA_KEYWORDS.some((kw) => h.includes(kw));
}

function isBaseContext(input: BrandingInput): boolean {
  if (input.acceptedNetworks.some((n) => n.startsWith("eip155:"))) return true;
  const h = haystack(input);
  return BASE_KEYWORDS.some((kw) => h.includes(kw));
}

/**
 * Heuristic tag derivation from the slug + displayName. Used when an
 * endpoint has no `catalog_listings` row (or has one with empty tags)
 * so _related can still find related siblings. Order matches the
 * keyword arrays so the most-distinctive tag wins ties.
 */
export function inferTagsFromSlug(input: BrandingInput): string[] {
  const tags = new Set<string>();
  const h = haystack(input);
  for (const kw of [...COSMOS_KEYWORDS, ...SOLANA_KEYWORDS, ...BASE_KEYWORDS]) {
    if (h.includes(kw)) tags.add(kw);
  }
  for (const generic of [
    "btc",
    "bitcoin",
    "price",
    "trade",
    "dex",
    "defi",
    "yield",
    "tvl",
    "wallet",
    "transaction",
    "validator",
    "ibc",
  ]) {
    if (h.includes(generic)) tags.add(generic);
  }
  return [...tags];
}

/**
 * SHA1(seed) mod 5. Returns 0 with probability 1/5 — that slot is
 * reserved for the MCP discovery tip. When seed is null the slot is
 * picked freshly per call.
 */
function rotationSlot(seed: string | null): number {
  if (seed === null || seed === "") {
    return Math.floor(Math.random() * 5);
  }
  const hex = createHash("sha1").update(seed).digest("hex").slice(0, 8);
  return parseInt(hex, 16) % 5;
}

// ----------------------------------------------- _related selection

export interface RelatedItem {
  slug: string;
  url: string;
}

/**
 * Minimal interface the applicator needs from the Postgres pool. Lets
 * tests pass a stub without dragging in pg's types.
 */
export interface BrandingPoolLike {
  query<R extends Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: R[] }>;
}

/**
 * Picks up to 3 sibling endpoints to surface in X-Suverse-Related.
 * Selection tiers (ORDER BY tier DESC, overlap DESC, RANDOM()):
 *   tier 2 — endpoint's catalog_listings tags overlap the source tags
 *   tier 1 — endpoint accepts at least one of the source networks
 *   tier 0 — random other active endpoint
 *
 * Always returns up to RELATED_LIMIT rows when at least that many
 * other active endpoints exist; falls back to whatever's available.
 */
async function queryRelated(
  pool: BrandingPoolLike,
  sourceSlug: string,
  sourceTags: string[],
  sourceNetworks: string[],
): Promise<RelatedItem[]> {
  const sql = `
    WITH candidates AS (
      SELECT
        spc.public_slug,
        CASE
          WHEN cl.tags IS NOT NULL AND cl.tags && $2::text[] THEN 2
          WHEN spc.accepted_networks && $3::text[] THEN 1
          ELSE 0
        END AS tier,
        CASE
          WHEN cl.tags IS NOT NULL AND cl.tags && $2::text[] THEN
            cardinality(ARRAY(
              SELECT UNNEST(cl.tags)
              INTERSECT
              SELECT UNNEST($2::text[])
            ))
          ELSE 0
        END AS overlap
      FROM seller_proxy_configs spc
      LEFT JOIN catalog_listings cl ON cl.proxy_config_id = spc.id
      WHERE spc.is_active
        AND spc.public_slug IS NOT NULL
        AND spc.public_slug != $1
    )
    SELECT public_slug
    FROM candidates
    ORDER BY tier DESC, overlap DESC, RANDOM()
    LIMIT ${RELATED_LIMIT}
  `;
  const res = await pool.query<{ public_slug: string }>(sql, [
    sourceSlug,
    sourceTags,
    sourceNetworks,
  ]);
  return res.rows.map((r) => ({
    slug: r.public_slug,
    url: `${STATIC.proxyDataBase}/${r.public_slug}`,
  }));
}

/**
 * Resolves the source endpoint's tags. Catalog row wins when present
 * and non-empty; otherwise we fall back to a slug-derived heuristic so
 * uncatalogued endpoints (and the freshly-added ones) still get
 * sensible neighbors.
 */
async function resolveSourceTags(
  pool: BrandingPoolLike,
  input: BrandingInput,
): Promise<string[]> {
  const sql = `
    SELECT COALESCE(cl.tags, '{}'::text[]) AS tags
    FROM seller_proxy_configs spc
    LEFT JOIN catalog_listings cl ON cl.proxy_config_id = spc.id
    WHERE spc.public_slug = $1
    LIMIT 1
  `;
  const res = await pool.query<{ tags: string[] | null }>(sql, [input.slug]);
  const dbTags = res.rows[0]?.tags ?? null;
  if (dbTags !== null && dbTags.length > 0) return dbTags;
  return inferTagsFromSlug(input);
}

// ------------------------------------------------------- applicator

interface CacheEntry {
  value: RelatedItem[];
  expiresAt: number;
}

/**
 * Stateful wrapper that owns the env-loaded config, the Pool, and a
 * per-slug TTL cache for _related lookups. Single entry point: apply().
 */
export class BrandingApplicator {
  private readonly cfg: BrandingConfig;
  private readonly pool: BrandingPoolLike;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(args: {
    config: BrandingConfig;
    pool: BrandingPoolLike;
    /** Override the 60s default — used in unit tests for cache eviction. */
    relatedTtlMs?: number;
  }) {
    this.cfg = args.config;
    this.pool = args.pool;
    this.ttlMs = args.relatedTtlMs ?? RELATED_TTL_MS;
  }

  /**
   * Returns the headers to merge into the response, or an empty map
   * (with a `skipped` reason) when branding doesn't apply for this
   * request. Never throws — branding failure must NOT mask a settled
   * 200; callers should treat exceptions as "skip silently".
   */
  async apply(input: BrandingInput): Promise<BrandingResult> {
    const reason = gate(input, this.cfg);
    if (reason !== null) {
      return { headers: {}, skipped: reason };
    }

    const headers: Record<string, string> = {};
    headers[HEADER_PROVIDER] = "SuVerse";
    headers[HEADER_CATALOG] = STATIC.catalog;
    headers[HEADER_SEARCH] = STATIC.search;
    headers[HEADER_MCP] = STATIC.mcp;
    headers[HEADER_SWAP] = pickSwapUrl(input);
    headers[HEADER_TIP] = pickTip(input);

    if (!input.isSwapEndpoint) {
      const related = await this.related(input);
      if (related.length > 0) {
        headers[HEADER_RELATED] = JSON.stringify(related);
      }
    }

    return { headers, skipped: null };
  }

  /**
   * TTL-cached _related lookup. Cache key is the source slug; the
   * tag/network fingerprint is stable within the TTL window so we
   * don't include it in the key.
   */
  private async related(input: BrandingInput): Promise<RelatedItem[]> {
    const now = Date.now();
    const cached = this.cache.get(input.slug);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.value;
    }
    const tags = await resolveSourceTags(this.pool, input);
    const related = await queryRelated(
      this.pool,
      input.slug,
      tags,
      input.acceptedNetworks,
    );
    this.cache.set(input.slug, { value: related, expiresAt: now + this.ttlMs });
    return related;
  }

  /** Test hook — drops a cached entry without waiting out the TTL. */
  invalidate(slug: string): void {
    this.cache.delete(slug);
  }
}
