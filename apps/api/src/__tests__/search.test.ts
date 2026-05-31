/**
 * /v1/search integration tests — exercise the full Fastify route against
 * an in-memory pg-mem database with both our own seller_proxy_configs
 * rows and mirrored external_endpoints rows present.
 *
 * No external HTTP. Auth-exempt for /v1/search verified incidentally
 * (no Authorization header is sent and we still get 200).
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "@suverse-pay/db";
import { buildServer } from "../server.js";
import type { ServerContext } from "../context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "..", "..", "db", "migrations");

type Pool = {
  query: <T = unknown>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[]; rowCount?: number }>;
  end: () => Promise<void>;
};

async function freshPool(): Promise<Pool> {
  const db = newDb({ noAstCoverageCheck: true });
  const { Pool: PgMemPool } = db.adapters.createPg();
  const pool = new PgMemPool() as unknown as Pool;
  await runMigrations({
    client: pool as never,
    migrationsDir: MIGRATIONS_DIR,
    log: () => {},
  });
  return pool;
}

function fakeConfig(): ServerContext["config"] {
  return {
    nodeEnv: "test",
    logLevel: "silent",
    adminApiKey: "test-key",
  } as unknown as ServerContext["config"];
}

async function ctxFromPool(pool: Pool): Promise<ServerContext> {
  return {
    pool: pool as never,
    config: fakeConfig(),
    registry: { enabled: () => [], list: () => [], getById: () => undefined } as never,
    loadHealthSummaries: async () => new Map(),
  } as unknown as ServerContext;
}

async function seedOurEndpoint(
  pool: Pool,
  endpointSlug: string,
  publicSlug: string | null,
  displayName: string,
  description: string,
  payToEvm: string,
) {
  // resource_api_keys row required by FK
  const rkid = `reskey_${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO resource_api_keys (id, key_hash, label, created_at)
     VALUES ($1, 'deadbeef', $2, NOW())
     ON CONFLICT DO NOTHING`,
    [rkid, "test"],
  );
  const id = randomUUID();
  await pool.query(
    `INSERT INTO seller_proxy_configs
       (id, resource_key_id, endpoint_slug, public_slug, original_url, original_method,
        display_name, description, price_atomic, accepted_networks,
        pay_to_evm, forward_auth_scheme, is_active, search_text)
     VALUES ($1, $2, $3, $4, 'https://upstream.example/x', 'GET',
             $5, $6, 10000, ARRAY['eip155:8453']::text[],
             $7, 'static', true,
             lower($5 || ' ' || $6 || ' ' || $3 || ' ' || coalesce($4,'')))`,
    [id, rkid, endpointSlug, publicSlug, displayName, description, payToEvm],
  );
  return id;
}

async function seedExternal(
  pool: Pool,
  source: string,
  resourceUrl: string,
  description: string,
  payTo: string,
  network: string,
  quality?: { calls_30d?: number },
) {
  await pool.query(
    `INSERT INTO external_endpoints
       (id, source, resource_url, pay_to, x402_version, description,
        accepts, extensions, quality_signals, raw_payload, search_text,
        first_seen_at, last_seen_at, archived_at)
     VALUES ($1, $2, $3, $4, 2, $5,
             $6, NULL, $7, '{}'::jsonb, lower($5 || ' ' || $3),
             NOW(), NOW(), NULL)
     ON CONFLICT (resource_url, pay_to) DO NOTHING`,
    [
      randomUUID(),
      source,
      resourceUrl,
      payTo,
      description,
      JSON.stringify([
        { scheme: "exact", network, asset: "0xUSDC", payTo, amount: "1000" },
      ]),
      quality !== undefined
        ? JSON.stringify({ l30DaysTotalCalls: quality.calls_30d })
        : null,
    ],
  );
}

describe("GET /v1/search", () => {
  let pool: Pool | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any = null;

  beforeEach(async () => {
    pool = await freshPool();
    const ctx = await ctxFromPool(pool);
    app = await buildServer({ ctx, redis: null, enableLogger: false });
  });
  afterEach(async () => {
    await app?.close();
    await pool?.end();
    pool = null;
    app = null;
  });

  it("returns 400 on missing q", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/search" });
    expect(res.statusCode).toBe(400);
  });

  it("finds own endpoint by description keyword", async () => {
    await seedOurEndpoint(
      pool!,
      "prices",
      "coingecko-btc-eth-prices",
      "CoinGecko BTC/ETH",
      "Bitcoin and Ethereum prices via CoinGecko",
      "0xMERCHANT",
    );
    const res = await app.inject({ method: "GET", url: "/v1/search?q=coingecko" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.results[0].is_ours).toBe(true);
    expect(body.results[0].source).toBe("suverse-own");
    expect(body.results[0].resource_url).toContain("/v1/data/coingecko-btc-eth-prices");
  });

  it("finds external endpoint and tags is_ours=false", async () => {
    await seedExternal(
      pool!,
      "cdp-bazaar",
      "https://api.example.com/weather",
      "Weather forecast API",
      "0xEXT",
      "eip155:8453",
      { calls_30d: 500 },
    );
    const res = await app.inject({ method: "GET", url: "/v1/search?q=weather" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.results[0].is_ours).toBe(false);
    expect(body.results[0].source).toBe("cdp-bazaar");
    expect(body.results[0].quality.calls_30d).toBe(500);
  });

  it("ranks our endpoints first at equal relevance", async () => {
    await seedOurEndpoint(
      pool!,
      "weather",
      "weather-forecast-nyc",
      "Weather Forecast",
      "weather NYC daily forecast",
      "0xMINE",
    );
    await seedExternal(
      pool!,
      "cdp-bazaar",
      "https://api.example.com/weather",
      "weather forecast",
      "0xOTHER",
      "eip155:8453",
      { calls_30d: 9999 },
    );
    const res = await app.inject({ method: "GET", url: "/v1/search?q=weather" });
    const body = res.json();
    expect(body.total).toBe(2);
    expect(body.results[0].is_ours).toBe(true); // ours first despite lower calls
    expect(body.results[1].is_ours).toBe(false);
  });

  it("source filter narrows to ours only", async () => {
    await seedOurEndpoint(pool!, "weather", null, "Weather", "weather NYC", "0xMINE");
    await seedExternal(pool!, "cdp-bazaar", "https://x/w", "weather", "0xY", "eip155:8453");
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=weather&source=suverse-own",
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.results.every((r: { is_ours: boolean }) => r.is_ours)).toBe(true);
  });

  it("source filter narrows to external only", async () => {
    await seedOurEndpoint(pool!, "weather", null, "Weather", "weather NYC", "0xMINE");
    await seedExternal(pool!, "cdp-bazaar", "https://x/w", "weather data", "0xY", "eip155:8453");
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=weather&source=cdp-bazaar",
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.results[0].source).toBe("cdp-bazaar");
  });

  it("sort=quality-desc orders by calls_30d descending across our + external", async () => {
    await seedOurEndpoint(pool!, "w1", null, "weather one", "weather one", "0xA");
    await seedExternal(pool!, "cdp-bazaar", "https://x/w-100", "weather", "0xB", "eip155:8453", { calls_30d: 100 });
    await seedExternal(pool!, "cdp-bazaar", "https://x/w-500", "weather", "0xC", "eip155:8453", { calls_30d: 500 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=weather&sort=quality-desc",
    });
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.results[0].quality.calls_30d).toBe(500);
    expect(body.results[1].quality.calls_30d).toBe(100);
  });

  it("dedups by resource_url — ours wins over external", async () => {
    await seedOurEndpoint(
      pool!,
      "weather",
      "weather-forecast-nyc",
      "Our weather",
      "our weather",
      "0xMINE",
    );
    // Same URL the proxy would emit (with public_slug) — should NOT appear twice.
    await seedExternal(
      pool!,
      "cdp-bazaar",
      "https://proxy.suverse.io/v1/data/weather-forecast-nyc",
      "the same one, scraped from CDP",
      "0xMINE",
      "eip155:8453",
    );
    const res = await app.inject({ method: "GET", url: "/v1/search?q=weather" });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.results[0].is_ours).toBe(true);
  });

  it("respects limit + offset", async () => {
    for (let i = 0; i < 25; i++) {
      await seedExternal(
        pool!,
        "cdp-bazaar",
        `https://x.test/weather/${i}`,
        `weather ${i}`,
        `0xPay${i}`,
        "eip155:8453",
        { calls_30d: i },
      );
    }
    const res = await app.inject({
      method: "GET",
      url: "/v1/search?q=weather&limit=10&offset=5",
    });
    const body = res.json();
    expect(body.total).toBe(25);
    expect(body.results).toHaveLength(10);
    expect(body.limit).toBe(10);
    expect(body.offset).toBe(5);
  });

  it("is auth-exempt (no Authorization header → 200)", async () => {
    await seedOurEndpoint(pool!, "w", null, "weather", "weather", "0xA");
    const res = await app.inject({ method: "GET", url: "/v1/search?q=weather" });
    expect(res.statusCode).toBe(200);
  });
});
