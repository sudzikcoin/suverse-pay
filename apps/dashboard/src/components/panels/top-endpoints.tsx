"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount, formatUsd } from "@/lib/utils";

interface TopEndpoint {
  proxyId: string;
  endpointSlug: string;
  displayName: string | null;
  priceAtomic: string;
  internalHandler: string | null;
  externalSettles: number;
  externalRevenueAtomic: string;
}

async function fetchTop(): Promise<TopEndpoint[]> {
  const res = await fetch(
    "/api/dashboard/top-endpoints?period=24h&limit=5",
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`top-endpoints ${res.status}`);
  const j = (await res.json()) as { endpoints: TopEndpoint[] };
  return j.endpoints;
}

/**
 * Top-5 endpoints by 24h external revenue. Shown as a compact
 * table so it sits well next to the recent-payments list in the
 * two-column section.
 */
export function TopEndpoints(): React.JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard-top-endpoints"],
    queryFn: fetchTop,
    refetchInterval: 60_000,
  });

  return (
    <div className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Top endpoints · 24h external
          </h3>
        </div>
        <Link
          href="/dashboard/proxies"
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          All →
        </Link>
      </header>
      <div className="overflow-x-auto">
        {isLoading ? (
          <div className="space-y-2 px-6 py-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="px-6 py-8 text-sm text-muted-foreground">
            Couldn’t load top endpoints — try refreshing.
          </div>
        ) : !data || data.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No external settles in the last 24h.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                <th className="px-6 py-3">Endpoint</th>
                <th className="px-6 py-3 hidden sm:table-cell">Type</th>
                <th className="px-6 py-3 text-right hidden md:table-cell">Price</th>
                <th className="px-6 py-3 text-right">Settles</th>
                <th className="px-6 py-3 text-right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr
                  key={r.proxyId}
                  className="border-t border-border/50 transition-colors hover:bg-secondary/40"
                >
                  <td className="px-6 py-3">
                    <Link
                      href={`/dashboard/proxies/${r.proxyId}`}
                      className="font-medium text-foreground hover:text-amber-200"
                    >
                      {r.displayName ?? r.endpointSlug}
                    </Link>
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {r.endpointSlug}
                    </div>
                  </td>
                  <td className="px-6 py-3 hidden sm:table-cell">
                    <TypeBadge internalHandler={r.internalHandler} />
                  </td>
                  <td className="px-6 py-3 text-right font-mono text-xs text-muted-foreground hidden md:table-cell">
                    {formatUsd(r.priceAtomic, 6)}
                  </td>
                  <td className="px-6 py-3 text-right font-mono">
                    {formatCount(r.externalSettles)}
                  </td>
                  <td className="px-6 py-3 text-right font-mono text-amber-300">
                    {formatUsd(r.externalRevenueAtomic, 6)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function TypeBadge({
  internalHandler,
}: {
  internalHandler: string | null;
}): React.JSX.Element {
  const isInternal = internalHandler !== null;
  return (
    <span
      className={
        "inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider " +
        (isInternal
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-secondary text-muted-foreground")
      }
    >
      {isInternal ? "internal" : "proxy"}
    </span>
  );
}
