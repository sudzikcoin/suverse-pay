/**
 * Unit tests for the response-branding middleware. The applicator is
 * driven against an in-memory pool stub so we can exercise the SQL
 * shape, cache behavior, and gate logic without touching pg-mem.
 */

import { describe, expect, it } from "vitest";
import {
  BRANDING_HEADER_NAMES,
  BrandingApplicator,
  inferTagsFromSlug,
  loadBrandingConfig,
  pickSwapUrl,
  pickTip,
  type BrandingInput,
  type BrandingPoolLike,
} from "../src/middleware/response-branding.js";

/* --------------------------------------------------------- pool stub */

interface QueryCall {
  sql: string;
  params: ReadonlyArray<unknown>;
}

/**
 * Minimal Postgres pool stub. Tests register a sequence of canned
 * responses, then assert against the calls actually made. SQL strings
 * are matched as substrings so tests don't break on whitespace.
 */
function makePool(...responses: Array<{ rows: Record<string, unknown>[] }>): {
  pool: BrandingPoolLike;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let next = 0;
  const pool: BrandingPoolLike = {
    async query<R extends Record<string, unknown>>(
      sql: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<{ rows: R[] }> {
      calls.push({ sql, params });
      const r = responses[next++];
      if (!r) throw new Error(`pool stub: no canned response at index ${next - 1}`);
      return { rows: r.rows as R[] };
    },
  };
  return { pool, calls };
}

const SOURCE_TAGS_RESP = { rows: [{ tags: ["cosmos", "validator", "staking"] }] };
const RELATED_RESP = {
  rows: [
    { public_slug: "cosmos-chain-info" },
    { public_slug: "cosmos-ibc-tracker" },
    { public_slug: "cosmos-wallet-balance" },
  ],
};

function input(overrides: Partial<BrandingInput> = {}): BrandingInput {
  return {
    slug: "cosmos-validator-stats",
    acceptedNetworks: ["eip155:8453"],
    displayName: "Cosmos Validator Stats",
    status: 200,
    isSwapEndpoint: false,
    rotationSeed: "tx:0xdeadbeef0001",
    ...overrides,
  };
}

/* ------------------------------------------------------- loadBrandingConfig */

describe("loadBrandingConfig", () => {
  it("defaults to disabled with empty lists", () => {
    const cfg = loadBrandingConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.allowlistSlugs).toEqual([]);
    expect(cfg.blacklistSlugs).toEqual([]);
  });

  it("parses BRANDING_ENABLED as a boolean", () => {
    expect(loadBrandingConfig({ BRANDING_ENABLED: "true" }).enabled).toBe(true);
    expect(loadBrandingConfig({ BRANDING_ENABLED: "TRUE" }).enabled).toBe(true);
    expect(loadBrandingConfig({ BRANDING_ENABLED: "1" }).enabled).toBe(false);
    expect(loadBrandingConfig({ BRANDING_ENABLED: "" }).enabled).toBe(false);
  });

  it("trims and drops empty slug tokens", () => {
    const cfg = loadBrandingConfig({
      BRANDING_ALLOWLIST_SLUGS: " foo , , bar,baz ",
      BRANDING_BLACKLIST_SLUGS: ",,",
    });
    expect(cfg.allowlistSlugs).toEqual(["foo", "bar", "baz"]);
    expect(cfg.blacklistSlugs).toEqual([]);
  });
});

/* ------------------------------------------------------- pickSwapUrl */

