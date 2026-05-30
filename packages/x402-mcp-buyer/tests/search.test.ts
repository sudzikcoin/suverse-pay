import { describe, expect, it } from "vitest";
import { scoreListing, searchListings, tokenize } from "../src/search.js";
import type { Listing } from "../src/catalog/types.js";

function fixture(over: Partial<Listing> = {}): Listing {
  return {
    id: "suverse:x",
    source: "suverse",
    title: "Weather Forecast API",
    description: "7-day forecast for US zip codes.",
    endpointUrl: "https://example.com/forecast",
    category: "data",
    tags: ["weather", "us"],
    priceAtomicMin: "50000",
    priceAtomicMax: "50000",
    priceUnit: "usdc",
    networks: ["eip155:8453"],
    regions: ["US"],
    isVerified: true,
    homepageUrl: null,
    documentationUrl: null,
    ...over,
  };
}

describe("tokenize", () => {
  it("lowercases, strips punctuation, drops stopwords + 1-char tokens", () => {
    expect(tokenize("Weather Forecast API for the US!")).toEqual([
      "weather",
      "forecast",
      "api",
      "us",
    ]);
  });

  it("handles unicode characters", () => {
    expect(tokenize("Météo Forecast")).toEqual(["météo", "forecast"]);
  });
});

describe("scoreListing", () => {
  it("title hit dominates description hit", () => {
    const titleHit = scoreListing(fixture(), tokenize("weather"));
    const descHit = scoreListing(
      fixture({ title: "Random API", description: "Returns weather" }),
      tokenize("weather"),
    );
    expect(titleHit.score).toBeGreaterThan(descHit.score);
  });

  it("isVerified gets a small bonus, doesn't override lexical mismatch", () => {
    const verified = scoreListing(fixture({ isVerified: true }), tokenize("blue"));
    expect(verified.score).toBe(0);
  });

  it("returns matched tokens for highlighting", () => {
    const r = scoreListing(fixture(), tokenize("weather us"));
    expect(r.matchedTokens.sort()).toEqual(["us", "weather"]);
  });
});

describe("searchListings", () => {
  const fixtures: Listing[] = [
    fixture({ id: "suverse:a", title: "Weather Forecast", tags: ["weather"] }),
    fixture({
      id: "suverse:b",
      title: "Image Generation",
      description: "stable diffusion as a service",
      tags: ["image", "ai"],
      category: "ai",
    }),
    fixture({
      id: "suverse:c",
      title: "US Census Data",
      description: "weather adjacent demographic stats",
      tags: ["census", "us"],
      category: "data",
    }),
  ];

  it("ranks title match first, off-topic match scores 0 and is dropped", () => {
    const out = searchListings(fixtures, "weather");
    expect(out.map((r) => r.listing.id)).toContain("suverse:a");
    expect(out[0]!.listing.id).toBe("suverse:a");
    expect(out.find((r) => r.listing.id === "suverse:b")).toBeUndefined();
  });

  it("respects limit", () => {
    const out = searchListings(fixtures, "weather us", { limit: 1 });
    expect(out.length).toBe(1);
  });

  it("filters by network", () => {
    const out = searchListings(
      [
        fixture({ id: "suverse:x", networks: ["eip155:8453"] }),
        fixture({ id: "suverse:y", networks: ["solana:mainnet"] }),
      ],
      "weather",
      { network: "solana:mainnet" },
    );
    expect(out.length).toBe(1);
    expect(out[0]!.listing.id).toBe("suverse:y");
  });

  it("filters by category (case-insensitive)", () => {
    const out = searchListings(fixtures, "weather", { category: "DATA" });
    expect(out.every((r) => r.listing.category.toLowerCase() === "data")).toBe(
      true,
    );
  });
});
