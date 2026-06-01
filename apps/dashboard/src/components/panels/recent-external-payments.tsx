"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import {
  explorerUrl,
  formatRelativeTime,
  formatUsd,
  networkLabel,
  truncateMiddle,
} from "@/lib/utils";

interface RecentPayment {
  id: string;
  createdAt: string;
  network: string;
  amountAtomic: string;
  payer: string | null;
  txHash: string | null;
  endpointSlug: string | null;
  displayName: string | null;
}

async function fetchRecent(): Promise<RecentPayment[]> {
  const res = await fetch(
    "/api/dashboard/recent-payments?limit=10&external_only=true",
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`recent-payments ${res.status}`);
  const j = (await res.json()) as { payments: RecentPayment[] };
  return j.payments;
}

/**
 * Last 10 external (real-buyer) payments — endpoint, network,
 * amount, payer, tx hash. Auto-refreshes every 30s so a fresh
 * payment shows up while the dashboard is open.
 */
export function RecentExternalPayments(): React.JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard-recent-external"],
    queryFn: fetchRecent,
    refetchInterval: 30_000,
  });

  return (
    <div className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Recent external payments
        </h3>
        <span className="text-[11px] text-muted-foreground">
          auto-refreshes every 30 s
        </span>
      </header>
      <div className="overflow-x-auto">
        {isLoading ? (
          <div className="space-y-2 px-6 py-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="px-6 py-8 text-sm text-muted-foreground">
            Couldn’t load recent payments — try refreshing.
          </div>
        ) : !data || data.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No external payments yet — share an endpoint URL with a
            buyer to see settles land here.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                <th className="px-6 py-3">When</th>
                <th className="px-6 py-3">Endpoint</th>
                <th className="px-6 py-3 hidden sm:table-cell">Network</th>
                <th className="px-6 py-3 text-right">Amount</th>
                <th className="px-6 py-3 hidden md:table-cell">Payer</th>
                <th className="px-6 py-3 hidden lg:table-cell">Tx</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => {
                const tx = p.txHash
                  ? explorerUrl(p.network, p.txHash)
                  : null;
                return (
                  <tr
                    key={p.id}
                    className="border-t border-border/50 transition-colors hover:bg-secondary/40"
                  >
                    <td className="px-6 py-3 text-muted-foreground whitespace-nowrap">
                      {formatRelativeTime(new Date(p.createdAt))}
                    </td>
                    <td className="px-6 py-3">
                      {p.endpointSlug ? (
                        <span className="font-mono text-[11px] text-foreground">
                          {p.displayName ?? p.endpointSlug}
                        </span>
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          direct
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 hidden sm:table-cell text-muted-foreground">
                      {networkLabel(p.network)}
                    </td>
                    <td className="px-6 py-3 text-right font-mono text-amber-300">
                      {formatUsd(p.amountAtomic, 6)}
                    </td>
                    <td className="px-6 py-3 hidden md:table-cell font-mono text-[11px] text-muted-foreground">
                      {p.payer ? (
                        <span title={p.payer}>
                          {truncateMiddle(p.payer, 6, 4)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-6 py-3 hidden lg:table-cell font-mono text-[11px] text-muted-foreground">
                      {p.txHash ? (
                        tx ? (
                          <a
                            href={tx}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:text-accent hover:underline"
                          >
                            {truncateMiddle(p.txHash, 8, 6)}
                          </a>
                        ) : (
                          <span title={p.txHash}>
                            {truncateMiddle(p.txHash, 8, 6)}
                          </span>
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <footer className="border-t border-border px-6 py-3 text-right">
        <Link
          href="/dashboard/proxies"
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          See all endpoints →
        </Link>
      </footer>
    </div>
  );
}
