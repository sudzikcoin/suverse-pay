/**
 * Fetch the suverse-pay public catalog snapshot. Single GET to the
 * dashboard's listings.json route — fully unauthenticated, CDN
 * cached upstream so calling it once per minute is cheap.
 */

import type { Listing } from "./types.js";

const DEFAULT_URL = "https://suverse-pay.suverse.io/api/catalog/listings.json";

interface SuverseRow {
  id: string;
  title: string;
  description: string;
  endpointUrl: string;
  category: string;
  tags: string[] | null;
  priceAtomicMin: string;
  priceAtomicMax: string;
  priceUnit: string;
  networks: string[] | null;
  regions: string[] | null;
  isVerified: boolean;
  homepageUrl: string | null;
  documentationUrl: string | null;
}

interface SuverseResponse {
  listings: SuverseRow[];
  count: number;
  generatedAt: string;
}

export interface FetchSuverseOptions {
  /** Override for tests / staging. */
  baseUrl?: string;
  /** AbortSignal so the caller can time us out. */
  signal?: AbortSignal;
}

export async function fetchSuverseCatalog(
  opts: FetchSuverseOptions = {},
): Promise<ReadonlyArray<Listing>> {
  const url = opts.baseUrl ?? DEFAULT_URL;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`suverse catalog fetch failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as SuverseResponse;
  if (!Array.isArray(body.listings)) {
    throw new Error("suverse catalog response missing listings array");
  }
  return body.listings.map((row) => normalise(row));
}

function normalise(row: SuverseRow): Listing {
  return {
    id: `suverse:${row.id}`,
    source: "suverse",
    title: row.title,
    description: row.description,
    endpointUrl: row.endpointUrl,
    category: row.category,
    tags: row.tags ?? [],
    priceAtomicMin: row.priceAtomicMin,
    priceAtomicMax: row.priceAtomicMax,
    priceUnit: row.priceUnit,
    networks: row.networks ?? [],
    regions: row.regions ?? [],
    isVerified: row.isVerified,
    homepageUrl: row.homepageUrl,
    documentationUrl: row.documentationUrl,
  };
}
