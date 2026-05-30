"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface BuyerPayment {
  id: string;
  createdAt: string;
  network: string;
  amount: string;
  asset: string;
  payer: string | null;
  recipient: string;
  txHash: string | null;
  status: string;
  errorCode: string | null;
}

interface PageResult {
  payments: BuyerPayment[];
  total: number;
  page: number;
  pageSize: number;
}

interface Filters {
  network: string;
  recipient: string;
  since: string;
  until: string;
}

const PAGE_SIZE = 50;

export function PaymentsView({
  hasWallets,
}: {
  hasWallets: boolean;
}): React.JSX.Element {
  const [filters, setFilters] = useState<Filters>({
    network: "",
    recipient: "",
    since: "",
    until: "",
  });
  const [appliedFilters, setAppliedFilters] = useState<Filters>(filters);
  const [page, setPage] = useState(1);

  const qs = buildQuery({ ...appliedFilters, page, pageSize: PAGE_SIZE });
  const { data, isLoading, isError } = useQuery<PageResult>({
    queryKey: ["buyer-payments", qs],
    queryFn: async () => {
      const res = await fetch(`/api/buyer/payments?${qs}`);
      if (!res.ok) throw new Error(`payments ${res.status}`);
      return (await res.json()) as PageResult;
    },
    enabled: hasWallets,
    refetchInterval: 30_000,
  });

  if (!hasWallets) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/30 p-10 text-center">
        <h3 className="font-display text-lg text-foreground">
          No wallets registered
        </h3>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Add a payer address on the Wallets page to start seeing
          payments here.
        </p>
      </div>
    );
  }

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const lo = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const hi = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-6">
      <FilterBar
        filters={filters}
        onChange={setFilters}
        onApply={() => {
          setAppliedFilters(filters);
          setPage(1);
        }}
        onReset={() => {
          const empty = { network: "", recipient: "", since: "", until: "" };
          setFilters(empty);
          setAppliedFilters(empty);
          setPage(1);
        }}
        exportQuery={buildQuery(appliedFilters)}
      />

      {isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load payments. Try refreshing.
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-card/40">
            <tr className="text-left text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Network</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3 hidden md:table-cell">Recipient</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 hidden lg:table-cell">Tx</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [0, 1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-t border-border/40">
                  <td colSpan={6} className="px-4 py-3">
                    <Skeleton className="h-6 w-full" />
                  </td>
                </tr>
              ))
            ) : !data || data.payments.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  No payments match these filters.
                </td>
              </tr>
            ) : (
              data.payments.map((p) => <PaymentRow key={p.id} row={p} />)
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {total === 0 ? "0 payments" : `Showing ${lo}–${hi} of ${total}`}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page <= 1 || isLoading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            ← Prev
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page} / {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page >= totalPages || isLoading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilterBar({
  filters,
  onChange,
  onApply,
  onReset,
  exportQuery,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  onApply: () => void;
  onReset: () => void;
  exportQuery: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Labelled label="Network (CAIP-2)">
          <Input
            value={filters.network}
            onChange={(e) => onChange({ ...filters, network: e.target.value })}
            placeholder="eip155:8453"
            className="font-mono text-xs"
          />
        </Labelled>
        <Labelled label="Recipient contains">
          <Input
            value={filters.recipient}
            onChange={(e) => onChange({ ...filters, recipient: e.target.value })}
            placeholder="0x..."
            className="font-mono text-xs"
          />
        </Labelled>
        <Labelled label="Since">
          <Input
            type="date"
            value={filters.since}
            onChange={(e) => onChange({ ...filters, since: e.target.value })}
          />
        </Labelled>
        <Labelled label="Until">
          <Input
            type="date"
            value={filters.until}
            onChange={(e) => onChange({ ...filters, until: e.target.value })}
          />
        </Labelled>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button type="button" variant="accent" size="sm" onClick={onApply}>
          Apply filters
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onReset}>
          Reset
        </Button>
        <a
          href={`/api/buyer/payments/export.csv${exportQuery ? `?${exportQuery}` : ""}`}
          className="ml-auto text-xs text-amber-400 underline-offset-4 hover:underline"
        >
          ⇣ Export CSV
        </a>
      </div>
    </div>
  );
}

function Labelled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function PaymentRow({ row }: { row: BuyerPayment }): React.JSX.Element {
  return (
    <tr className="border-t border-border/40 hover:bg-secondary/30">
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {new Date(row.createdAt).toLocaleString()}
      </td>
      <td className="px-4 py-3 font-mono text-xs">{row.network}</td>
      <td className="px-4 py-3 text-right font-mono tabular-nums">
        ${atomicToUsd(row.amount)}
      </td>
      <td className="px-4 py-3 hidden md:table-cell">
        <span className="font-mono text-xs text-muted-foreground" title={row.recipient}>
          {truncateMiddle(row.recipient, 8, 6)}
        </span>
      </td>
      <td className="px-4 py-3">
        <StatusPill status={row.status} />
        {row.errorCode ? (
          <span className="ml-2 font-mono text-[10px] text-muted-foreground">
            {row.errorCode}
          </span>
        ) : null}
      </td>
      <td className="px-4 py-3 hidden lg:table-cell">
        {row.txHash ? (
          <span className="font-mono text-[11px] text-muted-foreground" title={row.txHash}>
            {truncateMiddle(row.txHash, 8, 6)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function StatusPill({ status }: { status: string }): React.JSX.Element {
  const map: Record<string, string> = {
    settled: "bg-emerald-500/15 text-emerald-300",
    failed: "bg-destructive/15 text-destructive",
    pending: "bg-amber-500/15 text-amber-300",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        map[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

function buildQuery(
  args: Partial<Filters> & { page?: number; pageSize?: number },
): string {
  const sp = new URLSearchParams();
  if (args.network) sp.set("network", args.network);
  if (args.recipient) sp.set("recipient", args.recipient);
  if (args.since) sp.set("since", args.since);
  if (args.until) sp.set("until", args.until);
  if (args.page !== undefined) sp.set("page", String(args.page));
  if (args.pageSize !== undefined) sp.set("pageSize", String(args.pageSize));
  return sp.toString();
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

function truncateMiddle(s: string, lead: number, tail: number): string {
  if (s.length <= lead + tail + 1) return s;
  return `${s.slice(0, lead)}…${s.slice(-tail)}`;
}
