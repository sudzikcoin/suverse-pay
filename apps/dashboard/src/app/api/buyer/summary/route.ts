import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getBuyerSummary, type SummaryPeriod } from "@/lib/buyer";

/**
 * GET /api/buyer/summary?period=24h|7d|30d
 *
 * Returns an aggregate of the user's buyer spend over the period.
 * If the user has no registered wallets, returns zero counts — the
 * client uses that to render the empty-state CTA.
 */
const PERIODS: ReadonlyArray<SummaryPeriod> = ["24h", "7d", "30d"];

export async function GET(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const periodRaw = url.searchParams.get("period") ?? "7d";
  const period = (PERIODS as ReadonlyArray<string>).includes(periodRaw)
    ? (periodRaw as SummaryPeriod)
    : "7d";
  const summary = await getBuyerSummary(session.user.id, period);
  return NextResponse.json(summary, {
    headers: { "Cache-Control": "private, max-age=15" },
  });
}
