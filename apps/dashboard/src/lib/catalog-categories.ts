/**
 * Curated category list for catalog listings. Sellers pick from this
 * dropdown when creating a proxy or submitting a listing — keeps the
 * taxonomy aligned across the public catalog filters.
 *
 * Order matters: matches the most common buyer-side use cases first
 * so the dropdown default ('data') covers the long tail. Keep this
 * list short and curated; if a category truly doesn't fit, sellers
 * can fall through to 'other' and the moderator decides whether to
 * promote it.
 */
export const CATALOG_CATEGORIES = [
  { value: "data", label: "Data — public records, datasets, feeds" },
  { value: "ai", label: "AI — generation, embeddings, classification" },
  { value: "search", label: "Search — web, vector, semantic" },
  { value: "image", label: "Image — generation, editing, recognition" },
  { value: "translation", label: "Translation — text, document, audio" },
  { value: "trading", label: "Trading — quotes, market data, execution" },
  { value: "maps", label: "Maps — geocoding, routing, satellite" },
  { value: "weather", label: "Weather — forecasts, historical, climate" },
  { value: "freight", label: "Freight — shipping, telematics, routing" },
  { value: "compliance", label: "Compliance — KYC, AML, sanctions" },
  { value: "communications", label: "Communications — email, SMS, chat" },
  { value: "developer-tools", label: "Developer tools — utilities, lint, code-gen" },
  { value: "other", label: "Other" },
] as const;

export type CatalogCategoryValue = (typeof CATALOG_CATEGORIES)[number]["value"];

export const CATALOG_CATEGORY_VALUES: ReadonlySet<string> = new Set(
  CATALOG_CATEGORIES.map((c) => c.value),
);

export function isValidCategory(s: string): s is CatalogCategoryValue {
  return CATALOG_CATEGORY_VALUES.has(s);
}