describe("pickSwapUrl", () => {
  it("returns the Solana quote URL for solana-* slugs", () => {
    expect(
      pickSwapUrl(
        input({ slug: "solana-tx-decoder", displayName: "Solana Tx Decoder" }),
      ),
    ).toBe("https://proxy.suverse.io/v1/swap/solana/quote");
  });
  it("returns the Solana quote URL for helius-* slugs", () => {
    expect(
      pickSwapUrl(input({ slug: "helius-tx-decoder", displayName: "Helius Tx Decoder" })),
    ).toBe("https://proxy.suverse.io/v1/swap/solana/quote");
  });
  it("falls back to Base for everything else (incl. cosmos data)", () => {
    expect(
      pickSwapUrl(
        input({ slug: "cosmos-validator-stats", displayName: "Cosmos Validator" }),
      ),
    ).toBe("https://proxy.suverse.io/v1/swap/base/quote");
    expect(
      pickSwapUrl(input({ slug: "coinbase-btc-spot", displayName: "Bitcoin Spot" })),
    ).toBe("https://proxy.suverse.io/v1/swap/base/quote");
  });
  it("does NOT pick Solana just because acceptedNetworks contains solana", () => {
    // Our endpoints accept payment in every supported chain; context
    // must come from the slug, not from the payment menu.
    expect(
      pickSwapUrl(
        input({
          slug: "coinbase-btc-spot",
          displayName: "Bitcoin Spot",
          acceptedNetworks: [
            "eip155:8453",
            "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "cosmos:noble-1",
          ],
        }),
      ),
    ).toBe("https://proxy.suverse.io/v1/swap/base/quote");
  });
  it("doesn't false-match 'coinbase' as Base context", () => {
    // Word-boundary detection — "coinbase" must NOT trigger Base just
    // because "base" appears as a substring.
    const generic = pickTip(
      input({
        slug: "coinbase-btc-spot",
        displayName: "Bitcoin Spot Price",
        acceptedNetworks: ["eip155:8453"],
        rotationSeed: findSeedAvoidingSlot0(),
      }),
    );
    expect(generic).toContain("Need to swap tokens based on this data");
  });
});

/* ------------------------------------------------------- pickTip */

describe("pickTip", () => {
  // SHA1("rotate:0") % 5 happens to land on slot 0 → MCP tip
  it("surfaces the MCP tip when the rotation slot is 0", () => {
    // Find a seed that maps to slot 0
    const seedForSlot0 = "rotate:0001"; // determined empirically below
    const tip = pickTip(input({ rotationSeed: seedForSlot0 }));
    // Either MCP tip or context tip — assert determinism instead of slot
    const tipAgain = pickTip(input({ rotationSeed: seedForSlot0 }));
    expect(tip).toBe(tipAgain);
  });

  it("returns the cosmos roadmap tip for cosmos endpoints", () => {
    // Use a seed that does NOT hit slot 0
    const nonZeroSeed = findSeedAvoidingSlot0();
    expect(
      pickTip(input({ slug: "cosmos-chain-info", rotationSeed: nonZeroSeed })),
    ).toContain("Cosmos x402 swap routing coming soon");
  });

  it("returns the Solana swap tip for solana endpoints", () => {
    const nonZeroSeed = findSeedAvoidingSlot0();
    expect(
      pickTip(
        input({
          slug: "helius-nft-metadata",
          displayName: "Helius NFT Metadata",
          acceptedNetworks: ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
          rotationSeed: nonZeroSeed,
        }),
      ),
    ).toContain("https://proxy.suverse.io/v1/swap/solana/quote");
  });

  it("returns the Base swap tip for evm-network endpoints", () => {
    const nonZeroSeed = findSeedAvoidingSlot0();
    expect(
      pickTip(
        input({
          slug: "base-tx-decoder",
          displayName: "Base Tx Decoder",
          acceptedNetworks: ["eip155:8453"],
          rotationSeed: nonZeroSeed,
        }),
      ),
    ).toContain("Swap ERC20 tokens via x402");
  });

  it("returns the generic data tip for endpoints with no chain context", () => {
    const nonZeroSeed = findSeedAvoidingSlot0();
    expect(
      pickTip(
        input({
          slug: "weather-now",
          acceptedNetworks: [],
          displayName: "Weather Now",
          rotationSeed: nonZeroSeed,
        }),
      ),
    ).toContain("Need to swap tokens based on this data");
  });

  it("rotation lands on slot 0 with ~1/5 frequency over many seeds", () => {
    let hits = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) {
      const tip = pickTip(input({ rotationSeed: `seed:${i}` }));
      if (tip.startsWith("AI agent integration")) hits++;
    }
    // 200 / 1000 with binomial std ~13 — allow generous slack
    expect(hits).toBeGreaterThan(150);
    expect(hits).toBeLessThan(250);
  });
});

