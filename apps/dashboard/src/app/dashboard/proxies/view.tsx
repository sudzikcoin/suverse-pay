"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cn,
  formatCount,
  formatRelativeTime,
  formatUsd,
} from "@/lib/utils";

interface ProxyRow {
  id: string;
  resourceKeyId: string;
  endpointSlug: string;
  displayName: string | null;
  priceAtomic: string;
  acceptedNetworks: string[];
  isActive: boolean;
  type: "internal" | "x402-wrap" | "http-proxy";
  totalRequests: number;
  settledCount: number;
  errorCount: number;
  externalRevenueAtomic: string;
  selfRevenueAtomic: string;
  externalSettledCount: number;
  lastSettleAt: string | null;
  createdAt: string;
}

type Period = "24h" | "7d" | "30d";
type SortKey = "name" | "revenue" | "requests" | "created";
type SortDir = "asc" | "desc";
type TypeFilter = "all" | "internal" | "x402-wrap" | "http-proxy";

/**
 * Group inference. Lifted into a top-level table so the active set
 * stays in sync with what the seed scripts actually emit — extend
 * here when new endpoint families come online.
 *
 * The matcher walks each group's prefix list against the slug; the
 * first hit wins, which is why prefixes are listed longest-first
 * within a family (`solana-` before `sol-`).
 */
const GROUPS: ReadonlyArray<{
  value: string;
  label: string;
  match: (slug: string) => boolean;
}> = [
  {
    value: "crypto",
    label: "Crypto Prices",
    match: (s) => /coin|price|market|defillama/i.test(s),
  },
  {
    value: "defi",
    label: "DeFi",
    match: (s) => /defi|swap|lending|aave|uniswap|liquidity/i.test(s),
  },
  {
    value: "solana",
    label: "Solana",
    match: (s) => /^suverse-solana|^solana-|^sol-|helius/i.test(s),
  },
  {
    value: "base",
    label: "Base",
    match: (s) => /^suverse-base|^base-|blockscout-base|goplus.*base/i.test(s),
  },
  {
    value: "bitcoin",
    label: "Bitcoin",
    match: (s) => /^suverse-bitcoin|^bitcoin-|^btc-|mempool/i.test(s),
  },
  {
    value: "cosmos",
    label: "Cosmos",
    match: (s) => /^suverse-cosmos|^cosmos-|noble-|atom-/i.test(s),
  },
  {
    value: "nft",
    label: "NFT",
    match: (s) => /nft|opensea|magic-eden/i.test(s),
  },
  {
    value: "stocks",
    label: "Stocks",
    match: (s) => /stock|equity|sec|edgar/i.test(s),
  },
];

function inferGroup(slug: string): string {
  for (const g of GROUPS) {
    if (g.match(slug)) return g.value;
  }
  return "other";
}

