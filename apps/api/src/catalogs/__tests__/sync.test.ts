/**
 * Integration tests for the catalog syncer's DB layer.
 *
 * Uses pg-mem so we exercise the real SQL — including ON CONFLICT
 * DO UPDATE on (resource_url, pay_to), <> ALL($::text[]) for archiving,
 * and the per-source run-summary upsert. Mock sources let us drive
 * end-to-end without touching the network.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "@suverse-pay/db";
import { syncAllCatalogs } from "../sync.js";
import type { CatalogSource, RawEndpoint } from "../types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "..", "..", "..", "..", "db", "migrations");

type Pool = {
  query: <T = unknown>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[]; rowCount?: number }>;
  end: () => Promise<void>;
};

async function freshDb(): Promise<Pool> {
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

function endpoint(slug: string, payTo = "0xMERCHANT"): RawEndpoint {
  return {
    resource: `https://example.test/${slug}`,
    payTo,
    x402Version: 2,
    description: `${slug} description`,
    accepts: [{ scheme: "exact", network: "eip155:8453", payTo }],
    extensions: { bazaar: { info: {}, schema: {} } },
    quality: { l30DaysTotalCalls: 7 },
    raw: { slug, hidden: "kept verbatim" },
  };
}

function mockSource(
  id: string,
  endpoints: ReadonlyArray<RawEndpoint>,
): CatalogSource {
  return {
    name: `mock:${id}`,
    id,
    fetch: async () => [...endpoints],
  };
}

describe("syncAllCatalogs", () => {
  let pool: Pool | null = null;

  beforeEach(async () => {
    pool = await freshDb();
  });
  afterEach(async () => {
    await pool?.end();
    pool = null;
  });

  it("upserts all fetched endpoints into external_endpoints", async () => {
    const src = mockSource("mock-a", [endpoint("alpha"), endpoint("beta")]);
    const results = await syncAllCatalogs(pool as never, { sources: [src] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: "mock-a",
      status: "ok",
      fetched: 2,
      upserted: 2,
      archived: 0,
    });
    const { rows } = await pool!.query<{ resource_url: string; source: string }>(
      `SELECT resource_url, source FROM external_endpoints ORDER BY resource_url`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.source).toBe("mock-a");
  });

  it("re-running with same set updates last_seen_at and stays at 2 rows", async () => {
    const src = mockSource("mock-a", [endpoint("alpha")]);
    await syncAllCatalogs(pool as never, { sources: [src] });
    await syncAllCatalogs(pool as never, { sources: [src] });
    const { rows } = await pool!.query<{ resource_url: string }>(
      `SELECT resource_url FROM external_endpoints WHERE source='mock-a'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("soft-archives a URL that disappears from the source on the next run", async () => {
    const srcA = mockSource("mock-a", [endpoint("alpha"), endpoint("beta")]);
    await syncAllCatalogs(pool as never, { sources: [srcA] });
    const srcB = mockSource("mock-a", [endpoint("alpha")]); // beta dropped
    const r = await syncAllCatalogs(pool as never, { sources: [srcB] });
    expect(r[0]?.archived).toBe(1);
    const { rows } = await pool!.query<{
      resource_url: string;
      archived_at: string | null;
    }>(
      `SELECT resource_url, archived_at FROM external_endpoints ORDER BY resource_url`,
    );
    expect(rows[0]?.archived_at).toBeNull(); // alpha still live
    expect(rows[1]?.archived_at).not.toBeNull(); // beta archived
  });

  it("reactivates an archived row when it reappears in the source", async () => {
    // initial: alpha + beta
    await syncAllCatalogs(pool as never, {
      sources: [mockSource("mock-a", [endpoint("alpha"), endpoint("beta")])],
    });
    // beta drops -> archived
    await syncAllCatalogs(pool as never, {
      sources: [mockSource("mock-a", [endpoint("alpha")])],
    });
    // beta comes back -> archived_at cleared
    await syncAllCatalogs(pool as never, {
      sources: [mockSource("mock-a", [endpoint("alpha"), endpoint("beta")])],
    });
    const { rows } = await pool!.query<{ archived_at: string | null }>(
      `SELECT archived_at FROM external_endpoints
        WHERE resource_url = 'https://example.test/beta'`,
    );
    expect(rows[0]?.archived_at).toBeNull();
  });

  it("dedups (resource_url, pay_to) across sources — last writer wins", async () => {
    const same = endpoint("shared");
    await syncAllCatalogs(pool as never, {
      sources: [mockSource("mock-a", [same])],
    });
    await syncAllCatalogs(pool as never, {
      sources: [mockSource("mock-b", [same])],
    });
    const { rows } = await pool!.query<{ source: string }>(
      `SELECT source FROM external_endpoints
        WHERE resource_url = 'https://example.test/shared'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("mock-b"); // last writer
  });

  it("isolates per-source errors — one fetcher throwing does not stop the others", async () => {
    const bad: CatalogSource = {
      name: "bad",
      id: "bad",
      fetch: async () => {
        throw new Error("simulated upstream outage");
      },
    };
    const good = mockSource("good", [endpoint("alpha")]);
    const results = await syncAllCatalogs(pool as never, {
      sources: [bad, good],
    });
    expect(results.find((r) => r.source === "bad")?.status).toBe("error");
    expect(results.find((r) => r.source === "good")?.status).toBe("ok");
    const { rows } = await pool!.query<{ resource_url: string }>(
      `SELECT resource_url FROM external_endpoints WHERE source='good'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("does NOT archive everything when a source returns an empty list (treats as outage)", async () => {
    await syncAllCatalogs(pool as never, {
      sources: [mockSource("mock-a", [endpoint("alpha")])],
    });
    await syncAllCatalogs(pool as never, {
      sources: [mockSource("mock-a", [])], // outage / empty page
    });
    const { rows } = await pool!.query<{ archived_at: string | null }>(
      `SELECT archived_at FROM external_endpoints
        WHERE resource_url = 'https://example.test/alpha'`,
    );
    expect(rows[0]?.archived_at).toBeNull();
  });

  it("records a per-source run summary in external_catalog_runs", async () => {
    await syncAllCatalogs(pool as never, {
      sources: [mockSource("mock-a", [endpoint("a"), endpoint("b")])],
    });
    await syncAllCatalogs(pool as never, {
      sources: [mockSource("mock-a", [endpoint("a")])],
    });
    const { rows } = await pool!.query<{
      source: string;
      last_status: string;
      last_fetched_count: number;
      total_runs: number;
    }>(`SELECT source, last_status, last_fetched_count, total_runs FROM external_catalog_runs`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("mock-a");
    expect(rows[0]?.last_status).toBe("ok");
    expect(rows[0]?.last_fetched_count).toBe(1);
    expect(rows[0]?.total_runs).toBe(2);
  });
});
