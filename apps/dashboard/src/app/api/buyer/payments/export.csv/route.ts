import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listBuyerPayments } from "@/lib/buyer";

/**
 * GET /api/buyer/payments/export.csv?since=&until=&network=&recipient=
 *
 * Streams a CSV of every payment matching the filters. No pagination
 * — we cap the page size at 10k so a single download covers the user's
 * entire history except for the most prolific agents (a follow-up
 * will switch to chunked streaming once we see anyone hit the cap).
 */

const HARD_CAP = 10_000;

export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const result = await listBuyerPayments(session.user.id, {
    page: 1,
    pageSize: HARD_CAP,
    network: url.searchParams.get("network") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    until: url.searchParams.get("until") ?? undefined,
    recipient: url.searchParams.get("recipient") ?? undefined,
  });

  const header = [
    "id",
    "createdAt",
    "network",
    "amountAtomic",
    "asset",
    "payer",
    "recipient",
    "txHash",
    "status",
    "errorCode",
  ];
  const lines = [header.join(",")];
  for (const p of result.payments) {
    lines.push(
      [
        csv(p.id),
        csv(p.createdAt),
        csv(p.network),
        csv(p.amount),
        csv(p.asset),
        csv(p.payer ?? ""),
        csv(p.recipient),
        csv(p.txHash ?? ""),
        csv(p.status),
        csv(p.errorCode ?? ""),
      ].join(","),
    );
  }
  const body = lines.join("\n");
  const today = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="suverse-buyer-payments-${today}.csv"`,
      // CSV exports are personal — do not cache anywhere.
      "cache-control": "private, no-store",
    },
  });
}

/** Minimal CSV-safe encoding: wrap any field with comma/quote/newline in quotes, double quotes inside. */
function csv(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