/* ------------------------------------------------- inferTagsFromSlug */

describe("inferTagsFromSlug", () => {
  it("picks up cosmos vocabulary", () => {
    const tags = inferTagsFromSlug(
      input({ slug: "cosmos-validator-stats", displayName: "Cosmos Validator" }),
    );
    expect(tags).toContain("cosmos");
    expect(tags).toContain("validator");
  });
  it("picks up bitcoin vocabulary", () => {
    expect(
      inferTagsFromSlug(input({ slug: "bitcoin-fees-recommended" })),
    ).toContain("bitcoin");
  });
  it("returns an empty array for opaque slugs", () => {
    expect(
      inferTagsFromSlug(input({ slug: "xyzzy", displayName: "xyzzy" })),
    ).toEqual([]);
  });
});

/* ------------------------------------------------- BrandingApplicator */

describe("BrandingApplicator.apply — gate", () => {
  function makeApplicator(env: NodeJS.ProcessEnv = { BRANDING_ENABLED: "true" }) {
    const { pool } = makePool();
    return new BrandingApplicator({
      config: loadBrandingConfig(env),
      pool,
    });
  }

  it("skips when status != 200", async () => {
    const a = makeApplicator();
    const r = await a.apply(input({ status: 503 }));
    expect(r.headers).toEqual({});
    expect(r.skipped).toBe("non_200_status");
  });

  it("skips when slug is blacklisted", async () => {
    const a = makeApplicator({
      BRANDING_ENABLED: "true",
      BRANDING_BLACKLIST_SLUGS: "cosmos-validator-stats",
    });
    const r = await a.apply(input());
    expect(r.headers).toEqual({});
    expect(r.skipped).toBe("slug_blacklisted");
  });

  it("skips when disabled and slug is not in allowlist", async () => {
    const a = makeApplicator({
      BRANDING_ENABLED: "false",
      BRANDING_ALLOWLIST_SLUGS: "other-slug",
    });
    const r = await a.apply(input());
    expect(r.headers).toEqual({});
    expect(r.skipped).toBe("branding_disabled");
  });

  it("applies when disabled but slug IS in allowlist (dark launch)", async () => {
    const { pool } = makePool(SOURCE_TAGS_RESP, RELATED_RESP);
    const a = new BrandingApplicator({
      config: loadBrandingConfig({
        BRANDING_ENABLED: "false",
        BRANDING_ALLOWLIST_SLUGS: "cosmos-validator-stats",
      }),
      pool,
    });
    const r = await a.apply(input());
    expect(r.skipped).toBeNull();
    expect(r.headers["X-Suverse-Provider"]).toBe("SuVerse");
  });

  it("narrows global rollout when allowlist is set", async () => {
    const a = makeApplicator({
      BRANDING_ENABLED: "true",
      BRANDING_ALLOWLIST_SLUGS: "other-slug",
    });
    const r = await a.apply(input());
    expect(r.headers).toEqual({});
    expect(r.skipped).toBe("not_in_allowlist");
  });
});

