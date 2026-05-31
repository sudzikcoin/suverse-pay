/**
 * cdp-bazaar fetcher tests — exercise the pagination loop and the
 * normaliser against a captured CDP response shape. No real HTTP.
 */
import { describe, expect, it } from "vitest";
import { CDP_BAZAAR_BASE, fetchCdpBazaar } from "../sources/cdp-bazaar.js";

function mockJsonFetch(
  pages: ReadonlyArray<Record<string, unknown> | { status: number }>,
): typeof fetch {
  let i = 0;
  return (async () => {
    const page = pages[i++];
    if (page === undefined) {
      throw new Error("mockJsonFetch: no more pages");
    }
    if ("status" in page && typeof page.status === "number" && page.status >= 400) {
      return new Response(null, { status: page.status });
    }
    return new Response(JSON.stringify(page), { status: 200 });
  }) as unknown as typeof fetch;
}

const sampleEntry = (i: number) => ({
  resource: `https://example.test/endpoint-${i}`,
  x402Version: 2,
  description: `endpoint ${i}`,
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      asset: "0xUSDC",
      payTo: "0xMERCHANT",
      amount: "1000",
      maxTimeoutSeconds: 60,
    },
  ],
  extensions: { bazaar: { info: {}, schema: {} } },
  quality: { l30DaysTotalCalls: i, l30DaysUniquePayers: 1 },
});

describe("fetchCdpBazaar", () => {
  it("normalises a single page and returns RawEndpoint[]", async () => {
    const fetchImpl = mockJsonFetch([
      {
        resources: [sampleEntry(0), sampleEntry(1)],
        pagination: { total: 2, offset: 0 },
      },
    ]);
    const out = await fetchCdpBazaar({ fetchImpl, maxRequests: 5 });
    expect(out).toHaveLength(2);
    expect(out[0]?.resource).toBe("https://example.test/endpoint-0");
    expect(out[0]?.payTo).toBe("0xMERCHANT");
    expect(out[0]?.x402Version).toBe(2);
    expect((out[0]?.accepts as ReadonlyArray<unknown>)[0]).toBeTruthy();
    expect(out[0]?.raw).toEqual(sampleEntry(0));
  });

  it("paginates until pagination.total is reached", async () => {
    const fetchImpl = mockJsonFetch([
      {
        resources: [sampleEntry(0), sampleEntry(1)],
        pagination: { total: 3, offset: 0 },
      },
      {
        resources: [sampleEntry(2)],
        pagination: { total: 3, offset: 2 },
      },
    ]);
    const out = await fetchCdpBazaar({ fetchImpl, maxRequests: 5 });
    expect(out).toHaveLength(3);
  });

  it("stops at maxRequests cap even when total > pages*PAGE_SIZE", async () => {
    const fetchImpl = mockJsonFetch([
      {
        resources: [sampleEntry(0)],
        pagination: { total: 99999, offset: 0 },
      },
      {
        resources: [sampleEntry(1)],
        pagination: { total: 99999, offset: 1 },
      },
    ]);
    const out = await fetchCdpBazaar({ fetchImpl, maxRequests: 2 });
    expect(out).toHaveLength(2);
  });

  it("returns partial result on a 4xx/5xx instead of throwing", async () => {
    const fetchImpl = mockJsonFetch([
      {
        resources: [sampleEntry(0)],
        pagination: { total: 99, offset: 0 },
      },
      { status: 429 },
    ]);
    const out = await fetchCdpBazaar({ fetchImpl, maxRequests: 5 });
    expect(out).toHaveLength(1);
  });

  it("drops entries with no payTo or no accepts (CDP rare-case sanity)", async () => {
    const fetchImpl = mockJsonFetch([
      {
        resources: [
          { resource: "https://x/y", accepts: [] }, // no accepts -> drop
          { resource: "https://x/z", accepts: [{ scheme: "exact" }] }, // no payTo -> drop
          sampleEntry(0), // valid
        ],
        pagination: { total: 3, offset: 0 },
      },
    ]);
    const out = await fetchCdpBazaar({ fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0]?.resource).toBe("https://example.test/endpoint-0");
  });

  it("hits the documented CDP endpoint URL with limit + offset", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({ resources: [], pagination: { total: 0 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await fetchCdpBazaar({ fetchImpl, maxRequests: 1 });
    expect(calls[0]).toBe(`${CDP_BAZAAR_BASE}?limit=1000&offset=0`);
  });
});
