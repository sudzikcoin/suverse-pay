"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsd, truncateMiddle } from "@/lib/utils";
import type { SuverseWallet } from "@/lib/suverse-wallets";

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

type Tab = "overview" | "transactions" | "chart" | "swaps";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return (await res.json()) as T;
}

export function WalletDetailView({
  wallet,
}: {
  wallet: SuverseWallet;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("overview");
  const tabs: Tab[] = wallet.kind === "swap"
    ? ["overview", "transactions", "chart", "swaps"]
    : ["overview", "transactions", "chart"];

  const balance = useQuery({
    queryKey: ["wallet-balance-detail", wallet.id],
    queryFn: () =>
      fetchJson<BalanceSnapshot>(`/api/wallets/${wallet.id}/balances`),
    refetchInterval: 60_000,
  });
  // The Transactions tab + chart both want 30 days × 200 events;
  // keep it as a single query and slice client-side.
  const activity30d = useQuery({
    queryKey: ["wallet-activity-30d", wallet.id],
    queryFn: () =>
      fetchJson<ActivityPayload>(
        `/api/wallets/${wallet.id}/activity?days=30&limit=200`,
      ),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6">
      <WalletHeader wallet={wallet} />

      <div className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-xs font-medium uppercase tracking-wider transition-colors ${
              t === tab
                ? "border-b-2 border-emerald-400 text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t === "overview" ? "Overview"
              : t === "transactions" ? "Transactions"
              : t === "chart" ? "Activity chart"
              : "Swap details"}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab
          wallet={wallet}
          balance={balance.data}
          loading={balance.isLoading}
          activity={activity30d.data}
        />
      )}
      {tab === "transactions" && (
        <TransactionsTab
          activity={activity30d.data}
          loading={activity30d.isLoading}
        />
      )}
      {tab === "chart" && (
        <ChartTab
          activity={activity30d.data}
          loading={activity30d.isLoading}
        />
      )}
      {tab === "swaps" && wallet.kind === "swap" && (
        <SwapsTab activity={activity30d.data} loading={activity30d.isLoading} />
      )}
    </div>
  );
}

// ----------------------------------------------------- header ---

function WalletHeader({ wallet }: { wallet: SuverseWallet }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl font-medium">{wallet.label}</h1>
        <KindPill kind={wallet.kind} hasPrivateKey={wallet.hasPrivateKey} />
      </div>
      <p className="text-sm text-muted-foreground">{wallet.purpose}</p>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="font-mono text-muted-foreground">
          {wallet.address}
        </span>
        <a
          href={wallet.explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="text-emerald-400 hover:underline"
        >
          explorer ↗
        </a>
        <span className="rounded-sm bg-card px-2 py-0.5 font-mono text-muted-foreground">
          {wallet.network}
        </span>
      </div>
    </div>
  );
}

function KindPill({
  kind,
  hasPrivateKey,
}: {
  kind: SuverseWallet["kind"];
  hasPrivateKey: boolean;
}): React.JSX.Element {
  const color = {
    merchant: "bg-emerald-500/15 text-emerald-300",
    swap: "bg-sky-500/15 text-sky-300",
    service: "bg-amber-500/15 text-amber-300",
    "test-buyer": "bg-purple-500/15 text-purple-300",
  }[kind];
  return (
    <div className="flex items-center gap-2">
      <span
        className={`rounded-sm px-2 py-0.5 text-xs font-medium uppercase tracking-wider ${color}`}
      >
        {kind}
      </span>
      <span className="text-xs text-muted-foreground">
        {hasPrivateKey ? "key on host" : "watch-only"}
      </span>
    </div>
  );
}

// ----------------------------------------------------- overview ---

