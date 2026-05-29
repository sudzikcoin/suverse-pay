"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCount, formatPercent, formatUsd } from "@/lib/utils";
import type { Period } from "./period-toggle";

interface StatsResponse {
  totalSettles: number;
  totalVolumeAtomic: string;
  successRate: number;
  activeNetworks: number;
}

async function fetchStats(period: Period): Promise<StatsResponse> {
  const res = await fetch(`/api/stats?period=${period}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`stats ${res.status}`);
  return (await res.json()) as StatsResponse;
}

/**
 * Four summary cards across the top of the dashboard. The layout
 * sits in a 4-column grid on desktop, collapses to 2-up at md, then
 * stacked on mobile. Each card is a thin border + huge tabular
 * number — the editorial "stat" look rather than a marketing card.
 */
export function SummaryCards({ period }: { period: Period }): React.JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["stats", period],
    queryFn: () => fetchStats(period),
    refetchInterval: 30_000,
  });

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      <StatCard
        title="Settles"
        value={data ? formatCount(data.totalSettles) : null}
        loading={isLoading}
        error={isError}
      />
      <StatCard
        title="Volume"
        value={data ? formatUsd(data.totalVolumeAtomic, 6) : null}
        loading={isLoading}
        error={isError}
        accent
      />
      <StatCard
        title="Success rate"
        value={data ? formatPercent(data.successRate) : null}
        loading={isLoading}
        error={isError}
      />
      <StatCard
        title="Active networks"
        value={data ? formatCount(data.activeNetworks) : null}
        loading={isLoading}
        error={isError}
      />
    </div>
  );
}

function StatCard({
  title,
  value,
  loading,
  error,
  accent = false,
}: {
  title: string;
  value: string | null;
  loading: boolean;
  error: boolean;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-9 w-32" />
        ) : error ? (
          <span className="font-display text-3xl text-muted-foreground">—</span>
        ) : (
          <span
            className={
              "stat-value font-display text-3xl font-medium leading-none " +
              (accent ? "text-amber-400" : "text-foreground")
            }
          >
            {value}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
