"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cn,
  explorerUrl,
  formatRelativeTime,
  formatUsd,
  networkLabel,
  truncateMiddle,
} from "@/lib/utils";

type Filter = "all" | "settled" | "failed";

interface SettleRow {
  id: string;
  createdAt: string;
  network: string;
  asset: string;
  amount: string;
  feeAmount: string;
  status: "settled" | "failed" | "pending";
  txHash: string | null;
  adapterUsed: string | null;
  errorCode: string | null;
}

async function fetchSettles(
  filter: Filter,
  includeTestnet: boolean,
): Promise<SettleRow[]> {
  const qs = includeTestnet
    ? `?filter=${filter}&limit=50&testnet=1`
    : `?filter=${filter}&limit=50`;
  const res = await fetch(`/api/settles${qs}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`settles ${res.status}`);
  const data = (await res.json()) as { settles: SettleRow[] };
  return data.settles;
}

/**
 * Recent settles table. Auto-refreshes every 30s. The filter
 * pills sit inline above the table; clicking one reissues the
 * query. Tx hashes link to the relevant block explorer when known.
 */
export function SettlesTable({
  includeTestnet = false,
}: {
  includeTestnet?: boolean;
} = {}): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>("all");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["settles", filter, includeTestnet],
    queryFn: () => fetchSettles(filter, includeTestnet),
    refetchInterval: 30_000,
  });

  return (
    <div className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Recent settles
        </h3>
        <FilterPills value={filter} onChange={setFilter} />
      </header>

      <div className="overflow-x-auto">
        {isLoading ? (
          <div className="space-y-2 px-6 py-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="px-6 py-8 text-sm text-muted-foreground">
            Couldn’t load settles — try refreshing.
          </div>
        ) : !data || data.length === 0 ? (
          <SettlesEmpty />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-3 text-left font-medium sm:px-6">When</th>
                <th className="hidden px-3 py-3 text-left font-medium sm:table-cell sm:px-6">Network</th>
                <th className="px-3 py-3 text-right font-medium sm:px-6">Amount</th>
                <th className="hidden px-3 py-3 text-right font-medium md:table-cell md:px-6">Fee</th>
                <th className="px-3 py-3 text-left font-medium sm:px-6">Status</th>
                <th className="hidden px-3 py-3 text-left font-medium lg:table-cell lg:px-6">Tx</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <SettleTr key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SettleTr({ row }: { row: SettleRow }): React.JSX.Element {
  const url = row.txHash ? explorerUrl(row.network, row.txHash) : null;
  // Atomic-to-display: most chains 6dec, BSC/Tempo 18dec. We default
  // to 6dec because facilitator_payments doesn't carry decimals;
  // operators on 18dec chains see large numbers (correct, just
  // un-scaled — Phase 5 carry-over to extend the payment row).
  return (
    <tr className="border-t border-border/50 transition-colors hover:bg-secondary/40">
      <td className="px-3 py-3 text-muted-foreground sm:px-6">
        <div>{formatRelativeTime(new Date(row.createdAt))}</div>
        {/* Mobile-only inline network label — surfaces the network
            when the dedicated column is hidden on small screens. */}
        <div className="mt-0.5 text-[10px] text-muted-foreground/80 sm:hidden">
          {networkLabel(row.network)}
        </div>
      </td>
      <td className="hidden px-3 py-3 sm:table-cell sm:px-6">{networkLabel(row.network)}</td>
      <td className="px-3 py-3 text-right font-mono text-foreground sm:px-6">
        {formatUsd(row.amount, 6)}
      </td>
      <td
        className="hidden px-3 py-3 text-right font-mono text-xs text-muted-foreground md:table-cell md:px-6"
        title="Platform fee withheld at accounting level (out-of-band collection — see invoice export)"
      >
        {row.feeAmount === "0" ? "—" : formatUsd(row.feeAmount, 6)}
      </td>
      <td className="px-3 py-3 sm:px-6">
        <StatusBadge status={row.status} />
      </td>
      <td className="hidden px-3 py-3 font-mono text-xs text-muted-foreground lg:table-cell lg:px-6">
        {row.txHash ? (
          url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="hover:text-accent hover:underline"
            >
              {truncateMiddle(row.txHash, 8, 6)}
            </a>
          ) : (
            <span title={row.txHash}>{truncateMiddle(row.txHash, 8, 6)}</span>
          )
        ) : row.errorCode ? (
          <span className="text-destructive/80">{row.errorCode}</span>
        ) : (
          <span>—</span>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({
  status,
}: {
  status: "settled" | "failed" | "pending";
}): React.JSX.Element {
  const map = {
    settled: "bg-emerald-500/15 text-emerald-300",
    failed: "bg-destructive/15 text-destructive",
    pending: "bg-amber-500/15 text-amber-300",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-2 py-0.5 text-xs font-medium uppercase tracking-wider",
        map[status],
      )}
    >
      {status}
    </span>
  );
}

function SettlesEmpty(): React.JSX.Element {
  return (
    <div className="px-6 py-10 text-center">
      <div className="mx-auto max-w-md">
        <h4 className="font-medium text-foreground">No settles yet</h4>
        <p className="mt-2 text-sm text-muted-foreground">
          Settles are paid requests that landed on one of your proxy
          endpoints. Each row shows the network, amount, and tx hash —
          live within ~30 seconds of payment.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link
            href="/dashboard/proxies"
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-secondary"
          >
            View proxies
          </Link>
          <Link
            href="/dashboard/proxies/new"
            className="rounded-md border border-amber-400/50 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-400/20"
          >
            + New proxy
          </Link>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Share your proxy URL with a buyer to receive your first
          payment.
        </p>
      </div>
    </div>
  );
}

function FilterPills({
  value,
  onChange,
}: {
  value: Filter;
  onChange: (v: Filter) => void;
}): React.JSX.Element {
  const options: Array<{ k: Filter; label: string }> = [
    { k: "all", label: "All" },
    { k: "settled", label: "Settled" },
    { k: "failed", label: "Failed" },
  ];
  return (
    <div className="flex gap-1">
      {options.map((opt) => (
        <button
          key={opt.k}
          type="button"
          onClick={() => onChange(opt.k)}
          className={cn(
            "rounded px-3 py-1 text-xs font-medium transition-colors",
            value === opt.k
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
