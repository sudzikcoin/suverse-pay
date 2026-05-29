"use client";

import { useQuery } from "@tanstack/react-query";
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
import { formatUsd } from "@/lib/utils";
import type { Period } from "./period-toggle";

interface ChartPoint {
  bucket: string;
  volumeAtomic: string;
  settles: number;
}

async function fetchChart(period: Period): Promise<ChartPoint[]> {
  const res = await fetch(`/api/volume-chart?period=${period}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`volume-chart ${res.status}`);
  const data = (await res.json()) as { points: ChartPoint[] };
  return data.points;
}

/**
 * Volume line/area chart. Single-series area with amber stroke +
 * faded fill — minimal, just enough to read the volume trajectory.
 * Recharts is deliberately style-stripped (no axis lines, dashed
 * gridlines) to fit the editorial dashboard look.
 */
export function VolumeChart({ period }: { period: Period }): React.JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["volume-chart", period],
    queryFn: () => fetchChart(period),
    refetchInterval: 30_000,
  });

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Volume
        </h3>
        <span className="text-xs text-muted-foreground">
          {period === "24h" ? "by hour" : "by day"}
        </span>
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
            No volume in this period.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.map(toViewModel)}>
              <defs>
                <linearGradient id="vol-grad" x1="0" y1="0" x2="0" y2="1">
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
                tickFormatter={(v: number) =>
                  // Recharts passes numeric values; convert to a
                  // compact dollar string (e.g. "$2.4k").
                  formatCompactUsd(v)
                }
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
                formatter={(v: number) => formatUsd(String(Math.round(v * 1e6)), 6)}
              />
              <Area
                type="monotone"
                dataKey="volume"
                stroke="#F59E0B"
                strokeWidth={1.5}
                fill="url(#vol-grad)"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

interface ViewPoint {
  label: string;
  volume: number;
  settles: number;
}

function toViewModel(p: ChartPoint): ViewPoint {
  const d = new Date(p.bucket);
  // 24h period gets HH:00; 7d/30d gets MM-DD.
  const label = d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    hour12: false,
  });
  // Recharts wants Number, so down-scale the atomic uint to USDC
  // float (6 decimals). Values up to ~9e9 fit safely in Number.
  const volume = Number(BigInt(p.volumeAtomic) / 1_000n) / 1_000;
  return { label, volume, settles: p.settles };
}

function formatCompactUsd(v: number): string {
  if (v === 0) return "$0";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}
