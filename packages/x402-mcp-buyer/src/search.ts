/**
 * Token-overlap search ranking for catalog listings.
 *
 * v1 deliberately ships without embeddings — agents talking to this
 * MCP can already do semantic retrieval at a higher layer if they
 * need it. A plain BM25-ish lexical score is fast, deterministic,
 * dependency-free, and good enough for catalogs with hundreds of
 * listings (which is what we'll have through 2027).
 *
 * Weights (tuned by eyeballing the sample catalog):
 *   title       ×4
 *   tags        ×3
 *   category    ×2
 *   description ×1
 *
 * The ranking function is intentionally pure — no Promise / no fetch
 * — so the tool handler can `await getCatalog()` once and then
 * synchronously score it.
 */

import type { Listing } from "./catalog/types.js";

export interface ScoredListing {
  listing: Listing;
  score: number;
  matchedTokens: ReadonlyArray<string>;
}

const WEIGHT_TITLE = 4;
const WEIGHT_TAGS = 3;
const WEIGHT_CATEGORY = 2;
const WEIGHT_DESCRIPTION = 1;

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "for",
  "and",
  "to",
  "in",
  "on",
  "with",
  "by",
  "from",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "as",
  "at",
  "or",
  "any",
  "all",
]);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function scoreListing(
  listing: Listing,
  queryTokens: ReadonlyArray<string>,
): ScoredListing {
  if (queryTokens.length === 0) {
    return { listing, score: 0, matchedTokens: [] };
  }
  const titleTokens = new Set(tokenize(listing.title));
  const tagTokens = new Set(
    (listing.tags ?? []).flatMap((t) => tokenize(t)),
  );
  const categoryTokens = new Set(tokenize(listing.category));
  const descTokens = new Set(tokenize(listing.description));

  let score = 0;
  const matched: string[] = [];
  for (const q of queryTokens) {
    let hit = 0;
    if (titleTokens.has(q)) hit += WEIGHT_TITLE;
    if (tagTokens.has(q)) hit += WEIGHT_TAGS;
    if (categoryTokens.has(q)) hit += WEIGHT_CATEGORY;
    if (descTokens.has(q)) hit += WEIGHT_DESCRIPTION;
    if (hit > 0) {
      score += hit;
      matched.push(q);
    }
  }
  // Small bonus for verified listings — tiebreaker only, applied
  // only after a real lexical match so we never surface a verified
  // listing that doesn't actually answer the query.
  if (listing.isVerified && score > 0) score += 0.5;
  return { listing, score, matchedTokens: matched };
}

export interface SearchOptions {
  /** Cap on results. Default 10. */
  limit?: number;
  /** Optional CAIP-2 network filter. */
  network?: string;
  /** Optional category equality filter. */
  category?: string;
}

export function searchListings(
  listings: ReadonlyArray<Listing>,
  query: string,
  opts: SearchOptions = {},
): ScoredListing[] {
  const queryTokens = tokenize(query);
  let filtered: ReadonlyArray<Listing> = listings;
  if (opts.network) {
    const n = opts.network;
    filtered = filtered.filter((l) => l.networks.includes(n));
  }
  if (opts.category) {
    const c = opts.category.toLowerCase();
    filtered = filtered.filter((l) => l.category.toLowerCase() === c);
  }
  const scored = filtered
    .map((l) => scoreListing(l, queryTokens))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 10);
}