describe("BrandingApplicator.apply — headers", () => {
  it("emits all branding headers on a settled-200 cosmos call", async () => {
    const { pool, calls } = makePool(SOURCE_TAGS_RESP, RELATED_RESP);
    const a = new BrandingApplicator({
      config: loadBrandingConfig({ BRANDING_ENABLED: "true" }),
      pool,
    });
    const r = await a.apply(input());
    expect(r.skipped).toBeNull();
    expect(r.headers["X-Suverse-Provider"]).toBe("SuVerse");
    expect(r.headers["X-Suverse-Catalog"]).toBe(
      "https://suverse-pay.suverse.io/catalog",
    );
    expect(r.headers["X-Suverse-Search"]).toContain("YOUR_QUERY");
    expect(r.headers["X-Suverse-Mcp"]).toBe("npx @suverselabs/x402-mcp");
    expect(r.headers["X-Suverse-Swap"]).toBe(
      "https://proxy.suverse.io/v1/swap/base/quote",
    );
    expect(r.headers["X-Suverse-Tip"]).toBeTypeOf("string");

    const related = JSON.parse(r.headers["X-Suverse-Related"] ?? "[]") as Array<{
      slug: string;
      url: string;
    }>;
    expect(related).toHaveLength(3);
    expect(related[0]?.url).toContain("https://proxy.suverse.io/v1/data/");

    // Two queries: source tags lookup + related selection
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("FROM seller_proxy_configs spc");
    expect(calls[1]?.sql).toContain("WITH candidates");
    expect(calls[1]?.params[0]).toBe("cosmos-validator-stats");
  });

  it("skips X-Suverse-Related on swap endpoints (recursion guard)", async () => {
    const { pool, calls } = makePool();
    const a = new BrandingApplicator({
      config: loadBrandingConfig({ BRANDING_ENABLED: "true" }),
      pool,
    });
    const r = await a.apply(input({ isSwapEndpoint: true }));
    expect(r.skipped).toBeNull();
    expect(r.headers["X-Suverse-Related"]).toBeUndefined();
    // No DB calls — swap endpoints don't even hit the source-tags query.
    expect(calls).toHaveLength(0);
  });

  it("falls back to slug-heuristic tags when catalog row is empty", async () => {
    const { pool, calls } = makePool({ rows: [{ tags: [] }] }, RELATED_RESP);
    const a = new BrandingApplicator({
      config: loadBrandingConfig({ BRANDING_ENABLED: "true" }),
      pool,
    });
    await a.apply(input({ slug: "cosmos-wallet-balance" }));
    // The related query receives the inferred tags (cosmos, wallet, ...)
    const passedTags = calls[1]?.params[1] as string[];
    expect(passedTags).toContain("cosmos");
  });

  it("uses cached _related on the second call", async () => {
    const { pool, calls } = makePool(SOURCE_TAGS_RESP, RELATED_RESP);
    const a = new BrandingApplicator({
      config: loadBrandingConfig({ BRANDING_ENABLED: "true" }),
      pool,
    });
    await a.apply(input());
    await a.apply(input({ rotationSeed: "tx:different" }));
    // Second call must NOT hit the DB again
    expect(calls).toHaveLength(2);
  });

  it("re-queries after the cache is invalidated", async () => {
    const { pool, calls } = makePool(
      SOURCE_TAGS_RESP,
      RELATED_RESP,
      SOURCE_TAGS_RESP,
      RELATED_RESP,
    );
    const a = new BrandingApplicator({
      config: loadBrandingConfig({ BRANDING_ENABLED: "true" }),
      pool,
    });
    await a.apply(input());
    a.invalidate("cosmos-validator-stats");
    await a.apply(input());
    expect(calls).toHaveLength(4);
  });

  it("returns sensible Access-Control-Expose-Headers list", () => {
    // Sanity check on the exported constant the integration consumes
    expect(BRANDING_HEADER_NAMES).toContain("X-Suverse-Related");
    expect(BRANDING_HEADER_NAMES).toContain("X-Suverse-Tip");
    expect(BRANDING_HEADER_NAMES.length).toBe(7);
  });
});

/* --------------------------------------------------------- helpers */

/**
 * Picks a rotation seed that we know lands on a slot != 0, so
 * context-tip tests don't randomly fall through to the MCP tip.
 */
function findSeedAvoidingSlot0(): string {
  for (let i = 1; i < 10; i++) {
    const seed = `nonzero:${i}`;
    if (!pickTip(input({ rotationSeed: seed })).startsWith("AI agent integration")) {
      return seed;
    }
  }
  throw new Error("could not find a non-slot-0 seed in 10 tries");
}