async function fetchProxies(period: Period): Promise<ProxyRow[]> {
  const res = await fetch(`/api/proxies-with-stats?period=${period}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`proxies ${res.status}`);
  const j = (await res.json()) as { proxies: ProxyRow[] };
  return j.proxies;
}

/**
 * Redesigned endpoints list. Filters + per-row stats live entirely
 * client-side after one server round-trip — the row count per user
 * is small enough that bouncing to /api/proxies-with-stats once and
 * sorting in JS beats a refetch per click.
 */
export function ProxiesListView({
  proxyBase,
}: {
  proxyBase: string;
}): React.JSX.Element {
  const [period, setPeriod] = useState<Period>("24h");
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<string>("all");
  const [typeF, setTypeF] = useState<TypeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("revenue");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isLoading, isError } = useQuery({
    queryKey: ["proxies-with-stats", period],
    queryFn: () => fetchProxies(period),
    refetchInterval: 30_000,
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    let rows = data.filter((p) => {
      if (typeF !== "all" && p.type !== typeF) return false;
      if (group !== "all" && inferGroup(p.endpointSlug) !== group) return false;
      if (q.length > 0) {
        const hay = `${p.endpointSlug} ${p.displayName ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    rows = rows.slice().sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "name":
          cmp = (a.displayName ?? a.endpointSlug).localeCompare(
            b.displayName ?? b.endpointSlug,
          );
          break;
        case "revenue":
          cmp = compareBigInt(a.externalRevenueAtomic, b.externalRevenueAtomic);
          break;
        case "requests":
          cmp = a.totalRequests - b.totalRequests;
          break;
        case "created":
          cmp =
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
          break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [data, search, group, typeF, sortKey, sortDir]);

  function toggleSort(k: SortKey): void {
    if (k === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(k);
      setSortDir("desc");
    }
  }

  return (
    <div className="space-y-6">
      <Filters
        search={search}
        onSearch={setSearch}
        group={group}
        onGroup={setGroup}
        typeF={typeF}
        onType={setTypeF}
        period={period}
        onPeriod={setPeriod}
      />

      {isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : isError ? (
        <div className="rounded-lg border border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
          Couldn’t load endpoints — try refreshing.
        </div>
      ) : !data || data.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-card/40">
                <tr className="text-left text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  <Th
                    sortable
                    active={sortKey === "name"}
                    dir={sortDir}
                    onClick={() => toggleSort("name")}
                  >
                    Endpoint
                  </Th>
                  <Th className="hidden sm:table-cell">Type</Th>
                  <Th className="text-right hidden md:table-cell">Price</Th>
                  <Th
                    className="text-right"
                    sortable
                    active={sortKey === "requests"}
                    dir={sortDir}
                    onClick={() => toggleSort("requests")}
                  >
                    Requests
                  </Th>
                  <Th className="text-right hidden lg:table-cell">Settled</Th>
                  <Th className="text-right hidden xl:table-cell">Errors</Th>
                  <Th
                    className="text-right"
                    sortable
                    active={sortKey === "revenue"}
                    dir={sortDir}
                    onClick={() => toggleSort("revenue")}
                  >
                    Revenue
                  </Th>
                  <Th className="hidden md:table-cell">Last</Th>
                  <Th className="text-right">Status</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => (
                  <Row key={p.id} row={p} proxyBase={proxyBase} />
                ))}
                {filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={10}
                      className="px-6 py-10 text-center text-sm text-muted-foreground"
                    >
                      No endpoints match those filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Filters({
  search,
  onSearch,
  group,
  onGroup,
  typeF,
  onType,
  period,
  onPeriod,
}: {
  search: string;
  onSearch: (s: string) => void;
  group: string;
  onGroup: (g: string) => void;
  typeF: TypeFilter;
  onType: (t: TypeFilter) => void;
  period: Period;
  onPeriod: (p: Period) => void;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr]">
        <Input
          type="search"
          placeholder="Search name or slug…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
        <Select
          label="Group"
          value={group}
          onChange={onGroup}
          options={[
            { value: "all", label: "All groups" },
            ...GROUPS.map((g) => ({ value: g.value, label: g.label })),
            { value: "other", label: "Other" },
          ]}
        />
        <Select
          label="Type"
          value={typeF}
          onChange={(v) => onType(v as TypeFilter)}
          options={[
            { value: "all", label: "All types" },
            { value: "internal", label: "Internal" },
            { value: "x402-wrap", label: "x402 wrap" },
            { value: "http-proxy", label: "HTTP proxy" },
          ]}
        />
        <Select
          label="Period"
          value={period}
          onChange={(v) => onPeriod(v as Period)}
          options={[
            { value: "24h", label: "24 hours" },
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
          ]}
        />
      </div>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-amber-400/40"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Th({
  children,
  className,
  sortable,
  active,
  dir,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  sortable?: boolean;
  active?: boolean;
  dir?: SortDir;
  onClick?: () => void;
}): React.JSX.Element {
  const base = cn("px-6 py-3", className);
  if (!sortable) return <th className={base}>{children}</th>;
  return (
    <th className={base}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground transition-colors",
          active && "text-foreground",
        )}
      >
        <span>{children}</span>
        {active ? (
          <span aria-hidden>{dir === "asc" ? "↑" : "↓"}</span>
        ) : (
          <span className="opacity-30" aria-hidden>
            ↕
          </span>
        )}
      </button>
    </th>
  );
}

