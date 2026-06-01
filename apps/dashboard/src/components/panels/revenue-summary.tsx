"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatCount, formatUsd } from "@/lib/utils";

type SummaryPeriod = "24h" | "7d" | "30d" | "all";

interface SummaryResponse {
  period: SummaryPeriod;
  totalRevenueAtomic: string;
  externalRevenueAtomic: string;
  selfRevenueAtomic: string;
  totalSettles: number;
  externalSettles: number;
  uniqueExternalPayers: number;
}

async function fetchSummary(p: SummaryPeriod): Promise<SummaryResponse> {
  const res = await fetch(`/api/dashboard/summary?period=${p}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`summary ${res.status}`);
  return (await res.json()) as SummaryResponse;
}

const TABS: ReadonlyArray<{ value: SummaryPeriod; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All time" },
];

/**
 * Revenue summary block — period tabs at the top, three stat tiles
 * underneath (external revenue is the hero, self/total + payer
 * counts follow). External vs self is the load-bearing distinction
 * the redesign is meant to surface.
 */
export function RevenueSummary({
  onPeriodChange,
}: {
  onPeriodChange?: (p: SummaryPeriod) => void;
} = {}): React.JSX.Element {
  const [period, setPeriod] = useState<SummaryPeriod>("24h");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard-summary", period],
    queryFn: () => fetchSummary(period),
    refetchInterval: 30_000,
  });

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Revenue
        </h3>
        <div
          role="tablist"
          aria-label="Revenue period"
          className="inline-flex items-center gap-px rounded-md border border-border bg-card p-0.5"
        >
          {TABS.map((t) => {
            const active = t.value === period;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  setPeriod(t.value);
                  onPeriodChange?.(t.value);
                }}
                className={cn(
                  "rounded px-3 py-1 text-[11px] font-medium transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="External revenue"
          accent
          loading={isLoading}
          error={isError}
          value={data ? formatUsd(data.externalRevenueAtomic, 6) : null}
          sub={
            data
              ? `${formatCount(data.externalSettles)} external settle${data.externalSettles === 1 ? "" : "s"}`
              : null
          }
        />
        <Tile
          label="Self / test revenue"
          loading={isLoading}
          error={isError}
          value={data ? formatUsd(data.selfRevenueAtomic, 6) : null}
          sub={
            data
              ? `${formatCount(data.totalSettles - data.externalSettles)} self settle${
                  data.totalSettles - data.externalSettles === 1 ? "" : "s"
                }`
              : null
          }
        />
        <Tile
          label="Total revenue"
          loading={isLoading}
          error={isError}
          value={data ? formatUsd(data.totalRevenueAtomic, 6) : null}
          sub={
            data
              ? `${formatCount(data.totalSettles)} total settle${data.totalSettles === 1 ? "" : "s"}`
              : null
          }
        />
        <Tile
          label="Unique external payers"
          loading={isLoading}
          error={isError}
          value={data ? formatCount(data.uniqueExternalPayers) : null}
          sub={null}
        />
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  accent,
  loading,
  error,
}: {
  label: string;
  value: string | null;
  sub: string | null;
  accent?: boolean;
  loading: boolean;
  error: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 min-h-[2rem]">
        {loading ? (
          <Skeleton className="h-7 w-24" />
        ) : error || value === null ? (
          <span className="font-display text-2xl text-muted-foreground">—</span>
        ) : (
          <span
            className={cn(
              "font-display text-2xl font-medium leading-none tabular-nums",
              accent && "text-amber-400",
            )}
          >
            {value}
          </span>
        )}
      </div>
      {sub ? (
        <div className="mt-2 text-[10px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  );
}
