import { auth } from "@/lib/auth";
import {
  getLinkedResourceKeys,
  loadInvoice,
  type InvoiceLineRow,
  type InvoiceSummary,
} from "@/lib/queries";

/**
 * GET /api/invoice?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns a CSV of every settled row in `[from, to)` for the user's
 * linked resource keys, plus a comment-block summary at the top so
 * the file is human-readable in a text editor as well as machine-
 * parseable in a spreadsheet.
 *
 * The `to` boundary is EXCLUSIVE — pass the first day of the next
 * month to grab a full calendar month. If both query params are
 * absent the route defaults to the previous completed UTC calendar
 * month (the common "send me my invoice for last month" flow).
 *
 * Amounts are emitted as USD decimals (USDC = 6 decimals across all
 * routes we currently advertise). The CSV is intentionally NOT
 * RFC4180 quoted — the only field that could theoretically contain
 * a comma is `keyLabel`, and we strip commas from the label at
 * serialise time so the format stays trivial to grep / awk.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const url = new URL(request.url);
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");

  let from: Date;
  let until: Date;
  if (fromStr === null && toStr === null) {
    const range = previousCompletedMonthUtc(new Date());
    from = range.from;
    until = range.until;
  } else {
    const fromParsed = parseIsoDateUtc(fromStr);
    const untilParsed = parseIsoDateUtc(toStr);
    if (fromParsed === null || untilParsed === null) {
      return new Response(
        JSON.stringify({
          error: "from + to must both be YYYY-MM-DD when supplied",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (untilParsed.getTime() <= fromParsed.getTime()) {
      return new Response(
        JSON.stringify({ error: "to must be strictly after from" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    from = fromParsed;
    until = untilParsed;
  }

  const keys = await getLinkedResourceKeys(session.user.id);
  const { lines, summary } = await loadInvoice({
    resourceKeyIds: keys,
    from,
    until,
  });
  const userLabel =
    session.user.email ?? session.user.name ?? "(unknown user)";
  const csv = renderInvoiceCsv({ lines, summary, userLabel });
  const filename = invoiceFilename(from, until);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function parseIsoDateUtc(s: string | null): Date | null {
  if (s === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function previousCompletedMonthUtc(now: Date): { from: Date; until: Date } {
  const until = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
  );
  return { from, until };
}

function invoiceFilename(from: Date, until: Date): string {
  const stamp = (d: Date): string =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return `suverse-pay-invoice-${stamp(from)}_to_${stamp(until)}.csv`;
}

/** USDC = 6 decimals on every chain we currently advertise. */
const USDC_DECIMALS = 6;

function formatAtomicAsUsd(atomic: string): string {
  // Big numbers: avoid Number — parse via BigInt and pad.
  const b = BigInt(atomic);
  const negative = b < 0n;
  const abs = negative ? -b : b;
  const s = abs.toString().padStart(USDC_DECIMALS + 1, "0");
  const whole = s.slice(0, s.length - USDC_DECIMALS);
  const frac = s.slice(s.length - USDC_DECIMALS);
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

function csvSafe(s: string): string {
  // Strip commas + newlines from free-text fields. Acceptable here
  // because the only such field is `keyLabel`, set by the customer
  // and not part of the on-chain truth.
  return s.replace(/[,\n\r]/g, " ").trim();
}

function renderInvoiceCsv(args: {
  lines: InvoiceLineRow[];
  summary: InvoiceSummary;
  userLabel: string;
}): string {
  const out: string[] = [];
  out.push("# Suverse Pay — Platform Fee Invoice");
  out.push(
    `# Period: ${args.summary.from.toISOString()} → ${args.summary.until.toISOString()} (UTC, [from, to))`,
  );
  out.push(`# Generated: ${new Date().toISOString()}`);
  out.push(`# User: ${csvSafe(args.userLabel)}`);
  out.push("#");
  out.push("# Summary:");
  out.push(`#   Total settles:       ${args.summary.totalSettles}`);
  out.push(
    `#   Total volume (USDC): ${formatAtomicAsUsd(args.summary.totalGrossAtomic)}`,
  );
  out.push(
    `#   Total platform fee:  ${formatAtomicAsUsd(args.summary.totalFeeAtomic)} USDC ← amount owed`,
  );
  out.push(
    `#   Total net to merchant: ${formatAtomicAsUsd(args.summary.totalNetAtomic)} USDC`,
  );
  out.push("#");
  out.push(
    "# Settle the platform fee out-of-band (USDC transfer to the operator's payout address, or wire) within 7 days.",
  );
  out.push("#");
  out.push("date,settle_id,network,gross_usdc,fee_usdc,net_usdc,tx_hash,key_label");
  for (const l of args.lines) {
    out.push(
      [
        l.createdAt,
        l.settleId,
        l.network,
        formatAtomicAsUsd(l.grossAmount),
        formatAtomicAsUsd(l.feeAmount),
        formatAtomicAsUsd(l.netAmount),
        l.txHash ?? "",
        csvSafe(l.keyLabel),
      ].join(","),
    );
  }
  return out.join("\n") + "\n";
}
