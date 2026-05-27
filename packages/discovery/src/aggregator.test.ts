import { describe, expect, it, vi } from "vitest";
import { aggregate, dedupKey } from "./aggregator.js";
import type { DiscoverySource } from "./source.js";
import type { DiscoveredEndpoint } from "./types.js";

function endpoint(
  overrides: Partial<DiscoveredEndpoint> & { sourceId: string },
): DiscoveredEndpoint {
  return {
    resource: "https://example.com/r",
    network: "eip155:8453",
    asset: "0xAAA",
    scheme: "exact",
    amount: "100000",
    payTo: "0xPAY",
    discoveredAt: "2026-05-27T00:00:00.000Z",
    ...overrides,
  };
}

function fakeSource(id: string, results: DiscoveredEndpoint[]): DiscoverySource {
  return {
    id,
    displayName: id,
    search: vi.fn(async () => results),
  };
}

function silentLogger() {
  return { warn: vi.fn<(msg: string, ctx?: unknown) => void>() };
}

describe("aggregate — dedup by (resource, network, asset) tuple", () => {
  it("collapses identical (resource, network, asset) across sources, first-source wins", async () => {
    const shared = endpoint({ sourceId: "bazaar", estimatedPriceUsd: "0.10" });
    const dupFromOther = endpoint({
      sourceId: "cosmos-catalog",
      estimatedPriceUsd: "0.05",
    });
    const bazaar = fakeSource("bazaar", [shared]);
    const cosmos = fakeSource("cosmos-catalog", [dupFromOther]);

    const out = await aggregate([bazaar, cosmos], {}, { logger: silentLogger() });

    expect(out).toHaveLength(1);
    expect(out[0]?.sourceId).toBe("bazaar");
    expect(out[0]?.estimatedPriceUsd).toBe("0.10");
  });

  it("preserves separate entries when only the network differs (same resource URL, different network)", async () => {
    const baseUsdc = endpoint({
      sourceId: "bazaar",
      resource: "https://api.example.com/x",
      network: "eip155:8453",
      asset: "0xBASE",
    });
    const polygonEurc = endpoint({
      sourceId: "bazaar",
      resource: "https://api.example.com/x",
      network: "eip155:137",
      asset: "0xPOLY",
    });
    const bazaar = fakeSource("bazaar", [baseUsdc, polygonEurc]);

    const out = await aggregate([bazaar], {}, { logger: silentLogger() });
    expect(out).toHaveLength(2);
  });

  it("preserves separate entries when only the asset differs (same resource URL + network, different token)", async () => {
    const usdcOnBase = endpoint({
      sourceId: "bazaar",
      resource: "https://api.example.com/y",
      asset: "0xUSDC",
    });
    const eurcOnBase = endpoint({
      sourceId: "bazaar",
      resource: "https://api.example.com/y",
      asset: "0xEURC",
    });
    const bazaar = fakeSource("bazaar", [usdcOnBase, eurcOnBase]);

    const out = await aggregate([bazaar], {}, { logger: silentLogger() });
    expect(out).toHaveLength(2);
  });

  it("uses case-insensitive asset comparison in the dedup key", async () => {
    const lower = endpoint({ sourceId: "bazaar", asset: "0xabc" });
    const upper = endpoint({ sourceId: "bazaar", asset: "0xABC" });
    const bazaar = fakeSource("bazaar", [lower, upper]);

    const out = await aggregate([bazaar], {}, { logger: silentLogger() });
    expect(out).toHaveLength(1);
  });
});

