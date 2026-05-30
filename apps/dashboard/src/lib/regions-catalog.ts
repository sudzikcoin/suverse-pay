/**
 * ISO 3166-1 alpha-2 region catalog for the public discovery
 * catalog's regional filter.
 *
 * Sellers tag a listing with one or more regions (or 'global').
 * Buyers filter by their own region; the listing matches if either
 *   * 'global' is in regions[], OR
 *   * the buyer's region is in regions[]
 * AND the buyer's region is NOT in region_restrictions[].
 *
 * v1 ships a curated subset of countries (not every alpha-2 in the
 * spec) — adding the long-tail later is a single-line append. The
 * special value `global` is included; it sorts first.
 *
 * The list is intentionally hand-curated and grouped: at submission
 * time the UI shows them as named groups (major Western, Asia,
 * emerging markets, …) which is dramatically less daunting than a
 * 240-entry dropdown.
 */

export type RegionCode = string;

export interface Region {
  /** ISO 3166-1 alpha-2 lowercase, or the special 'global'. */
  code: RegionCode;
  /** Display name shown in pickers / badges. */
  name: string;
  /** Display group for the picker. */
  group: RegionGroup;
}

export type RegionGroup =
  | "global"
  | "north-america"
  | "europe"
  | "asia"
  | "south-america"
  | "africa"
  | "oceania"
  | "middle-east";

const RAW: ReadonlyArray<Region> = [
  { code: "global", name: "Global (no regional restriction)", group: "global" },

  // North America
  { code: "us", name: "United States", group: "north-america" },
  { code: "ca", name: "Canada", group: "north-america" },
  { code: "mx", name: "Mexico", group: "north-america" },

  // Europe (a curated mix of the largest x402-relevant markets)
  { code: "uk", name: "United Kingdom", group: "europe" },
  { code: "de", name: "Germany", group: "europe" },
  { code: "fr", name: "France", group: "europe" },
  { code: "es", name: "Spain", group: "europe" },
  { code: "it", name: "Italy", group: "europe" },
  { code: "nl", name: "Netherlands", group: "europe" },
  { code: "se", name: "Sweden", group: "europe" },
  { code: "ch", name: "Switzerland", group: "europe" },
  { code: "pl", name: "Poland", group: "europe" },
  { code: "ie", name: "Ireland", group: "europe" },
  { code: "pt", name: "Portugal", group: "europe" },
  { code: "eu", name: "European Union (all member states)", group: "europe" },

  // Asia
  { code: "jp", name: "Japan", group: "asia" },
  { code: "kr", name: "South Korea", group: "asia" },
  { code: "cn", name: "China", group: "asia" },
  { code: "sg", name: "Singapore", group: "asia" },
  { code: "hk", name: "Hong Kong", group: "asia" },
  { code: "tw", name: "Taiwan", group: "asia" },
  { code: "in", name: "India", group: "asia" },
  { code: "id", name: "Indonesia", group: "asia" },
  { code: "ph", name: "Philippines", group: "asia" },
  { code: "vn", name: "Vietnam", group: "asia" },
  { code: "th", name: "Thailand", group: "asia" },
  { code: "my", name: "Malaysia", group: "asia" },

  // South America
  { code: "br", name: "Brazil", group: "south-america" },
  { code: "ar", name: "Argentina", group: "south-america" },
  { code: "cl", name: "Chile", group: "south-america" },
  { code: "co", name: "Colombia", group: "south-america" },
  { code: "pe", name: "Peru", group: "south-america" },

  // Middle East
  { code: "ae", name: "United Arab Emirates", group: "middle-east" },
  { code: "sa", name: "Saudi Arabia", group: "middle-east" },
  { code: "il", name: "Israel", group: "middle-east" },
  { code: "tr", name: "Turkey", group: "middle-east" },

  // Africa
  { code: "za", name: "South Africa", group: "africa" },
  { code: "ng", name: "Nigeria", group: "africa" },
  { code: "ke", name: "Kenya", group: "africa" },
  { code: "eg", name: "Egypt", group: "africa" },

  // Oceania
  { code: "au", name: "Australia", group: "oceania" },
  { code: "nz", name: "New Zealand", group: "oceania" },
];

/** Frozen array — callers may iterate but never mutate. */
export const REGIONS: ReadonlyArray<Region> = Object.freeze([...RAW]);

const BY_CODE = new Map(REGIONS.map((r) => [r.code, r]));

export function getRegion(code: string): Region | undefined {
  return BY_CODE.get(code.toLowerCase());
}

export function regionName(code: string): string {
  return getRegion(code)?.name ?? code.toUpperCase();
}

/** True iff `code` is a recognised region. */
export function isValidRegionCode(code: string): boolean {
  return BY_CODE.has(code.toLowerCase());
}

/**
 * Normalise an array of region codes from user input:
 *   * lowercase
 *   * trim
 *   * dedupe
 *   * drop unknowns (catches typos before they hit the DB)
 *   * if the array becomes empty, fall back to ['global']
 */
export function normaliseRegions(input: ReadonlyArray<string>): string[] {
  const cleaned = new Set<string>();
  for (const raw of input) {
    const code = raw.trim().toLowerCase();
    if (code.length > 0 && BY_CODE.has(code)) {
      cleaned.add(code);
    }
  }
  return cleaned.size === 0 ? ["global"] : Array.from(cleaned);
}

/**
 * Group the catalog by display group for picker UIs. Ordering of
 * groups matches the visual hierarchy (global first, then dense
 * markets, then long tail).
 */
export function regionsByGroup(): Array<{
  group: RegionGroup;
  regions: ReadonlyArray<Region>;
}> {
  const order: ReadonlyArray<RegionGroup> = [
    "global",
    "north-america",
    "europe",
    "asia",
    "south-america",
    "middle-east",
    "africa",
    "oceania",
  ];
  return order.map((group) => ({
    group,
    regions: REGIONS.filter((r) => r.group === group),
  }));
}

/** Human title for a group (for picker headings). */
export function regionGroupLabel(group: RegionGroup): string {
  switch (group) {
    case "global":
      return "Global";
    case "north-america":
      return "North America";
    case "europe":
      return "Europe";
    case "asia":
      return "Asia";
    case "south-america":
      return "South America";
    case "middle-east":
      return "Middle East";
    case "africa":
      return "Africa";
    case "oceania":
      return "Oceania";
  }
}
