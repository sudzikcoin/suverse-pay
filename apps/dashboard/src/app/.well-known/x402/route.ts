import { NextResponse } from "next/server";
import { listApprovedListings } from "@/lib/catalog-store";

const SITE_URL =
  process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://suverse-pay.suverse.io";

/**
 * GET /.well-known/x402
 *
 * Discovery manifest enumerating the x402-enabled endpoints we
 * publish through the catalog. There's no formal `.well-known/x402`
 * RFC yet — we follow the x402.org ecosystem convention: a JSON
 * document with a stable shape that ecosystem crawlers can index.
 *
 * Shape:
 *   {
 *     provider: { name, homepage, contact, catalog_url },
 *     facilitator: { url },
 *     endpoints: [
 *       { url, title, description, networks, price_atomic_min,
 *         price_atomic_max, price_unit, category, tags,
 *         is_verified, slug }
 *     ],
 *     generated_at: <iso>
 *   }
 *
 * Public, CORS-open, 60s edge cache + 120s SWR. Listings already
 * pass through moderation before they hit `status=approved`, so this
 * surface is safe to expose unauthenticated.
 */
export async function GET(): Promise<NextResponse> {
  const listings = await listApprovedListings();
  const body = {
    provider: {
      name: "Suverse Pay",
      homepage: SITE_URL,
      contact: "support@suverse.io",
      catalog_url: `${SITE_URL}/catalog`,
    },
    facilitator: {
      url: "https://facilitator.suverse.io",
    },
    endpoints: listings.map((l) => ({
      url: l.endpointUrl,
      slug: l.slug,
      title: l.title,
      description: l.description,
      category: l.category,
      tags: l.tags,
      networks: l.networks,
      price_atomic_min: l.priceAtomicMin,
      price_atomic_max: l.priceAtomicMax,
      price_unit: l.priceUnit,
      is_verified: l.isVerified,
    })),
    generated_at: new Date().toISOString(),
  };
  return NextResponse.json(body, {
    headers: {
      "Cache-Control":
        "public, s-maxage=60, stale-while-revalidate=120, max-age=30",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
    },
  });
}
