import { describe, expect, it } from "vitest";
import {
  REGIONS,
  getRegion,
  isValidRegionCode,
  normaliseRegions,
  regionGroupLabel,
  regionName,
  regionsByGroup,
} from "../src/lib/regions-catalog";

describe("regions catalog", () => {
  it("contains the special 'global' entry first", () => {
    expect(REGIONS[0]?.code).toBe("global");
  });

  it("every region code is lowercase ISO 3166-1 alpha-2 (or 'global')", () => {
    for (const r of REGIONS) {
      if (r.code === "global") continue;
      // EU is a synthetic super-region (not strictly alpha-2 but in
      // common usage as one) — allow 2-letter codes.
      expect(r.code).toMatch(/^[a-z]{2}$/);
    }
  });

  it("covers the major Western markets called out in the spec", () => {
    const codes = new Set(REGIONS.map((r) => r.code));
    for (const required of ["us", "eu", "uk", "ca", "au"]) {
      expect(codes.has(required)).toBe(true);
    }
  });

  it("covers a representative emerging-markets set", () => {
    const codes = new Set(REGIONS.map((r) => r.code));
    for (const required of ["in", "br", "mx", "id", "ph"]) {
      expect(codes.has(required)).toBe(true);
    }
  });

  it("covers a representative Asia set", () => {
    const codes = new Set(REGIONS.map((r) => r.code));
    for (const required of ["cn", "kr", "jp", "sg"]) {
      expect(codes.has(required)).toBe(true);
    }
  });
});

describe("isValidRegionCode", () => {
  it("accepts a known region", () => {
    expect(isValidRegionCode("us")).toBe(true);
    expect(isValidRegionCode("US")).toBe(true);
  });
  it("accepts 'global'", () => {
    expect(isValidRegionCode("global")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isValidRegionCode("xx")).toBe(false);
    expect(isValidRegionCode("")).toBe(false);
    expect(isValidRegionCode("UNITED-STATES")).toBe(false);
  });
});

describe("getRegion / regionName", () => {
  it("returns the entry for a known code", () => {
    expect(getRegion("us")?.name).toBe("United States");
    expect(regionName("us")).toBe("United States");
  });
  it("returns uppercase code as fallback for unknowns", () => {
    expect(regionName("zz")).toBe("ZZ");
  });
});

describe("normaliseRegions", () => {
  it("lowercases, trims, and dedupes", () => {
    expect(normaliseRegions([" US ", "us", "BR"])).toEqual(["us", "br"]);
  });
  it("drops unknown codes silently", () => {
    expect(normaliseRegions(["us", "fakerregion", "ca"])).toEqual([
      "us",
      "ca",
    ]);
  });
  it("falls back to ['global'] for empty input", () => {
    expect(normaliseRegions([])).toEqual(["global"]);
    expect(normaliseRegions(["unknown1", "unknown2"])).toEqual(["global"]);
  });
  it("preserves 'global' when explicitly supplied", () => {
    expect(normaliseRegions(["global"])).toEqual(["global"]);
  });
});

describe("regionsByGroup", () => {
  it("groups in the documented display order", () => {
    const groups = regionsByGroup().map((g) => g.group);
    expect(groups[0]).toBe("global");
    expect(groups).toContain("north-america");
    expect(groups).toContain("europe");
    expect(groups).toContain("asia");
  });
  it("every region appears in exactly one group", () => {
    const counts = new Map<string, number>();
    for (const { regions } of regionsByGroup()) {
      for (const r of regions) {
        counts.set(r.code, (counts.get(r.code) ?? 0) + 1);
      }
    }
    for (const [, n] of counts) {
      expect(n).toBe(1);
    }
  });
});

describe("regionGroupLabel", () => {
  it("returns a human title for every group", () => {
    expect(regionGroupLabel("global")).toBe("Global");
    expect(regionGroupLabel("north-america")).toBe("North America");
    expect(regionGroupLabel("middle-east")).toBe("Middle East");
  });
});
