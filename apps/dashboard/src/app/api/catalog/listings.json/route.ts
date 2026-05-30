import { NextResponse } from "next/server";
import { listApprovedListings } from "@/lib/catalog-store";

/**
 * GET /api/catalog/listings.json — public, no auth.
 *
 * Returns every approved catalog listing as JSON. Intended for
 * machine consumers (the @suverselabs/x402-mcp buyer MCP, ecosystem
 * crawlers, the public site itself if it ever moves to client-side
 * rendering).
 *
 * Aggressive CORS + a short browser cache so an interactive agent
 * can hammer this without rate-limit pain. We cache server-side too
 * because catalog state turns over on the order of minutes, not
 * milliseconds.
 *
 * Shape:
 *   {
 *     listings: CatalogListing[],
 *     count: number,
 *     generatedAt: string (ISO)
 *   }
 */
export async function GET(): Promise<NextResponse> {
  const listings = await listApprovedListings();
  const body = {
    listings,
    count: listings.length,
    generatedAt: new Date().toISOString(),
  };
  return NextResponse.json(body, {
    headers: {
      // 30s edge cache, 60s stale-while-revalidate. The MCP/agents
      // get a fresh snapshot every minute without us paying a DB
      // round-trip per request.
      "Cache-Control":
        "public, s-maxage=30, stale-while-revalidate=60, max-age=10",
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
