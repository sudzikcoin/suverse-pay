import { describe, expect, it } from "vitest";
import { CosmosCatalogSource } from "./cosmos-catalog.js";

describe("CosmosCatalogSource", () => {
  it("returns an empty array (Phase 2 placeholder)", async () => {
    const src = new CosmosCatalogSource();
    const out = await src.search({ query: "anything" });
    expect(out).toEqual([]);
  });

  it("exposes the expected id and displayName for source-priority ranking", () => {
    const src = new CosmosCatalogSource();
    expect(src.id).toBe("cosmos-catalog");
    expect(src.displayName).toBe("Cosmos Catalog");
  });
});
