"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

type Period = "24h" | "7d" | "30d";

interface BuyerSummary {
  totalAtomic: string;
  txCount: number;
  settledCount: number;
  failedCount: number;
  topEndpoints: Array<{
    recipient: string;
    txCount: number;
    totalAtomic: string;
  }>;
  byNetwork: Array<{ network: string; txCount: number; totalAtomic: string }>;
}

const PERIOD_LABEL: Record<Period, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

export function BuyerOverview({
  hasWallets,
}: {
  hasWallets: boolean;
}): React.JSX.Element {
  const [period, setPeriod] = useState<Period>("7d");
  const { data, isLoading, isError } = useQuery<BuyerSummary>({
    queryKey: ["buyer-summary", period],
    queryFn: async () => {
      const res = await fetch(`/api/buyer/summary?period=${period}`);
      if (!res.ok) throw new Error(`summary ${res.status}`);
      return (await res.json()) as BuyerSummary;
    },
    enabled: hasWallets,
    refetchInterval: 30_000,
  });

  if (!hasWallets) {
    return <NoWalletsEmpty />;
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">{PERIOD_LABEL[period]}</div>
        <PeriodPills value={period} onChange={setPeriod} />
      </div>

      {isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load summary. Try refreshing.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard
          label="Total spent"
          value={data ? `$${atomicToUsd(data.totalAtomic)}` : null}
          isLoading={isLoading}
          accent
        />
        <SummaryCard
          label="Settled txs"
          value={data ? String(data.settledCount) : null}
          isLoading={isLoading}
        />
        <SummaryCard
          label="Failed txs"
          value={data ? String(data.failedCount) : null}
          isLoading={isLoading}
        />
        <SummaryCard
          label="Networks used"
          value={data ? String(data.byNetwork.length) : null}
          isLoading={isLoading}
        />
      </div>

      <Panel title="Top endpoints by spend">
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !data || data.topEndpoints.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No settled spend in this period. Make a paid request from
            one of your wallets to populate this list.
          </p>
        ) : (
          <ul className="divide-y divide-border/40">
            {data.topEndpoints.map((row) => (
              <li
                key={row.recipient}
                className="flex items-center justify-between gap-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-foreground">
                    {row.recipient}
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {row.txCount} tx{row.txCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="text-right font-mono text-sm text-foreground">
                  ${atomicToUsd(row.totalAtomic)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Spend by network">
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !data || data.byNetwork.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No network activity yet.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {data.byNetwork.map((row) => (
              <li
                key={row.network}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-card/40 px-3 py-2"
              >
                <div>
                  <div className="font-mono text-xs">{row.network}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {row.txCount} tx{row.txCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="font-mono text-sm">
                  ${atomicToUsd(row.totalAtomic)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function NoWalletsEmpty(): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/30 p-10 text-center">
      <h3 className="font-display text-lg text-foreground">
        Register a wallet to start tracking
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Your buyer dashboard shows payments where the on-chain payer
        is one of your registered addresses. Add a wallet to see your
        agent's spend appear here within seconds of each settled call.
      </p>
      <Link
        href="/dashboard/buyer/wallets"
        className="mt-6 inline-flex rounded-md border border-amber-400/50 bg-amber-400/10 px-4 py-2 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-400/20"
      >
        + Register a wallet
      </Link>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  isLoading,
  accent,
}: {
  label: string;
  value: string | null;
  isLoading: boolean;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      {isLoading ? (
        <Skeleton className="mt-2 h-7 w-20" />
      ) : (
        <div
          className={cn(
            "mt-1 font-display text-2xl font-medium tabular-nums",
            accent && "text-amber-400",
          )}
        >
          {value ?? "—"}
        </div>
      )}
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function PeriodPills({
  value,
  onChange,
}: {
  value: Period;
  onChange: (p: Period) => void;
}): React.JSX.Element {
  const options: Period[] = ["24h", "7d", "30d"];
  return (
    <div className="inline-flex rounded-md border border-border bg-card p-0.5">
      {options.map((p) => (
        <button
          key={p}
          type="button"
          aria-pressed={p === value}
          onClick={() => onChange(p)}
          className={cn(
            "rounded px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors",
            p === value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function atomicToUsd(atomic: string): string {
  try {
    const n = BigInt(atomic);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
  } catch {
    return "0";
  }
}
