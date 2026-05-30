import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listBuyerPayments } from "@/lib/buyer";

/**
 * GET /api/buyer/payments?network=&since=&until=&recipient=&page=&pageSize=
 *
 * Paginated list of the user's buyer payments. Query params optional;
 * defaults to page 1 of 50 rows over all time.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const params = pickParams(url.searchParams);
  const result = await listBuyerPayments(session.user.id, params);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, max-age=10" },
  });
}

function pickParams(sp: URLSearchParams): {
  page?: number;
  pageSize?: number;
  network?: string;
  since?: string;
  until?: string;
  recipient?: string;
} {
  const out: ReturnType<typeof pickParams> = {};
  const page = Number(sp.get("page"));
  if (Number.isFinite(page) && page >= 1) out.page = Math.floor(page);
  const pageSize = Number(sp.get("pageSize"));
  if (Number.isFinite(pageSize) && pageSize >= 1) {
    out.pageSize = Math.floor(pageSize);
  }
  const network = sp.get("network");
  if (network) out.network = network;
  const since = sp.get("since");
  if (since && !Number.isNaN(Date.parse(since))) out.since = since;
  const until = sp.get("until");
  if (until && !Number.isNaN(Date.parse(until))) out.until = until;
  const recipient = sp.get("recipient");
  if (recipient) out.recipient = recipient;
  return out;
}
