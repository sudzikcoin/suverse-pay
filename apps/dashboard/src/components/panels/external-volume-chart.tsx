"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatUsd } from "@/lib/utils";

type ChartPeriod = "24h" | "7d" | "30d";

interface ChartPoint {
  bucket: string;
  externalVolumeAtomic: string;
  externalSettles: number;
}

async function fetchChart(period: ChartPeriod): Promise<ChartPoint[]> {
  const res = await fetch(`/api/dashboard/volume-chart?period=${period}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`volume-chart ${res.status}`);
  const data = (await res.json()) as { points: ChartPoint[] };
  return data.points;
}

const PERIODS: ReadonlyArray<{ value: ChartPeriod; label: string }> = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

/**
 * External-only volume chart for the redesigned dashboard. Mirrors
 * the existing /panels/volume-chart styling so the two coexist
 * coherently, but the data source is the external-only aggregate.
 */
export function ExternalVolumeChart(): React.JSX.Element {
  const [period, setPeriod] = useState<ChartPeriod>("7d");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard-external-volume", period],
    queryFn: () => fetchChart(period),
    refetchInterval: 60_000,
  });

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            External volume
          </h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            real-buyer settles only — self / smoke-test payments excluded
          </p>
        </div>
        <div className="inline-flex items-center gap-px rounded-md border border-border p-0.5">
          {PERIODS.map((p) => {
            const active = period === p.value;
            return (
              <button
                key={p.value}
                type="button"
                onClick={() => setPeriod(p.value)}
                className={cn(
                  "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="h-64">
        {isLoading ? (
          <Skeleton className="h-full w-full" />
        ) : isError ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Couldn’t load volume — try refreshing.
          </div>
        ) : !data || data.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No external settles in this period yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.map((p) => toViewModel(p, period))}>
              <defs>
                <linearGradient id="ext-vol-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#F59E0B" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#F59E0B" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="2 4"
                stroke="hsl(var(--border))"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tick={{
                  fontSize: 11,
                  fill: "hsl(var(--muted-foreground))",
                }}
                minTickGap={32}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{
                  fontSize: 11,
                  fill: "hsl(var(--muted-foreground))",
                }}
                tickFormatter={(v: number) => compactUsd(v)}
                width={48}
              />
              <Tooltip
                cursor={{
                  stroke: "hsl(var(--accent))",
                  strokeWidth: 1,
                  strokeDasharray: "3 3",
                }}
                contentStyle={{
                  background: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  fontSize: 12,
                  fontFamily: "var(--font-jetbrains-mono)",
                }}
                labelStyle={{
                  color: "hsl(var(--muted-foreground))",
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                }}
                formatter={(v: number) =>
                  formatUsd(String(Math.round(v * 1e6)), 6)
                }
              />
              <Area
                type="monotone"
                dataKey="volume"
                stroke="#F59E0B"
                strokeWidth={1.5}
                fill="url(#ext-vol-grad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function toViewModel(
  p: ChartPoint,
  period: ChartPeriod,
): { label: string; volume: number; settles: number } {
  const d = new Date(p.bucket);
  const label =
    period === "24h"
      ? d.toLocaleString("en-US", {
          hour: "numeric",
          hour12: false,
        }) + ":00"
      : d.toLocaleString("en-US", { month: "short", day: "numeric" });
  // Recharts wants Number; downscale atomic→USDC float (6 dec).
  const volume = Number(BigInt(p.externalVolumeAtomic) / 1_000n) / 1_000;
  return { label, volume, settles: p.externalSettles };
}

function compactUsd(v: number): string {
  if (v === 0) return "$0";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}
