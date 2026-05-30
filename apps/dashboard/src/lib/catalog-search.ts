/**
 * Pure search/filter logic for the public catalog.
 *
 * The route handler at /api/catalog accepts a small query DSL:
 *
 *   q          free-text against title + description (case-insens)
 *   network    CAIP-2 network id, e.g. 'eip155:8453'
 *   region     ISO 3166-1 alpha-2 or 'global'
 *   category   exact match
 *   verified   'true' | 'false'
 *
 * For v1 we evaluate filters in-process AFTER the SQL fetch (the
 * full catalog is small — < a few thousand rows for the
 * foreseeable future, and we always pre-filter on status='approved'
 * + LIMIT in the SQL). Once the catalog grows, the GIN indexes in
 * migration 007 let us push the array filters down without
 * touching this module's signature.
 *
 * Keeping the filter logic in a separate module from the route
 * handler is intentional:
 *   * It's easy to unit-test (no DB, no NextResponse, pure data).
 *   * The same predicate is reused on the dashboard "my listings"
 *     page when filtering across statuses.
 */

import { isValidRegionCode } from "./regions-catalog";

export interface CatalogListing {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  endpointUrl: string;
  category: string | null;
  tags: ReadonlyArray<string>;
  priceAtomicMin: string | null;
  priceAtomicMax: string | null;
  priceUnit: string;
  networks: ReadonlyArray<string>;
  regions: ReadonlyArray<string>;
  regionRestrictions: ReadonlyArray<string>;
  isVerified: boolean;
  resourceKeyId: string | null;
  facilitatorUrl: string | null;
  status: "pending" | "approved" | "rejected" | "suspended";
  rejectionReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  logoUrl: string | null;
  homepageUrl: string | null;
  documentationUrl: string | null;
  sampleRequestCurl: string | null;
  sampleResponseJson: string | null;
  viewCount: number;
  clickCount: number;
  createdAt: string;
  publishedAt: string | null;
}

export interface CatalogFilter {
  q?: string;
  network?: string;
  region?: string;
  category?: string;
  verified?: boolean;
}

/**
 * Truncate a description for list views (the detail page shows the
 * full text). The cap matches what we promise in the API spec.
 */
export function truncateDescription(s: string | null, cap = 200): string {
  if (s === null) return "";
  if (s.length <= cap) return s;
  // Cut at the last word boundary within cap-1 so we don't dangle a
  // half-word + "…".
  const slice = s.slice(0, cap - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 80 ? slice.slice(0, lastSpace) : slice;
  return cut + "…";
}

/**
 * Region predicate: a listing matches `targetRegion` iff
 *   * the listing serves the target region (explicit or 'global')
 *   * AND the listing does NOT restrict the target region
 *
 * 'global' as a target means "I don't want to filter by region";
 * every approved listing passes.
 */
export function regionMatches(
  listing: Pick<CatalogListing, "regions" | "regionRestrictions">,
  targetRegion: string,
): boolean {
  const target = targetRegion.toLowerCase();
  if (target === "global") return true;
  if (!isValidRegionCode(target)) return false;
  const restricted = listing.regionRestrictions.some(
    (r) => r.toLowerCase() === target,
  );
  if (restricted) return false;
  return listing.regions.some(
    (r) => r.toLowerCase() === target || r.toLowerCase() === "global",
  );
}

export function networkMatches(
  listing: Pick<CatalogListing, "networks">,
  network: string,
): boolean {
  return listing.networks.includes(network);
}

/**
 * Case-insensitive substring match against title + description +
 * tags. We deliberately do NOT use a fancy ranker — the SQL GIN
 * tsvector index in migration 007 is the long-term plan for that;
 * for now the catalog is small enough that a strict contains-match
 * gives predictable results.
 */
export function textMatches(
  listing: Pick<CatalogListing, "title" | "description" | "tags">,
  q: string,
): boolean {
  const needle = q.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (listing.title.toLowerCase().includes(needle)) return true;
  if (listing.description !== null
    && listing.description.toLowerCase().includes(needle)) return true;
  for (const tag of listing.tags) {
    if (tag.toLowerCase().includes(needle)) return true;
  }
  return false;
}

/** Compose all four filters. Listing must satisfy every predicate. */
export function applyFilter(
  listing: CatalogListing,
  f: CatalogFilter,
): boolean {
  if (f.verified !== undefined && listing.isVerified !== f.verified) {
    return false;
  }
  if (f.category !== undefined && f.category.length > 0
    && listing.category !== f.category) {
    return false;
  }
  if (f.network !== undefined && f.network.length > 0
    && !networkMatches(listing, f.network)) {
    return false;
  }
  if (f.region !== undefined && f.region.length > 0
    && !regionMatches(listing, f.region)) {
    return false;
  }
  if (f.q !== undefined && !textMatches(listing, f.q)) {
    return false;
  }
  return true;
}

/**
 * Sort order for the public catalog feed: verified-first, then
 * newest-first WITHIN tier. view_count was the original plan, but
 * a fresh listing with 0 views needs to surface above week-old
 * verified listings with a single view; sorting by created_at
 * inside the verified bucket gives new submissions a fair shot
 * without bumping unverified listings above verified ones.
 */
export function sortForFeed(
  a: CatalogListing,
  b: CatalogListing,
): number {
  if (a.isVerified !== b.isVerified) return a.isVerified ? -1 : 1;
  if (a.viewCount !== b.viewCount) return b.viewCount - a.viewCount;
  return (
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/** Limit + offset pagination on an already-sorted list. */
export function paginate<T>(
  items: ReadonlyArray<T>,
  limit: number,
  cursor: number | null,
): { page: T[]; nextCursor: number | null } {
  const start = cursor ?? 0;
  const end = Math.min(start + limit, items.length);
  const page = items.slice(start, end);
  const nextCursor = end < items.length ? end : null;
  return { page, nextCursor };
}
