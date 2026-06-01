"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsd, truncateMiddle } from "@/lib/utils";

// ----------------------------------------------------- shared types ---

interface SuverseWalletApi {
  id: string;
  address: string;
  network: string;
  kind: "merchant" | "swap" | "service" | "test-buyer";
  label: string;
  purpose: string;
  hasPrivateKey: boolean;
  explorerUrl: string;
  operatingCapitalAtomic?: string;
}

interface TokenBalance {
  symbol: string;
  amountAtomic: string;
  decimals: number;
  tokenIdentifier?: string;
}

interface BalanceSnapshot {
  walletId: string;
  address: string;
  network: string;
  native: TokenBalance;
  usdc: TokenBalance;
  extras: TokenBalance[];
  errors: Record<string, string> | null;
}

interface SummaryPayload {
  operationalCapital: {
    totalUsdcAtomic: string;
    perChain: { base: string; solana: string; cosmos: string };
  };
  fees: {
    todayAtomic: string;
    weekAtomic: string;
    monthAtomic: string;
    daily: Array<{ date: string; feeAtomic: string }>;
  };
  pendingRefunds: { countRows: number; totalUsdcAtomic: string };
  orphanTokens: {
    countRows: number;
    totalUsdcAtomic: string;
    items: Array<{ walletId: string; symbol: string; amountAtomic: string }>;
  };
  topActiveWallets24h: Array<{
    walletId: string;
    events24h: number;
    netUsdcAtomic: string;
  }>;
}

interface ActivityEvent {
  occurredAt: string;
  id: string;
  walletId: string;
  kind: string;
  amountUsdcAtomic: string;
  counterparty: string | null;
  txHash: string | null;
  detail: string | null;
}

interface ActivityPayload {
  walletId: string;
  events: ActivityEvent[];
}

// ----------------------------------------------------- fetchers ---

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

// ----------------------------------------------------- view ---

export function WalletsView(): React.JSX.Element {
  const summary = useQuery({
    queryKey: ["wallets-summary"],
    queryFn: () => fetchJson<SummaryPayload>("/api/wallets/summary"),
    refetchInterval: 60_000,
  });
  const list = useQuery({
    queryKey: ["wallets-list"],
    queryFn: () =>
      fetchJson<{ wallets: SuverseWalletApi[] }>("/api/wallets/list"),
    staleTime: 5 * 60_000,
  });

  if (list.isError || summary.isError) {
    return (
      <Card className="p-6 text-sm text-red-400">
        Failed to load wallets. Check the dashboard logs and try again.
      </Card>
    );
  }

  return (
    <div className="space-y-10">
      <SummaryRow summary={summary.data} loading={summary.isLoading} />
      <FeesChart summary={summary.data} loading={summary.isLoading} />
      <WalletGrid
        wallets={list.data?.wallets ?? []}
        loading={list.isLoading}
        summary={summary.data}
      />
      <RecentTransactions wallets={list.data?.wallets ?? []} />
    </div>
  );
}

// ----------------------------------------------------- summary row ---

