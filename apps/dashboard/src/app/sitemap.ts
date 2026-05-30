import type { MetadataRoute } from "next";
import { listApprovedListings } from "@/lib/catalog-store";

/**
 * Dynamic sitemap for crawlers. Emits the small set of static public
 * pages + one entry per approved catalog listing keyed by slug.
 *
 * Generated on every request (no ISR) because the catalog set is
 * small enough that a DB round-trip is faster than figuring out
 * cache invalidation. Bump to revalidate when the catalog grows
 * past a few hundred entries.
 */
const SITE_URL =
  process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://suverse-pay.suverse.io";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const listings = await listApprovedListings().catch(() => []);

  const staticPages: MetadataRoute.Sitemap = [
    {
      url: `${SITE_URL}/`,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${SITE_URL}/catalog`,
      changeFrequency: "daily",
      priority: 0.9,
    },
    {
      url: `${SITE_URL}/catalog/submit`,
      changeFrequency: "monthly",
      priority: 0.4,
    },
  ];

  const listingPages: MetadataRoute.Sitemap = listings.map((l) => ({
    url: `${SITE_URL}/catalog/${l.slug}`,
    lastModified: l.publishedAt ?? l.createdAt,
    changeFrequency: "weekly",
    priority: l.isVerified ? 0.7 : 0.5,
  }));

  return [...staticPages, ...listingPages];
}
