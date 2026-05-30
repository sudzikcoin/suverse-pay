import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSuverseCatalog } from "../src/catalog/suverse.js";
import { fetchCatalog } from "../src/catalog/aggregate.js";
import { _resetCacheForTests, getCatalog } from "../src/catalog/cache.js";

const SAMPLE = {
  listings: [
    {
      id: "listing-1",
      title: "Weather Forecast API",
      description: "7-day forecast for any US zip code",
      endpointUrl: "https://example.com/forecast",
      category: "data",
      tags: ["weather", "us"],
      priceAtomicMin: "50000",
      priceAtomicMax: "50000",
      priceUnit: "usdc",
      networks: ["eip155:8453"],
      regions: ["US"],
      isVerified: true,
      homepageUrl: "https://example.com",
      documentationUrl: null,
    },
  ],
  count: 1,
  generatedAt: "2026-05-31T00:00:00.000Z",
};

describe("fetchSuverseCatalog", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => SAMPLE,
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalises rows and prefixes ids with source", async () => {
    const rows = await fetchSuverseCatalog();
    expect(rows.length).toBe(1);
    expect(rows[0]!.id).toBe("suverse:listing-1");
    expect(rows[0]!.source).toBe("suverse");
    expect(rows[0]!.networks).toEqual(["eip155:8453"]);
    expect(rows[0]!.priceAtomicMin).toBe("50000");
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }),
    );
    await expect(fetchSuverseCatalog()).rejects.toThrow(/HTTP 503/);
  });
});

describe("fetchCatalog (aggregate)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => SAMPLE,
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports per-source counts, stubs other sources as not-ok", async () => {
    const snap = await fetchCatalog();
    expect(snap.listings.length).toBe(1);
    expect(snap.sources).toEqual(
      expect.arrayContaining([
        { source: "suverse", count: 1, ok: true },
        { source: "x402.org", count: 0, ok: false },
        { source: "cdp-bazaar", count: 0, ok: false },
      ]),
    );
  });

  it("survives suverse fetch failure (degraded snapshot)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const snap = await fetchCatalog();
    expect(snap.listings.length).toBe(0);
    const suverseStatus = snap.sources.find((s) => s.source === "suverse");
    expect(suverseStatus?.ok).toBe(false);
  });
});

describe("getCatalog (cache)", () => {
  beforeEach(() => {
    _resetCacheForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => SAMPLE,
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves from cache within TTL", async () => {
    const a = await getCatalog({ ttlMs: 60_000 });
    const b = await getCatalog({ ttlMs: 60_000 });
    expect(a).toBe(b);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("force=true bypasses cache", async () => {
    await getCatalog();
    await getCatalog({ force: true });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});