function SummaryRow({
  summary,
  loading,
}: {
  summary?: SummaryPayload;
  loading: boolean;
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Card key={i} className="p-4">
            <Skeleton className="mb-2 h-3 w-20" />
            <Skeleton className="h-7 w-28" />
          </Card>
        ))}
      </div>
    );
  }
  if (!summary) return <></>;
  const orphanColor = summary.orphanTokens.countRows > 0
    ? "text-red-400"
    : "text-muted-foreground";
  const refundColor = summary.pendingRefunds.countRows > 0
    ? "text-amber-400"
    : "text-muted-foreground";
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <SummaryCard
        label="Operational capital"
        value={formatUsd(summary.operationalCapital.totalUsdcAtomic)}
        detail="USDC across all wallets"
      />
      <SummaryCard
        label="Fees earned (today)"
        value={formatUsd(summary.fees.todayAtomic)}
        detail="Completed swaps · UTC day"
      />
      <SummaryCard
        label="Fees earned (7 day)"
        value={formatUsd(summary.fees.weekAtomic)}
        detail="Rolling window"
      />
      <SummaryCard
        label="Pending refunds"
        value={formatUsd(summary.pendingRefunds.totalUsdcAtomic)}
        detail={`${summary.pendingRefunds.countRows} row(s) awaiting action`}
        valueClass={refundColor}
      />
      <SummaryCard
        label="Orphan tokens"
        value={formatUsd(summary.orphanTokens.totalUsdcAtomic)}
        detail={
          summary.orphanTokens.countRows === 0
            ? "No stranded balances"
            : `${summary.orphanTokens.countRows} token(s) need reconcile`
        }
        valueClass={orphanColor}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  valueClass,
}: {
  label: string;
  value: string;
  detail: string;
  valueClass?: string;
}): React.JSX.Element {
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 font-display text-2xl font-medium leading-tight ${valueClass ?? ""}`}
      >
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </Card>
  );
}

// ----------------------------------------------------- mini fees chart ---

function FeesChart({
  summary,
  loading,
}: {
  summary?: SummaryPayload;
  loading: boolean;
}): React.JSX.Element {
  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="mb-4 h-3 w-32" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }
  if (!summary) return <></>;
  const series = summary.fees.daily;
  const max = series.reduce((m, d) => {
    const v = BigInt(d.feeAtomic);
    return v > m ? v : m;
  }, 0n);
  return (
    <Card className="p-6">
      <div className="mb-4 flex items-baseline justify-between">
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Fees earned · 30 days
        </div>
        <div className="text-xs text-muted-foreground">
          {formatUsd(summary.fees.monthAtomic)} total
        </div>
      </div>
      <div className="flex h-24 items-end gap-[2px]">
        {series.map((d) => {
          const v = BigInt(d.feeAtomic);
          const pct = max > 0n
            ? Number((v * 1000n) / max) / 10
            : 0;
          return (
            <div
              key={d.date}
              className="flex-1 rounded-sm bg-emerald-500/70"
              style={{ height: `${Math.max(pct, 1)}%` }}
              title={`${d.date} — ${formatUsd(d.feeAtomic)}`}
            />
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        <span>{series[0]?.date}</span>
        <span>{series[series.length - 1]?.date}</span>
      </div>
    </Card>
  );
}

// ----------------------------------------------------- wallet grid ---

function WalletGrid({
  wallets,
  loading,
  summary,
}: {
  wallets: SuverseWalletApi[];
  loading: boolean;
  summary?: SummaryPayload;
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="mb-3 h-5 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="mt-4 h-20 w-full" />
          </Card>
        ))}
      </div>
    );
  }
  const orphanByWallet = new Map<string, number>();
  if (summary) {
    for (const o of summary.orphanTokens.items) {
      orphanByWallet.set(o.walletId, (orphanByWallet.get(o.walletId) ?? 0) + 1);
    }
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {wallets.map((w) => (
        <WalletCard
          key={w.id}
          wallet={w}
          orphanCount={orphanByWallet.get(w.id) ?? 0}
        />
      ))}
    </div>
  );
}

function WalletCard({
  wallet,
  orphanCount,
}: {
  wallet: SuverseWalletApi;
  orphanCount: number;
}): React.JSX.Element {
  const balance = useQuery({
    queryKey: ["wallet-balance", wallet.id],
    queryFn: () =>
      fetchJson<BalanceSnapshot>(`/api/wallets/${wallet.id}/balances`),
    refetchInterval: 60_000,
  });
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link
            href={`/dashboard/wallets/${wallet.id}`}
            className="font-display text-base font-medium hover:underline"
          >
            {wallet.label}
          </Link>
          <div className="mt-1 flex items-center gap-2 text-[11px] font-mono text-muted-foreground">
            <span>{truncateMiddle(wallet.address, 8, 6)}</span>
            <CopyButton text={wallet.address} />
            <a
              href={wallet.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              explorer ↗
            </a>
          </div>
        </div>
        <KindBadge kind={wallet.kind} hasPrivateKey={wallet.hasPrivateKey} />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{wallet.purpose}</p>

      {balance.isLoading ? (
        <Skeleton className="mt-4 h-20 w-full" />
      ) : balance.data ? (
        <BalanceTable snapshot={balance.data} />
      ) : (
        <div className="mt-4 text-xs text-red-400">balance read failed</div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {orphanCount > 0 && (
          <Badge color="red">⚠ {orphanCount} orphan token(s)</Badge>
        )}
        {balance.data?.errors && (
          <Badge color="amber">⚠ rpc error</Badge>
        )}
      </div>
    </Card>
  );
}

function BalanceTable({
  snapshot,
}: {
  snapshot: BalanceSnapshot;
}): React.JSX.Element {
  const rows = useMemo(
    () => [snapshot.native, snapshot.usdc, ...snapshot.extras],
    [snapshot],
  );
  return (
    <div className="mt-4 overflow-hidden rounded-md border border-border">
      <table className="w-full text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol + (r.tokenIdentifier ?? "")} className="border-t border-border first:border-t-0">
              <td className="px-3 py-2 font-mono text-muted-foreground">
                {r.symbol}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {humanAmount(r.amountAtomic, r.decimals)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function humanAmount(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic) || atomic === "0") return "0";
  const v = BigInt(atomic);
  const div = 10n ** BigInt(decimals);
  const whole = v / div;
  const frac = v % div;
  if (frac === 0n) return whole.toLocaleString("en-US");
  const f = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  // Cap fractional to 6 digits for readability — operators care
  // about "is there any" more than the last lamport.
  return whole.toLocaleString("en-US") + "." + f.slice(0, 6);
}

function KindBadge({
  kind,
  hasPrivateKey,
}: {
  kind: SuverseWalletApi["kind"];
  hasPrivateKey: boolean;
}): React.JSX.Element {
  const color = {
    merchant: "bg-emerald-500/15 text-emerald-300",
    swap: "bg-sky-500/15 text-sky-300",
    service: "bg-amber-500/15 text-amber-300",
    "test-buyer": "bg-purple-500/15 text-purple-300",
  }[kind];
  return (
    <div className="flex flex-col items-end gap-1">
      <span
        className={`rounded-sm px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${color}`}
      >
        {kind}
      </span>
      {hasPrivateKey && (
        <span className="text-[10px] text-muted-foreground">key on host</span>
      )}
    </div>
  );
}

function Badge({
  color,
  children,
}: {
  color: "red" | "amber" | "emerald";
  children: React.ReactNode;
}): React.JSX.Element {
  const cls = {
    red: "bg-red-500/15 text-red-300",
    amber: "bg-amber-500/15 text-amber-300",
    emerald: "bg-emerald-500/15 text-emerald-300",
  }[color];
  return (
    <span className={`rounded-sm px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  );
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="text-muted-foreground hover:text-foreground"
      aria-label="copy address"
    >
      {done ? "✓" : "⧉"}
    </button>
  );
}

