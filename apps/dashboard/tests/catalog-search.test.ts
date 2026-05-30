import { describe, expect, it } from "vitest";
import {
  applyFilter,
  paginate,
  regionMatches,
  sortForFeed,
  textMatches,
  truncateDescription,
  type CatalogListing,
} from "../src/lib/catalog-search";

function fixture(overrides: Partial<CatalogListing> = {}): CatalogListing {
  return {
    id: "id-1",
    title: "Weather API",
    description: "Hourly forecasts for any lat/lon pair worldwide.",
    endpointUrl: "https://api.example.com/v1/weather",
    category: "weather",
    tags: ["climate", "geo"],
    priceAtomicMin: "1000",
    priceAtomicMax: "5000",
    priceUnit: "per-call",
    networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
    regions: ["global"],
    regionRestrictions: [],
    isVerified: true,
    resourceKeyId: "reskey_aaaaaaaa",
    facilitatorUrl: null,
    status: "approved",
    rejectionReason: null,
    logoUrl: null,
    homepageUrl: null,
    documentationUrl: null,
    viewCount: 0,
    clickCount: 0,
    createdAt: "2026-05-01T00:00:00.000Z",
    publishedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("truncateDescription", () => {
  it("returns empty string for null", () => {
    expect(truncateDescription(null)).toBe("");
  });
  it("passes short strings through", () => {
    expect(truncateDescription("short", 200)).toBe("short");
  });
  it("truncates at a word boundary with an ellipsis", () => {
    const long = "a".repeat(120) + " more words that exceed the cap";
    const out = truncateDescription(long, 130);
    expect(out.length).toBeLessThanOrEqual(131);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("regionMatches", () => {
  it("matches when the listing is global", () => {
    expect(regionMatches(fixture(), "us")).toBe(true);
  });
  it("matches when the target region is explicitly listed", () => {
    expect(
      regionMatches(fixture({ regions: ["us", "ca"] }), "us"),
    ).toBe(true);
  });
  it("does NOT match when the listing has explicit regions and the target is not in them", () => {
    expect(
      regionMatches(fixture({ regions: ["us", "ca"] }), "br"),
    ).toBe(false);
  });
  it("does NOT match when region is restricted, even if 'global' is in regions", () => {
    expect(
      regionMatches(
        fixture({ regions: ["global"], regionRestrictions: ["ru"] }),
        "ru",
      ),
    ).toBe(false);
  });
  it("'global' as target matches everything", () => {
    expect(
      regionMatches(fixture({ regions: ["us"] }), "global"),
    ).toBe(true);
  });
  it("returns false for an unknown region code", () => {
    expect(regionMatches(fixture(), "zz")).toBe(false);
  });
});

describe("textMatches", () => {
  it("matches against title (case-insensitive)", () => {
    expect(textMatches(fixture(), "WEATHER")).toBe(true);
  });
  it("matches against description", () => {
    expect(textMatches(fixture(), "forecast")).toBe(true);
  });
  it("matches against tags", () => {
    expect(textMatches(fixture(), "geo")).toBe(true);
  });
  it("returns true for empty query (no-op)", () => {
    expect(textMatches(fixture(), "")).toBe(true);
    expect(textMatches(fixture(), "   ")).toBe(true);
  });
  it("returns false when nothing matches", () => {
    expect(textMatches(fixture(), "stockprice")).toBe(false);
  });
});

describe("applyFilter", () => {
  it("composes multiple predicates with AND semantics", () => {
    const l = fixture({
      regions: ["us"],
      networks: ["eip155:8453"],
      category: "weather",
    });
    expect(
      applyFilter(l, {
        q: "weather",
        region: "us",
        network: "eip155:8453",
        category: "weather",
        verified: true,
      }),
    ).toBe(true);
  });
  it("rejects if any predicate fails", () => {
    const l = fixture();
    expect(applyFilter(l, { verified: false })).toBe(false);
    expect(applyFilter(l, { network: "eip155:1" })).toBe(false);
    expect(applyFilter(l, { category: "finance" })).toBe(false);
  });
  it("ignores undefined fields", () => {
    expect(applyFilter(fixture(), {})).toBe(true);
  });
});

describe("sortForFeed", () => {
  it("verified listings sort before unverified", () => {
    const verified = fixture({ isVerified: true, viewCount: 0 });
    const unverified = fixture({ isVerified: false, viewCount: 9999 });
    const arr = [unverified, verified].sort(sortForFeed);
    expect(arr[0]?.isVerified).toBe(true);
  });
  it("within a tier, higher viewCount sorts first", () => {
    const low = fixture({ id: "low", isVerified: true, viewCount: 1 });
    const high = fixture({ id: "high", isVerified: true, viewCount: 100 });
    const arr = [low, high].sort(sortForFeed);
    expect(arr[0]?.id).toBe("high");
  });
  it("ties on viewCount break by newer createdAt first", () => {
    const old = fixture({
      id: "old",
      isVerified: true,
      viewCount: 5,
      createdAt: "2025-01-01T00:00:00.000Z",
    });
    const fresh = fixture({
      id: "fresh",
      isVerified: true,
      viewCount: 5,
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    const arr = [old, fresh].sort(sortForFeed);
    expect(arr[0]?.id).toBe("fresh");
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);
  it("returns the first page when cursor is null", () => {
    const { page, nextCursor } = paginate(items, 4, null);
    expect(page).toEqual([0, 1, 2, 3]);
    expect(nextCursor).toBe(4);
  });
  it("returns the second page when cursor points past the first", () => {
    const { page, nextCursor } = paginate(items, 4, 4);
    expect(page).toEqual([4, 5, 6, 7]);
    expect(nextCursor).toBe(8);
  });
  it("nextCursor is null on the last page", () => {
    const { page, nextCursor } = paginate(items, 4, 8);
    expect(page).toEqual([8, 9]);
    expect(nextCursor).toBeNull();
  });
});