describe("aggregate — resilience", () => {
  it("does NOT fail the whole query when one source throws (Promise.allSettled)", async () => {
    const log = silentLogger();
    const working: DiscoverySource = fakeSource("bazaar", [
      endpoint({ sourceId: "bazaar" }),
    ]);
    const broken: DiscoverySource = {
      id: "cosmos-catalog",
      displayName: "broken",
      search: vi.fn(async () => {
        throw new Error("simulated catalog outage");
      }),
    };

    const out = await aggregate([working, broken], {}, { logger: log });
    expect(out).toHaveLength(1);
    expect(out[0]?.sourceId).toBe("bazaar");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("cosmos-catalog"),
      expect.objectContaining({ reason: "simulated catalog outage" }),
    );
  });

  it("returns an empty array when ALL sources fail", async () => {
    const log = silentLogger();
    const a: DiscoverySource = {
      id: "bazaar",
      displayName: "a",
      search: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const b: DiscoverySource = {
      id: "cosmos-catalog",
      displayName: "b",
      search: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    const out = await aggregate([a, b], {}, { logger: log });
    expect(out).toEqual([]);
  });
});

describe("aggregate — ordering", () => {
  it("sorts by price ascending when sortByPrice is implied via maxPriceUsd", async () => {
    const a = endpoint({
      sourceId: "bazaar",
      resource: "https://a/",
      estimatedPriceUsd: "1.00",
    });
    const b = endpoint({
      sourceId: "bazaar",
      resource: "https://b/",
      estimatedPriceUsd: "0.25",
    });
    const c = endpoint({
      sourceId: "bazaar",
      resource: "https://c/",
      estimatedPriceUsd: "0.50",
    });
    const bazaar = fakeSource("bazaar", [a, b, c]);

    const out = await aggregate(
      [bazaar],
      { maxPriceUsd: "2.00" },
      { logger: silentLogger() },
    );
    expect(out.map((e) => e.estimatedPriceUsd)).toEqual(["0.25", "0.50", "1.00"]);
  });

  it("ranks priced entries before unpriced ones when sorting by price", async () => {
    const priced = endpoint({
      sourceId: "bazaar",
      resource: "https://priced/",
      estimatedPriceUsd: "0.50",
    });
    const unpriced = endpoint({
      sourceId: "bazaar",
      resource: "https://unpriced/",
      estimatedPriceUsd: undefined,
    });
    const bazaar = fakeSource("bazaar", [unpriced, priced]);

    const out = await aggregate(
      [bazaar],
      { maxPriceUsd: "1.00" },
      { logger: silentLogger() },
    );
    expect(out[0]?.resource).toBe("https://priced/");
    expect(out[1]?.resource).toBe("https://unpriced/");
  });

  it("uses source priority as a tiebreaker (bazaar before cosmos-catalog)", async () => {
    const fromBazaar = endpoint({
      sourceId: "bazaar",
      resource: "https://api.example.com/a",
    });
    const fromCosmos = endpoint({
      sourceId: "cosmos-catalog",
      resource: "https://api.example.com/b",
    });
    const bazaar = fakeSource("bazaar", [fromBazaar]);
    const cosmos = fakeSource("cosmos-catalog", [fromCosmos]);

    const out = await aggregate([bazaar, cosmos], {}, { logger: silentLogger() });
    expect(out.map((e) => e.sourceId)).toEqual(["bazaar", "cosmos-catalog"]);
  });

  it("uses discoveredAt descending as the final tiebreaker", async () => {
    const older = endpoint({
      sourceId: "bazaar",
      resource: "https://older/",
      discoveredAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = endpoint({
      sourceId: "bazaar",
      resource: "https://newer/",
      discoveredAt: "2026-05-27T00:00:00.000Z",
    });
    const bazaar = fakeSource("bazaar", [older, newer]);

    const out = await aggregate([bazaar], {}, { logger: silentLogger() });
    expect(out[0]?.resource).toBe("https://newer/");
    expect(out[1]?.resource).toBe("https://older/");
  });
});

describe("aggregate — limit semantics", () => {
  it("applies the default limit of 20", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      endpoint({ sourceId: "bazaar", resource: `https://r/${i}` }),
    );
    const bazaar = fakeSource("bazaar", many);
    const out = await aggregate([bazaar], {}, { logger: silentLogger() });
    expect(out).toHaveLength(20);
  });

  it("clamps limit to the maximum of 100", async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      endpoint({ sourceId: "bazaar", resource: `https://r/${i}` }),
    );
    const bazaar = fakeSource("bazaar", many);
    const out = await aggregate(
      [bazaar],
      { limit: 9999 },
      { logger: silentLogger() },
    );
    expect(out).toHaveLength(100);
  });

  it("honors explicit limit when below the cap", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      endpoint({ sourceId: "bazaar", resource: `https://r/${i}` }),
    );
    const bazaar = fakeSource("bazaar", many);
    const out = await aggregate(
      [bazaar],
      { limit: 5 },
      { logger: silentLogger() },
    );
    expect(out).toHaveLength(5);
  });
});

describe("dedupKey", () => {
  it("normalizes asset case", () => {
    expect(
      dedupKey({ resource: "r", network: "eip155:1", asset: "0xABC" }),
    ).toBe(
      dedupKey({ resource: "r", network: "eip155:1", asset: "0xabc" }),
    );
  });

  it("differentiates by network", () => {
    expect(
      dedupKey({ resource: "r", network: "eip155:1", asset: "0xabc" }),
    ).not.toBe(
      dedupKey({ resource: "r", network: "eip155:8453", asset: "0xabc" }),
    );
  });

  it("differentiates by asset", () => {
    expect(
      dedupKey({ resource: "r", network: "eip155:1", asset: "0xabc" }),
    ).not.toBe(
      dedupKey({ resource: "r", network: "eip155:1", asset: "0xdef" }),
    );
  });
});
