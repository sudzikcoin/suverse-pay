/**
 * GET /v1/search — public unified search across our own paid endpoints
 * (seller_proxy_configs) and the mirrored external catalog
 * (external_endpoints). Phase 3 of the unified-catalog feature.
 *
 * Query parameters (all optional except q):
 *   q          required, max 200 chars; lowercased substring match
 *              against the `search_text` column on both tables
 *              (migration 020). Production trgm GIN index from
 *              deploy/sql/021_search_trgm_index_prod.sql keeps it sub-ms.
 *   limit      default 20, max 100.
 *   offset     default 0.
 *   network    optional CAIP-2 filter (eip155:8453, solana:5eykt4…,
 *              cosmos:noble-1). Matches entries whose accepts contain
 *              an accept with this network.
 *   source     optional: 'suverse-own' | 'cdp-bazaar' | 'x402-org' |
 *              'suverse-cosmos'.
 *   sort       'relevance' (default), 'price-asc', 'quality-desc'.
 *
 * Implementation note: two raw SQL queries (ours + external) assembled
 * in TS rather than a UNION CTE so the route stays pg-mem-friendly for
 * unit tests (pg-mem doesn't implement jsonb_build_array / _object).
 * Dedup, sort, and pagination happen in JS.
 *
 * Public (no admin auth). server.ts adds /v1/search to the auth plugin
 * exempt set.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServerContext } from "../context.js";

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  network: z.string().min(1).max(80).optional(),
  source: z
    .enum(["suverse-own", "cdp-bazaar", "x402-org", "suverse-cosmos"])
    .optional(),
  sort: z.enum(["relevance", "price-asc", "quality-desc"]).default("relevance"),
});

interface UnifiedResult {
  source: string;
  resource_url: string;
  description: string | null;
  pay_to: string;
  accepts: unknown;
  x402_version: number | null;
  quality: {
    calls_30d: number | null;
    unique_payers_30d: number | null;
    last_called_at: string | null;
  };
  is_ours: boolean;
  tags: string[];
  /** internal — only used for sort + filter, not in response. */
  _price_atomic: number | null;
}

interface SpcRow {
  id: string;
  endpoint_slug: string;
  public_slug: string | null;
  display_name: string | null;
  description: string | null;
  price_atomic: string;
  accepted_networks: string[];
  pay_to_evm: string | null;
  pay_to_solana: string | null;
  pay_to_cosmos: string | null;
  catalog_description: string | null;
  catalog_tags: string[] | null;
}

interface ExtRow {
  source: string;
  resource_url: string;
  description: string | null;
  pay_to: string;
  accepts: unknown;
  x402_version: number | null;
  quality_signals: { l30DaysTotalCalls?: number; l30DaysUniquePayers?: number; lastCalledAt?: string } | null;
}