function OverviewTab({
  wallet,
  balance,
  loading,
  activity,
}: {
  wallet: SuverseWallet;
  balance?: BalanceSnapshot;
  loading: boolean;
  activity?: ActivityPayload;
}): React.JSX.Element {
  const counts = useMemo(() => {
    const events = activity?.events ?? [];
    const last7d = events.filter(
      (e) => new Date(e.occurredAt).getTime() > Date.now() - 7 * 86_400_000,
    );
    let inCount = 0,
      outCount = 0,
      inSum = 0n,
      outSum = 0n;
    for (const e of last7d) {
      if (e.kind === "x402_in" || e.kind === "swap_completed") {
        inCount += 1;
        if (/^\d+$/.test(e.amountUsdcAtomic)) inSum += BigInt(e.amountUsdcAtomic);
      } else if (e.kind === "x402_out" || e.kind.startsWith("refund")) {
        outCount += 1;
        if (/^\d+$/.test(e.amountUsdcAtomic)) outSum += BigInt(e.amountUsdcAtomic);
      }
    }
    return {
      inCount,
      outCount,
      inSum: inSum.toString(),
      outSum: outSum.toString(),
      net: (inSum - outSum).toString(),
    };
  }, [activity]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card className="p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Balances
        </div>
        {balance ? (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-xs">
              <tbody>
                {[balance.native, balance.usdc, ...balance.extras].map((b) => (
                  <tr
                    key={b.symbol + (b.tokenIdentifier ?? "")}
                    className="border-t border-border first:border-t-0"
                  >
                    <td className="px-3 py-2 font-mono text-muted-foreground">
                      {b.symbol}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {humanAmount(b.amountAtomic, b.decimals)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-xs text-red-400">balance read failed</div>
        )}
        {balance?.errors && (
          <div className="mt-3 text-[11px] text-amber-400">
            ⚠ RPC errors:{" "}
            {Object.entries(balance.errors)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")}
          </div>
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          7-day activity
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Stat label="In" value={`${counts.inCount} events`} sub={formatUsd(counts.inSum)} positive />
          <Stat label="Out" value={`${counts.outCount} events`} sub={formatUsd(counts.outSum)} negative />
          <Stat
            label="Net"
            value={(BigInt(counts.net) >= 0n ? "+" : "") + formatUsd(counts.net.replace(/^-/, ""))}
            sub="USDC delta"
          />
        </div>
        {wallet.kind === "swap" && wallet.operatingCapitalAtomic && balance && (
          <SwapCapitalBreakdown
            usdcAtomic={balance.usdc.amountAtomic}
            opCapital={wallet.operatingCapitalAtomic}
          />
        )}
      </Card>
    </div>
  );
}

function SwapCapitalBreakdown({
  usdcAtomic,
  opCapital,
}: {
  usdcAtomic: string;
  opCapital: string;
}): React.JSX.Element {
  const usdc = BigInt(/^\d+$/.test(usdcAtomic) ? usdcAtomic : "0");
  const op = BigInt(/^\d+$/.test(opCapital) ? opCapital : "0");
  const fees = usdc > op ? usdc - op : 0n;
  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Swap wallet breakdown
      </div>
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-muted-foreground">Operating capital</div>
          <div className="font-mono tabular-nums">{formatUsd(op.toString())}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Earned fees</div>
          <div className="font-mono tabular-nums text-emerald-400">
            {formatUsd(fees.toString())}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  positive,
  negative,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean;
  negative?: boolean;
}): React.JSX.Element {
  const colorClass = positive
    ? "text-emerald-400"
    : negative
      ? "text-red-400"
      : "";
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-base font-medium ${colorClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

// ----------------------------------------------------- transactions ---

function TransactionsTab({
  activity,
  loading,
}: {
  activity?: ActivityPayload;
  loading: boolean;
}): React.JSX.Element {
  const [kindFilter, setKindFilter] = useState<string>("all");
  if (loading) {
    return <Skeleton className="h-96 w-full" />;
  }
  const events = (activity?.events ?? []).filter(
    (e) => kindFilter === "all" || e.kind.startsWith(kindFilter),
  );
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Transactions · 30 days · {events.length} events
        </div>
        <select
          className="rounded-md border border-border bg-card px-2 py-1 text-xs"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
        >
          <option value="all">All types</option>
          <option value="x402_in">x402 inbound</option>
          <option value="x402_out">x402 outbound</option>
          <option value="swap">Swap</option>
          <option value="refund">Refund</option>
        </select>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="px-2 py-1 font-medium">Time</th>
              <th className="px-2 py-1 font-medium">Type</th>
              <th className="px-2 py-1 text-right font-medium">USDC</th>
              <th className="px-2 py-1 font-medium">Counterparty</th>
              <th className="px-2 py-1 font-medium">Tx</th>
              <th className="px-2 py-1 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td className="px-2 py-4 text-muted-foreground" colSpan={6}>
                  No events.
                </td>
              </tr>
            )}
            {events.map((e) => (
              <tr key={e.id} className="border-t border-border align-top">
                <td className="px-2 py-1 font-mono text-muted-foreground whitespace-nowrap">
                  {new Date(e.occurredAt).toISOString().replace("T", " ").slice(0, 19)}
                </td>
                <td className="px-2 py-1">{e.kind}</td>
                <td className="px-2 py-1 text-right font-mono tabular-nums">
                  {formatUsd(e.amountUsdcAtomic)}
                </td>
                <td className="px-2 py-1 font-mono text-muted-foreground">
                  {e.counterparty ? truncateMiddle(e.counterparty, 6, 4) : "—"}
                </td>
                <td className="px-2 py-1 font-mono">
                  {e.txHash ? truncateMiddle(e.txHash, 6, 4) : "—"}
                </td>
                <td className="px-2 py-1 text-muted-foreground">
                  {e.detail ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ----------------------------------------------------- chart ---

function ChartTab({
  activity,
  loading,
}: {
  activity?: ActivityPayload;
  loading: boolean;
}): React.JSX.Element {
  const buckets = useMemo(() => {
    const map = new Map<string, { in: bigint; out: bigint }>();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      map.set(d, { in: 0n, out: 0n });
    }
    for (const e of activity?.events ?? []) {
      const d = e.occurredAt.slice(0, 10);
      if (!map.has(d)) continue;
      const v = /^\d+$/.test(e.amountUsdcAtomic) ? BigInt(e.amountUsdcAtomic) : 0n;
      if (e.kind === "x402_in" || e.kind === "swap_completed") {
        map.get(d)!.in += v;
      } else if (e.kind === "x402_out" || e.kind.startsWith("refund")) {
        map.get(d)!.out += v;
      }
    }
    return Array.from(map.entries()).map(([date, v]) => ({ date, ...v }));
  }, [activity]);

  if (loading) return <Skeleton className="h-64 w-full" />;

  const max = buckets.reduce((m, b) => {
    const v = b.in + b.out;
    return v > m ? v : m;
  }, 0n);

  return (
    <Card className="p-5">
      <div className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        Daily volume · 30 days (in vs out, USDC)
      </div>
      <div className="flex h-40 items-end gap-[3px]">
        {buckets.map((b) => {
          const total = b.in + b.out;
          const totalPct = max > 0n ? Number((total * 1000n) / max) / 10 : 0;
          const inPct = total > 0n ? Number((b.in * 100n) / total) : 0;
          return (
            <div
              key={b.date}
              className="flex flex-1 flex-col-reverse overflow-hidden rounded-sm"
              style={{ height: `${Math.max(totalPct, 1)}%` }}
              title={`${b.date} — in ${formatUsd(b.in.toString())} · out ${formatUsd(b.out.toString())}`}
            >
              <div className="bg-emerald-500/70" style={{ height: `${inPct}%` }} />
              <div className="bg-red-500/70" style={{ height: `${100 - inPct}%` }} />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground">
        <span>{buckets[0]?.date}</span>
        <span>{buckets[buckets.length - 1]?.date}</span>
      </div>
      <div className="mt-3 flex gap-4 text-[11px]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-emerald-500/70" />
          inbound
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-red-500/70" />
          outbound
        </span>
      </div>
    </Card>
  );
}

// ----------------------------------------------------- swap details ---

function SwapsTab({
  activity,
  loading,
}: {
  activity?: ActivityPayload;
  loading: boolean;
}): React.JSX.Element {
  if (loading) return <Skeleton className="h-96 w-full" />;
  const swapEvents = (activity?.events ?? []).filter((e) =>
    e.kind.startsWith("swap_") || e.kind.startsWith("refund"),
  );

  let completed = 0,
    failed = 0,
    pendingRefund = 0;
  let feeSum = 0n;
  for (const e of swapEvents) {
    if (e.kind === "swap_completed") {
      completed += 1;
      // Fee = 1% of input amount (matches FEE_BPS in swap.ts /
      // swap-base.ts). Rough — for exact use the DB row.
      if (/^\d+$/.test(e.amountUsdcAtomic)) {
        feeSum += BigInt(e.amountUsdcAtomic) / 100n;
      }
    } else if (e.kind === "swap_failed") failed += 1;
    else if (e.kind === "refund_pending") pendingRefund += 1;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Completed</div>
          <div className="mt-1 text-xl font-medium text-emerald-400">{completed}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Failed</div>
          <div className="mt-1 text-xl font-medium text-red-400">{failed}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Refunds pending</div>
          <div className="mt-1 text-xl font-medium text-amber-400">{pendingRefund}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Fees earned (30d)</div>
          <div className="mt-1 text-xl font-medium">
            {formatUsd(feeSum.toString())}
          </div>
        </Card>
      </div>
      <Card className="p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Swap + refund events · 30 days · {swapEvents.length} rows
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-2 py-1 font-medium">Time</th>
                <th className="px-2 py-1 font-medium">Kind</th>
                <th className="px-2 py-1 text-right font-medium">Input USDC</th>
                <th className="px-2 py-1 font-medium">Output token</th>
                <th className="px-2 py-1 font-medium">Tx / Detail</th>
              </tr>
            </thead>
            <tbody>
              {swapEvents.length === 0 && (
                <tr>
                  <td className="px-2 py-4 text-muted-foreground" colSpan={5}>
                    No swap or refund events in the last 30 days.
                  </td>
                </tr>
              )}
              {swapEvents.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-2 py-1 font-mono text-muted-foreground whitespace-nowrap">
                    {new Date(e.occurredAt).toISOString().replace("T", " ").slice(0, 19)}
                  </td>
                  <td className="px-2 py-1">{e.kind}</td>
                  <td className="px-2 py-1 text-right font-mono tabular-nums">
                    {formatUsd(e.amountUsdcAtomic)}
                  </td>
                  <td className="px-2 py-1 font-mono text-muted-foreground">
                    {e.counterparty ? truncateMiddle(e.counterparty, 6, 4) : "—"}
                  </td>
                  <td className="px-2 py-1 font-mono">
                    {e.txHash
                      ? truncateMiddle(e.txHash, 6, 4)
                      : (e.detail ?? "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ----------------------------------------------------- helpers ---

function humanAmount(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic) || atomic === "0") return "0";
  const v = BigInt(atomic);
  const div = 10n ** BigInt(decimals);
  const whole = v / div;
  const frac = v % div;
  if (frac === 0n) return whole.toLocaleString("en-US");
  const f = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return whole.toLocaleString("en-US") + "." + f.slice(0, 6);
}
