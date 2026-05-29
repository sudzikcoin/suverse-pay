"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";

/**
 * Button that downloads `/api/invoice` (CSV) for the previous
 * completed UTC calendar month. Pure browser link — no JS-side
 * fetch, no progress UI — letting the browser handle the download
 * stream and filename surfacing.
 *
 * Why default to "last month" and not "month-to-date":
 *   - Customers reconcile monthly, not in-progress.
 *   - Once the month closes, the CSV is stable (no new rows can
 *     land in [from, to)) → safe to forward to accounting / pay
 *     against.
 *
 * If a customer needs a custom range, they can hit /api/invoice
 * directly: `/api/invoice?from=2026-04-01&to=2026-05-01`.
 */
export function InvoiceDownload(): React.JSX.Element {
  const label = useMemo(() => {
    const now = new Date();
    const prev = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    return prev.toLocaleString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }, []);

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Platform fee invoice
          </h3>
          <p className="mt-1 text-sm">
            Download last month&rsquo;s settle log as a CSV — totals at the top,
            one row per settled payment below.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Suverse Pay does not yet collect the platform fee on-chain.
            Settle the total at the bottom of the CSV out-of-band (USDC
            transfer to the operator&rsquo;s payout address).
          </p>
        </div>
        <a href="/api/invoice" download>
          <Button type="button" variant="outline">
            Download {label} (.csv)
          </Button>
        </a>
      </div>
    </div>
  );
}