export function registerSearchRoute(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get("/v1/search", async (req, reply) => {
    const parsed = SearchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_query",
        message: parsed.error.message,
      });
    }
    const { q, limit, offset, network, source, sort } = parsed.data;
    if (ctx.pool === undefined) {
      return reply.code(503).send({ error: "search_unavailable" });
    }
    const pattern = `%${q.toLowerCase()}%`;

    const includeOurs = source === undefined || source === "suverse-own";
    const includeExt = source === undefined || source !== "suverse-own";

    const oursRows: SpcRow[] = includeOurs
      ? (
          await ctx.pool.query<SpcRow>(
            `SELECT spc.id, spc.endpoint_slug, spc.public_slug, spc.display_name,
                    spc.description, spc.price_atomic::text AS price_atomic,
                    spc.accepted_networks,
                    spc.pay_to_evm, spc.pay_to_solana, spc.pay_to_cosmos,
                    cl.description AS catalog_description, cl.tags AS catalog_tags
               FROM seller_proxy_configs spc
               LEFT JOIN catalog_listings cl ON cl.proxy_config_id = spc.id
              WHERE spc.is_active = true
                AND spc.search_text LIKE $1
                AND ($2::text IS NULL OR $2 = ANY(spc.accepted_networks))`,
            [pattern, network ?? null],
          )
        ).rows
      : [];

    // Network filter on external_endpoints is applied in JS because
    // pg-mem 3.0.14 doesn't implement jsonb_array_elements; the
    // selectivity on search_text + source typically narrows the set
    // enough that JS filtering is fine.
    const extRawRows: ExtRow[] = includeExt
      ? (
          await ctx.pool.query<ExtRow>(
            `SELECT source, resource_url, description, pay_to, accepts,
                    x402_version, quality_signals
               FROM external_endpoints
              WHERE archived_at IS NULL
                AND search_text LIKE $1
                AND ($2::text IS NULL OR source = $2)`,
            [pattern, source ?? null],
          )
        ).rows
      : [];
    const extRows: ExtRow[] = network === undefined
      ? extRawRows
      : extRawRows.filter((r) =>
          Array.isArray(r.accepts) &&
          (r.accepts as Array<Record<string, unknown>>).some(
            (a) => a["network"] === network,
          ),
        );

    const oursUnified: UnifiedResult[] = oursRows.map((r) => {
      const url =
        "https://proxy.suverse.io/v1/data/" +
        (r.public_slug ?? r.endpoint_slug);
      const priceAtomic = Number(r.price_atomic);
      // Build a minimal accepts shape mirroring what the proxy emits — Base
      // first, Solana/Cosmos if the spc has those payTos configured.
      const accepts: Record<string, unknown>[] = [];
      if (r.pay_to_evm !== null) {
        accepts.push({
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: r.pay_to_evm,
          amount: r.price_atomic,
        });
      }
      if (r.pay_to_solana !== null) {
        accepts.push({
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          payTo: r.pay_to_solana,
          amount: r.price_atomic,
        });
      }
      if (r.pay_to_cosmos !== null) {
        accepts.push({
          scheme: "exact_cosmos_authz",
          network: "cosmos:noble-1",
          asset: "uusdc",
          payTo: r.pay_to_cosmos,
          amount: r.price_atomic,
        });
      }
      return {
        source: "suverse-own",
        resource_url: url,
        description:
          r.catalog_description ?? r.description ?? r.display_name ?? null,
        pay_to: r.pay_to_evm ?? r.pay_to_solana ?? r.pay_to_cosmos ?? "",
        accepts,
        x402_version: 2,
        quality: { calls_30d: null, unique_payers_30d: null, last_called_at: null },
        is_ours: true,
        tags: r.catalog_tags ?? [],
        _price_atomic: priceAtomic,
      };
    });

    const extUnified: UnifiedResult[] = extRows.map((r) => ({
      source: r.source,
      resource_url: r.resource_url,
      description: r.description,
      pay_to: r.pay_to,
      accepts: r.accepts,
      x402_version: r.x402_version,
      quality: {
        calls_30d: r.quality_signals?.l30DaysTotalCalls ?? null,
        unique_payers_30d: r.quality_signals?.l30DaysUniquePayers ?? null,
        last_called_at: r.quality_signals?.lastCalledAt ?? null,
      },
      is_ours: false,
      tags: [],
      _price_atomic: null,
    }));

    // Dedup external rows whose resource_url matches one of ours — we
    // already have the canonical entry. Ours always win.
    const ourUrls = new Set(oursUnified.map((u) => u.resource_url));
    const extDedup = extUnified.filter((u) => !ourUrls.has(u.resource_url));

    const merged = [...oursUnified, ...extDedup];
    merged.sort((a, b) => {
      if (sort === "price-asc") {
        const ap = a._price_atomic ?? Number.POSITIVE_INFINITY;
        const bp = b._price_atomic ?? Number.POSITIVE_INFINITY;
        if (ap !== bp) return ap - bp;
      }
      if (sort === "quality-desc") {
        const aq = a.quality.calls_30d ?? -1;
        const bq = b.quality.calls_30d ?? -1;
        if (aq !== bq) return bq - aq;
      }
      // relevance / tiebreaker: ours first, then by calls_30d desc, then by url.
      if (a.is_ours !== b.is_ours) return a.is_ours ? -1 : 1;
      const aq = a.quality.calls_30d ?? -1;
      const bq = b.quality.calls_30d ?? -1;
      if (aq !== bq) return bq - aq;
      return a.resource_url.localeCompare(b.resource_url);
    });
    const total = merged.length;
    const page = merged.slice(offset, offset + limit);

    return {
      query: q,
      total,
      limit,
      offset,
      // strip _price_atomic from response
      results: page.map(({ _price_atomic: _, ...rest }) => rest),
    };
  });
}
