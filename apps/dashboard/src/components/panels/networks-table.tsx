"use client";

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount, formatUsd, networkLabel } from "@/lib/utils";
import type { Period } from "./period-toggle";

interface NetworkBreakdownRow {
  network: string;
  settles: number;
  failed: number;
  volumeAtomic: string;
}

async function fetchNetworks(period: Period): Promise<NetworkBreakdownRow[]> {
  const res = await fetch(`/api/endpoints?period=${period}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`endpoints ${res.status}`);
  const data = (await res.json()) as { networks: NetworkBreakdownRow[] };
  return data.networks;
}

/**
 * Network breakdown — the per-network analog of the original
 * "per-endpoint" panel. We group by `network` because
 * `facilitator_payments` has no endpoint-path column today; the
 * Phase 5 wire-spec extension that lets resource servers attach
 * `resource_path` on settle will turn this into a true per-endpoint
 * breakdown without changing the panel.
 */
export function NetworksTable({ period }: { period: Period }): React.JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["networks", period],
    queryFn: () => fetchNetworks(period),
    refetchInterval: 30_000,
  });

  return (
    <div className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Networks
        </h3>
      </header>

      {isLoading ? (
        <div className="space-y-2 px-6 py-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="px-6 py-8 text-sm text-muted-foreground">
          Couldn’t load network breakdown.
        </div>
      ) : !data || data.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-muted-foreground">
          No activity in this period.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wider text-muted-foreground">
              <th className="px-6 py-3 text-left font-medium">Network</th>
              <th className="px-6 py-3 text-right font-medium">Settled</th>
              <th className="px-6 py-3 text-right font-medium">Failed</th>
              <th className="px-6 py-3 text-right font-medium">Volume</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row) => {
              const total = row.settles + row.failed;
              const successRate = total === 0 ? 0 : row.settles / total;
              return (
                <tr
                  key={row.network}
                  className="border-t border-border/50 transition-colors hover:bg-secondary/40"
                >
                  <td className="px-6 py-3">
                    <div className="flex flex-col">
                      <span className="font-medium">{networkLabel(row.network)}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {row.network}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-3 text-right font-mono">
                    {formatCount(row.settles)}
                    <span className="ml-1 text-[10px] text-muted-foreground">
                      {(successRate * 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-6 py-3 text-right font-mono text-muted-foreground">
                    {formatCount(row.failed)}
                  </td>
                  <td className="px-6 py-3 text-right font-mono">
                    {formatUsd(row.volumeAtomic, 6)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