// ----------------------------------------------------- recent tx table ---

function RecentTransactions({
  wallets,
}: {
  wallets: SuverseWalletApi[];
}): React.JSX.Element {
  const [filterWallet, setFilterWallet] = useState<string>("all");
  const [filterKind, setFilterKind] = useState<string>("all");

  // Aggregate activity across all wallets, 7-day window. Each wallet
  // queries independently so a slow chain doesn't block the others.
  // tanstack-query's useQueries handles the dynamic array properly —
  // it accepts an array of query configs and returns one result per
  // entry. Don't call useQuery in a .map() — that breaks hook order
  // when the wallet list grows.
  const results = useQueries({
    queries: wallets.map((w) => ({
      queryKey: ["wallet-activity", w.id],
      queryFn: () =>
        fetchJson<ActivityPayload>(
          `/api/wallets/${w.id}/activity?days=7&limit=50`,
        ),
      refetchInterval: 60_000,
    })),
  });

  const allEvents = useMemo(() => {
    const out: ActivityEvent[] = [];
    for (const r of results) {
      if (r.data) out.push(...r.data.events);
    }
    out.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
    return out;
  }, [results]);

  const filtered = allEvents
    .filter((e) => filterWallet === "all" || e.walletId === filterWallet)
    .filter((e) => filterKind === "all" || e.kind.startsWith(filterKind))
    .slice(0, 50);

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Recent activity · 7 days
        </div>
        <div className="flex gap-2 text-xs">
          <select
            className="rounded-md border border-border bg-card px-2 py-1"
            value={filterWallet}
            onChange={(e) => setFilterWallet(e.target.value)}
          >
            <option value="all">All wallets</option>
            {wallets.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
          <select
            className="rounded-md border border-border bg-card px-2 py-1"
            value={filterKind}
            onChange={(e) => setFilterKind(e.target.value)}
          >
            <option value="all">All types</option>
            <option value="x402_in">x402 inbound</option>
            <option value="x402_out">x402 outbound</option>
            <option value="swap">Swap</option>
            <option value="refund">Refund</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-2 py-1 font-medium">Time</th>
              <th className="px-2 py-1 font-medium">Wallet</th>
              <th className="px-2 py-1 font-medium">Type</th>
              <th className="px-2 py-1 text-right font-medium">USDC</th>
              <th className="px-2 py-1 font-medium">Counterparty</th>
              <th className="px-2 py-1 font-medium">Tx</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td className="px-2 py-4 text-muted-foreground" colSpan={6}>
                  No events in the last 7 days for this filter.
                </td>
              </tr>
            )}
            {filtered.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="px-2 py-1 font-mono text-muted-foreground">
                  {new Date(e.occurredAt).toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="px-2 py-1">
                  <Link
                    className="hover:underline"
                    href={`/dashboard/wallets/${e.walletId}`}
                  >
                    {e.walletId}
                  </Link>
                </td>
                <td className="px-2 py-1">{e.kind}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {formatUsd(e.amountUsdcAtomic)}
                </td>
                <td className="px-2 py-1 font-mono text-muted-foreground">
                  {e.counterparty
                    ? truncateMiddle(e.counterparty, 6, 4)
                    : "—"}
                </td>
                <td className="px-2 py-1 font-mono">
                  {e.txHash ? (
                    <span>{truncateMiddle(e.txHash, 6, 4)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