function Row({
  row,
  proxyBase,
}: {
  row: ProxyRow;
  proxyBase: string;
}): React.JSX.Element {
  const proxyUrl = `${proxyBase}/v1/proxy/${row.resourceKeyId}/${row.endpointSlug}`;
  const settlePct =
    row.totalRequests === 0
      ? 0
      : Math.round((row.settledCount / row.totalRequests) * 100);
  const errorPct =
    row.totalRequests === 0
      ? 0
      : Math.round((row.errorCount / row.totalRequests) * 100);
  return (
    <tr className="border-b border-border last:border-0 hover:bg-secondary/30">
      <td className="px-6 py-3">
        <div className="flex items-start gap-2">
          <ActivityDot row={row} />
          <div className="min-w-0">
            <Link
              href={`/dashboard/proxies/${row.id}`}
              className="font-medium text-foreground hover:text-amber-200"
            >
              {row.displayName ?? row.endpointSlug}
            </Link>
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {row.endpointSlug}
            </div>
            <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
              {proxyUrl}
            </div>
          </div>
        </div>
      </td>
      <td className="px-6 py-3 hidden sm:table-cell">
        <TypeBadge type={row.type} />
      </td>
      <td className="px-6 py-3 text-right font-mono text-xs text-muted-foreground hidden md:table-cell">
        {formatUsd(row.priceAtomic, 6)}
      </td>
      <td className="px-6 py-3 text-right font-mono">
        {formatCount(row.totalRequests)}
      </td>
      <td className="px-6 py-3 text-right hidden lg:table-cell">
        <span className="font-mono">{formatCount(row.settledCount)}</span>
        {row.totalRequests > 0 ? (
          <span className="ml-1 text-[10px] text-muted-foreground">
            {settlePct}%
          </span>
        ) : null}
      </td>
      <td className="px-6 py-3 text-right hidden xl:table-cell">
        <span
          className={cn(
            "font-mono",
            errorPct > 10 && "text-destructive",
          )}
        >
          {formatCount(row.errorCount)}
        </span>
        {row.totalRequests > 0 ? (
          <span
            className={cn(
              "ml-1 text-[10px] text-muted-foreground",
              errorPct > 10 && "text-destructive/80",
            )}
          >
            {errorPct}%
          </span>
        ) : null}
      </td>
      <td className="px-6 py-3 text-right">
        <span className="font-mono text-amber-300">
          {formatUsd(row.externalRevenueAtomic, 6)}
        </span>
        {row.selfRevenueAtomic !== "0" ? (
          <div
            className="font-mono text-[10px] text-muted-foreground"
            title="Self / smoke-test settles in this period"
          >
            self {formatUsd(row.selfRevenueAtomic, 6)}
          </div>
        ) : null}
      </td>
      <td className="px-6 py-3 hidden md:table-cell text-muted-foreground whitespace-nowrap">
        {row.lastSettleAt ? formatRelativeTime(new Date(row.lastSettleAt)) : "—"}
      </td>
      <td className="px-6 py-3 text-right">
        <StatusPill active={row.isActive} />
      </td>
      <td className="px-6 py-3 text-right">
        <Link
          href={`/dashboard/proxies/${row.id}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Manage →
        </Link>
      </td>
    </tr>
  );
}

function ActivityDot({ row }: { row: ProxyRow }): React.JSX.Element {
  // Priority order — error rate dominates, then live external, then
  // self-only / inactive. Keeps the visual a single glanceable colour
  // even if a row qualifies for multiple signals.
  const errorPct =
    row.totalRequests === 0
      ? 0
      : (row.errorCount / row.totalRequests) * 100;
  let tone: string;
  let title: string;
  if (errorPct > 20) {
    tone = "bg-destructive";
    title = `error rate ${errorPct.toFixed(0)}%`;
  } else if (row.externalSettledCount > 0) {
    tone = "bg-emerald-400";
    title = `${row.externalSettledCount} external settle${row.externalSettledCount === 1 ? "" : "s"} in period`;
  } else if (row.settledCount > 0) {
    tone = "bg-amber-400";
    title = "self / test settles only in period";
  } else {
    tone = "bg-muted-foreground/40";
    title = "no activity in period";
  }
  return (
    <span
      className={cn("mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full", tone)}
      title={title}
      aria-label={title}
    />
  );
}

function TypeBadge({
  type,
}: {
  type: ProxyRow["type"];
}): React.JSX.Element {
  const map = {
    internal: "bg-emerald-500/15 text-emerald-300",
    "x402-wrap": "bg-blue-500/15 text-blue-300",
    "http-proxy": "bg-secondary text-muted-foreground",
  } as const;
  const label = {
    internal: "internal",
    "x402-wrap": "x402 wrap",
    "http-proxy": "proxy",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        map[type],
      )}
    >
      {label[type]}
    </span>
  );
}

function StatusPill({ active }: { active: boolean }): React.JSX.Element {
  return (
    <span
      className={
        "inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider " +
        (active
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-amber-500/15 text-amber-300")
      }
    >
      {active ? "Live" : "Paused"}
    </span>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/30 p-12 text-center">
      <h3 className="font-display text-lg font-medium">No proxies yet</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Create a proxy to monetise any existing HTTPS endpoint — point
        us at the upstream, pick a price, and share the generated URL
        with paying clients.
      </p>
      <Button asChild variant="accent" className="mt-6">
        <Link href="/dashboard/proxies/new">Create your first proxy</Link>
      </Button>
    </div>
  );
}

function compareBigInt(a: string, b: string): number {
  try {
    const ba = BigInt(a || "0");
    const bb = BigInt(b || "0");
    if (ba < bb) return -1;
    if (ba > bb) return 1;
    return 0;
  } catch {
    return 0;
  }
}
