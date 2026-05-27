import { describe, expect, it, vi } from "vitest";
import { BazaarSource } from "./bazaar.js";

interface MockResponseInit {
  status?: number;
  body?: unknown;
  delayMs?: number;
}

function mockResponse({ status = 200, body = {}, delayMs }: MockResponseInit = {}): Response {
  // Minimal Response stand-in that the BazaarSource code path uses.
  const json = async () => {
    if (delayMs !== undefined) await new Promise((r) => setTimeout(r, delayMs));
    return body;
  };
  return {
    status,
    ok: status >= 200 && status < 300,
    json,
  } as Response;
}

function silentLogger() {
  return {
    warn: vi.fn<(msg: string, ctx?: unknown) => void>(),
    debug: vi.fn<(msg: string, ctx?: unknown) => void>(),
  };
}

const SAMPLE_BAZAAR_RESPONSE = {
  resources: [
    {
      resource: "https://api.example.com/weather",
      description: "Weather data",
      type: "http",
      x402Version: 2,
      lastUpdated: "2026-05-20T12:00:00.000Z",
      serviceName: "Example Weather",
      tags: ["weather", "forecast"],
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "100000",
          payTo: "0x5d6dF6b10C54617dac4Bf9993ad9fA384b7B36d3",
          maxTimeoutSeconds: 60,
          extra: { name: "USD Coin", version: "2" },
        },
        {
          scheme: "exact",
          network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          amount: "100000",
          payTo: "AbbuSAH5Ur4a47KSVEzy4dP4wvLY8DSvdQDbJuJjiWfW",
          maxTimeoutSeconds: 60,
        },
      ],
      quality: { l30DaysTotalCalls: 100 },
    },
  ],
  partialResults: false,
  searchMethod: "hybrid",
  x402Version: 2,
};

describe("BazaarSource.search — happy path", () => {
  it("expands each accepts[] entry into a separate DiscoveredEndpoint (multiple-accepts expansion)", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: SAMPLE_BAZAAR_RESPONSE }));
    const src = new BazaarSource({ fetchImpl, logger: silentLogger() });
    const out = await src.search({ query: "weather" });
    expect(out).toHaveLength(2);
    const networks = out.map((e) => e.network).sort();
    expect(networks).toEqual([
      "eip155:8453",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    ]);
    expect(out.every((e) => e.resource === "https://api.example.com/weather")).toBe(true);
    expect(out.every((e) => e.sourceId === "bazaar")).toBe(true);
  });

  it("maps amount on a 6-decimal USDC stablecoin to estimatedPriceUsd of '0.1'", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: SAMPLE_BAZAAR_RESPONSE }));
    const src = new BazaarSource({ fetchImpl, logger: silentLogger() });
    const out = await src.search({});
    const baseEntry = out.find((e) => e.network === "eip155:8453");
    expect(baseEntry).toBeDefined();
    expect(baseEntry?.estimatedPriceUsd).toBe("0.1");
    expect(baseEntry?.amount).toBe("100000");
  });

  it("omits estimatedPriceUsd for unknown (non-stablecoin) assets", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: SAMPLE_BAZAAR_RESPONSE }));
    const src = new BazaarSource({ fetchImpl, logger: silentLogger() });
    const out = await src.search({});
    const solanaEntry = out.find((e) => e.network.startsWith("solana:"));
    expect(solanaEntry).toBeDefined();
    expect(solanaEntry?.estimatedPriceUsd).toBeUndefined();
  });

  it("stamps discoveredAt to an ISO-8601 timestamp", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: SAMPLE_BAZAAR_RESPONSE }));
    const src = new BazaarSource({ fetchImpl, logger: silentLogger() });
    const out = await src.search({});
    for (const e of out) {
      expect(e.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("forwards SearchParams to query string and caps limit at Bazaar's hard cap of 20", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      capturedUrl = String(url);
      return mockResponse({ body: { resources: [] } });
    });
    const src = new BazaarSource({ fetchImpl, logger: silentLogger() });
    await src.search({
      query: "foo",
      network: "eip155:8453",
      asset: "usdc",
      scheme: "exact",
      payTo: "0xabc",
      maxPriceUsd: "1.5",
      limit: 500,
    });
    expect(capturedUrl).toContain("query=foo");
    expect(capturedUrl).toContain("network=eip155%3A8453");
    expect(capturedUrl).toContain("asset=usdc");
    expect(capturedUrl).toContain("scheme=exact");
    expect(capturedUrl).toContain("payTo=0xabc");
    expect(capturedUrl).toContain("maxUsdPrice=1.5");
    expect(capturedUrl).toContain("limit=20");
  });

  it("passes through resource quality, tags, and serviceName into metadata", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ body: SAMPLE_BAZAAR_RESPONSE }));
    const src = new BazaarSource({ fetchImpl, logger: silentLogger() });
    const [first] = await src.search({});
    expect(first?.metadata?.serviceName).toBe("Example Weather");
    expect(first?.metadata?.tags).toEqual(["weather", "forecast"]);
    expect(first?.metadata?.quality).toEqual({ l30DaysTotalCalls: 100 });
  });
});

describe("BazaarSource.search — error paths (graceful degradation)", () => {
  it("returns [] on HTTP 500 without throwing", async () => {
    const log = silentLogger();
    const fetchImpl = vi.fn(async () => mockResponse({ status: 500 }));
    const src = new BazaarSource({ fetchImpl, logger: log });
    const out = await src.search({});
    expect(out).toEqual([]);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("returns [] on HTTP 404 without throwing", async () => {
    const fetchImpl = vi.fn(async () => mockResponse({ status: 404 }));
    const src = new BazaarSource({ fetchImpl, logger: silentLogger() });
    const out = await src.search({});
    expect(out).toEqual([]);
  });

  it("retries on HTTP 429 with the configured backoff schedule, then succeeds", async () => {
    const log = silentLogger();
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n <= 2) return mockResponse({ status: 429 });
      return mockResponse({ body: SAMPLE_BAZAAR_RESPONSE });
    });
    const src = new BazaarSource({
      fetchImpl,
      retryDelaysMs: [1, 1, 1],
      logger: log,
    });
    const out = await src.search({});
    expect(out.length).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns [] after 429 retries exhausted", async () => {
    const log = silentLogger();
    const fetchImpl = vi.fn(async () => mockResponse({ status: 429 }));
    const src = new BazaarSource({
      fetchImpl,
      retryDelaysMs: [1, 1, 1],
      logger: log,
    });
    const out = await src.search({});
    expect(out).toEqual([]);
    // 1 initial + 3 retries = 4 attempts total
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("returns [] when the network call rejects (DNS / connection error)", async () => {
    const log = silentLogger();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: ENOTFOUND");
    });
    const src = new BazaarSource({ fetchImpl, logger: log });
    const out = await src.search({});
    expect(out).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });

  it("aborts when the request exceeds timeoutMs and returns []", async () => {
    const log = silentLogger();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // Simulate a hanging request honoring the AbortSignal.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("Aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const src = new BazaarSource({
      fetchImpl,
      timeoutMs: 5,
      retryDelaysMs: [],
      logger: log,
    });
    const out = await src.search({});
    expect(out).toEqual([]);
  });

  it("returns [] when the response body does not match the expected schema", async () => {
    const log = silentLogger();
    const fetchImpl = vi.fn(async () => mockResponse({ body: { resources: "not an array" } }));
    const src = new BazaarSource({ fetchImpl, logger: log });
    const out = await src.search({});
    expect(out).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });
});
