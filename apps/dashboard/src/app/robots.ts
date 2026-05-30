import type { MetadataRoute } from "next";

const SITE_URL =
  process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://suverse-pay.suverse.io";

/**
 * robots.txt — friendly to crawlers, locks out admin / API surfaces.
 * The public catalog + landing are explicitly allowed; everything
 * else under /api/ and /dashboard/admin is blocked.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/catalog", "/catalog/", "/api/catalog/listings.json"],
        disallow: ["/api/", "/dashboard/admin/"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
