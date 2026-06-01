"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProxyConfigRow } from "@/lib/proxy-config-store";
import { cn, truncateMiddle } from "@/lib/utils";

type Range = "24h" | "7d" | "30d";
type LogFilter = "all" | "external" | "self" | "errors";
type Tab = "overview" | "activity" | "config";

interface Stats {
  range: Range;
  totalRequests: number;
  settledCount: number;
  challengeCount: number;
  errorCount: number;
  totalVolumeAtomic: string;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

interface LogRow {
  id: string;
  createdAt: string;
  outcome: string;
  network: string | null;
  amountAtomic: string | null;
  txHash: string | null;
  upstreamStatus: number | null;
  upstreamLatencyMs: number | null;
  errorCode: string | null;
  payer: string | null;
}

function atomicToUsdc(atomic: string | null): string {
  if (!atomic) return "—";
  try {
    const n = BigInt(atomic);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    if (frac === 0n) return `$${whole}`;
    return `$${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
  } catch {
    return "—";
  }
}

/**
 * Endpoint detail page — header card + tabs. The header (URL,
 * Pause/Resume, Delete) is always visible because those controls
 * are the primary thing a seller does on this page; tabs split
 * the secondary content (stats / activity / configuration).
 */
export function ProxyDetailView({
  proxy,
  proxyBase,
}: {
  proxy: ProxyConfigRow;
  proxyBase: string;
}): React.JSX.Element {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>("overview");
  const [range, setRange] = useState<Range>("24h");
  const [logFilter, setLogFilter] = useState<LogFilter>("all");
  const [showJustCreated, setShowJustCreated] = useState(
    searchParams.get("just-created") === "1",
  );
  const [pendingDelete, setPendingDelete] = useState(false);
  const proxyUrl = `${proxyBase}/v1/proxy/${proxy.resourceKeyId}/${proxy.endpointSlug}`;

  useEffect(() => {
    if (showJustCreated && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.has("just-created")) {
        url.searchParams.delete("just-created");
        window.history.replaceState({}, "", url.toString());
      }
    }
  }, [showJustCreated]);

  const statsQ = useQuery<Stats>({
    queryKey: ["proxy-stats", proxy.id, range],
    queryFn: async () => {
      const res = await fetch(`/api/proxies/${proxy.id}/stats?range=${range}`);
      if (!res.ok) throw new Error(`stats ${res.status}`);
      return (await res.json()) as Stats;
    },
    refetchInterval: 30_000,
  });

  const logsQ = useQuery<LogRow[]>({
    queryKey: ["proxy-logs", proxy.id, logFilter],
    queryFn: async () => {
      const res = await fetch(
        `/api/proxies/${proxy.id}/logs?limit=100&filter=${logFilter}`,
      );
      if (!res.ok) throw new Error(`logs ${res.status}`);
      const data = (await res.json()) as { logs: LogRow[] };
      return data.logs;
    },
    refetchInterval: 15_000,
  });

  const toggle = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/proxies/${proxy.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: !proxy.isActive }),
      });
      if (!res.ok) throw new Error(`toggle ${res.status}`);
    },
    onSuccess: () => router.refresh(),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/proxies/${proxy.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`delete ${res.status}`);
    },
    onSuccess: () => router.push("/dashboard/proxies"),
  });

  return (
    <div className="space-y-6">
      {showJustCreated ? (
        <JustCreatedBanner onDismiss={() => setShowJustCreated(false)} />
      ) : null}

      <HeaderCard
        proxy={proxy}
        proxyUrl={proxyUrl}
        togglePending={toggle.isPending}
        onToggle={() => toggle.mutate()}
        removePending={remove.isPending}
        onAskDelete={() => setPendingDelete(true)}
      />

      <Tabs value={tab} onChange={setTab} />

      {tab === "overview" ? (
        <OverviewTab
          proxy={proxy}
          range={range}
          onRangeChange={(r) => {
            setRange(r);
            void qc.invalidateQueries({ queryKey: ["proxy-stats", proxy.id] });
          }}
          statsLoading={statsQ.isLoading}
          stats={statsQ.data ?? null}
        />
      ) : null}

      {tab === "activity" ? (
        <ActivityTab
          logs={logsQ.data ?? []}
          loading={logsQ.isLoading}
          filter={logFilter}
          onFilter={setLogFilter}
        />
      ) : null}

      {tab === "config" ? <ConfigTab proxy={proxy} /> : null}

      <ConfirmDialog
        open={pendingDelete}
        title="Delete this proxy?"
        body={
          <>
            The proxy URL stops responding immediately and the request
            log is cascade-deleted. This can't be undone.
          </>
        }
        confirmLabel="Delete proxy"
        variant="destructive"
        disabled={remove.isPending}
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          setPendingDelete(false);
          remove.mutate();
        }}
      />
    </div>
  );
}

function JustCreatedBanner({
  onDismiss,
}: {
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-emerald-300">
            Proxy live
          </div>
          <p className="mt-2 text-sm text-foreground">
            Share the URL below with buyers. They'll get a 402
            challenge, sign a USDC payment, and your upstream API
            receives the forwarded request. Settles show up on the
            main{" "}
            <Link
              href="/dashboard"
              className="text-emerald-300 underline-offset-4 hover:underline"
            >
              dashboard
            </Link>{" "}
            within ~30 seconds of payment.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function HeaderCard({
  proxy,
  proxyUrl,
  togglePending,
  onToggle,
  removePending,
  onAskDelete,
}: {
  proxy: ProxyConfigRow;
  proxyUrl: string;
  togglePending: boolean;
  onToggle: () => void;
  removePending: boolean;
  onAskDelete: () => void;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Proxy endpoint
          </div>
          <h1 className="mt-1 truncate text-2xl font-semibold">
            {proxy.displayName ?? proxy.endpointSlug}
          </h1>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {proxy.id}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
              proxy.isActive
                ? "bg-emerald-500/15 text-emerald-300"
                : "bg-amber-500/15 text-amber-300",
            )}
          >
            {proxy.isActive ? "Live" : "Paused"}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={togglePending}
            onClick={onToggle}
          >
            {proxy.isActive ? "Pause" : "Resume"}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={removePending}
            onClick={onAskDelete}
          >
            Delete
          </Button>
        </div>
      </div>

      <div className="mt-6">
        <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Public URL · share with your buyers
        </div>
        <div className="mt-2">
          <CodeBlock value={`curl -X ${proxy.originalMethod} ${proxyUrl}`} />
        </div>
      </div>
    </div>
  );
}

function Tabs({
  value,
  onChange,
}: {
  value: Tab;
  onChange: (t: Tab) => void;
}): React.JSX.Element {
  const tabs: ReadonlyArray<{ k: Tab; label: string }> = [
    { k: "overview", label: "Overview" },
    { k: "activity", label: "Recent activity" },
    { k: "config", label: "Configuration" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Endpoint sections"
      className="flex flex-wrap items-center gap-1 border-b border-border"
    >
      {tabs.map((t) => {
        const active = t.k === value;
        return (
          <button
            key={t.k}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.k)}
            className={cn(
              "relative -mb-px px-4 py-2 text-xs font-medium transition-colors",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {active ? (
              <span
                aria-hidden
                className="absolute inset-x-0 -bottom-px h-px bg-amber-400"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function OverviewTab({
  proxy,
  range,
  onRangeChange,
  stats,
  statsLoading,
}: {
  proxy: ProxyConfigRow;
  range: Range;
  onRangeChange: (r: Range) => void;
  stats: Stats | null;
  statsLoading: boolean;
}): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Stats</h2>
          <div
            role="radiogroup"
            className="inline-flex rounded-md border border-border p-0.5"
          >
            {(["24h", "7d", "30d"] as const).map((r) => (
              <button
                key={r}
                type="button"
                role="radio"
                aria-checked={range === r}
                onClick={() => onRangeChange(r)}
                className={cn(
                  "rounded px-2 py-1 text-[11px] font-medium uppercase tracking-wider transition-colors",
                  range === r
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        {statsLoading ? (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : stats ? (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Requests" value={stats.totalRequests.toString()} />
            <StatTile
              label="Settled"
              value={stats.settledCount.toString()}
              accent
            />
            <StatTile label="Challenges" value={stats.challengeCount.toString()} />
            <StatTile label="Errors" value={stats.errorCount.toString()} />
            <StatTile label="Volume" value={atomicToUsdc(stats.totalVolumeAtomic)} />
            <StatTile
              label="p50 upstream"
              value={
                stats.p50LatencyMs === null ? "—" : `${stats.p50LatencyMs} ms`
              }
            />
            <StatTile
              label="p95 upstream"
              value={
                stats.p95LatencyMs === null ? "—" : `${stats.p95LatencyMs} ms`
              }
            />
          </div>
        ) : null}
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Configuration snapshot</h2>
          <Link
            href={`/dashboard/proxies/${proxy.id}/edit`}
            className="text-xs text-amber-400 hover:underline"
          >
            Edit →
          </Link>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Pair
            label="Upstream"
            value={`${proxy.originalMethod} ${proxy.originalUrl}`}
            mono
          />
          <Pair label="Price per call" value={`$${formatUsdc(proxy.priceAtomic)}`} />
          <Pair
            label="Networks"
            value={`${proxy.acceptedNetworks.length} accepted`}
          />
          <Pair
            label="Forwarded headers"
            value={
              proxy.forwardHeaderCount > 0
                ? `${proxy.forwardHeaderCount} (encrypted)`
                : "none"
            }
          />
        </dl>
      </div>
    </div>
  );
}

function ActivityTab({
  logs,
  loading,
  filter,
  onFilter,
}: {
  logs: LogRow[];
  loading: boolean;
  filter: LogFilter;
  onFilter: (f: LogFilter) => void;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Recent requests</h2>
          <span className="text-[11px] text-muted-foreground">
            auto-refreshes every 15 s
          </span>
        </div>
        <LogFilterPills value={filter} onChange={onFilter} />
      </header>
      <div className="overflow-x-auto">
        {loading ? (
          <div className="space-y-2 px-6 py-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            No requests match that filter.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                <th className="px-6 py-3">When</th>
                <th className="px-6 py-3">Outcome</th>
                <th className="px-6 py-3">Network</th>
                <th className="px-6 py-3 text-right">Amount</th>
                <th className="px-6 py-3 hidden md:table-cell">Payer</th>
                <th className="px-6 py-3 text-right">Upstream</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border/50 transition-colors hover:bg-secondary/40"
                >
                  <td className="px-6 py-3 text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td className="px-6 py-3">
                    <OutcomeBadge outcome={r.outcome} />
                    {r.errorCode ? (
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                        {r.errorCode}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-6 py-3 font-mono text-[11px] text-muted-foreground">
                    {r.network ?? "—"}
                  </td>
                  <td className="px-6 py-3 text-right font-mono text-xs">
                    {atomicToUsdc(r.amountAtomic)}
                  </td>
                  <td className="px-6 py-3 hidden md:table-cell font-mono text-[11px] text-muted-foreground">
                    {r.payer ? (
                      <span title={r.payer}>{truncateMiddle(r.payer, 6, 4)}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-6 py-3 text-right font-mono text-xs">
                    {r.upstreamStatus === null
                      ? "—"
                      : `${r.upstreamStatus} · ${r.upstreamLatencyMs ?? "?"} ms`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function LogFilterPills({
  value,
  onChange,
}: {
  value: LogFilter;
  onChange: (v: LogFilter) => void;
}): React.JSX.Element {
  const options: Array<{ k: LogFilter; label: string }> = [
    { k: "all", label: "All" },
    { k: "external", label: "External" },
    { k: "self", label: "Self / test" },
    { k: "errors", label: "Errors" },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <button
          key={opt.k}
          type="button"
          onClick={() => onChange(opt.k)}
          className={cn(
            "rounded px-2.5 py-1 text-[11px] font-medium transition-colors",
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

function ConfigTab({ proxy }: { proxy: ProxyConfigRow }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Configuration</h2>
        <Link
          href={`/dashboard/proxies/${proxy.id}/edit`}
          className="text-xs text-amber-400 hover:underline"
        >
          Edit →
        </Link>
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        <Pair
          label="Upstream URL"
          value={`${proxy.originalMethod} ${proxy.originalUrl}`}
          mono
        />
        <Pair label="Price per call" value={`$${formatUsdc(proxy.priceAtomic)}`} />
        <Pair label="Networks" value={proxy.acceptedNetworks.join(", ")} mono />
        <Pair
          label="Forwarded headers"
          value={
            proxy.forwardHeaderCount > 0
              ? `${proxy.forwardHeaderCount} (encrypted)`
              : "none"
          }
        />
        {proxy.payToEvm ? <Pair label="EVM payTo" value={proxy.payToEvm} mono /> : null}
        {proxy.payToSolana ? (
          <Pair label="Solana payTo" value={proxy.payToSolana} mono />
        ) : null}
        {proxy.payToCosmos ? (
          <Pair label="Cosmos payTo" value={proxy.payToCosmos} mono />
        ) : null}
        {proxy.payToTron ? <Pair label="TRON payTo" value={proxy.payToTron} mono /> : null}
      </dl>
    </div>
  );
}

function Pair({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 break-all",
          mono ? "font-mono text-xs" : "text-sm",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function StatTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-display text-2xl font-medium tabular-nums",
          accent && "text-amber-400",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }): React.JSX.Element {
  const tone: Record<string, string> = {
    settled: "bg-emerald-500/15 text-emerald-300",
    challenge: "bg-slate-500/15 text-slate-300",
    settle_failed: "bg-destructive/15 text-destructive",
    upstream_error: "bg-destructive/15 text-destructive",
    rate_limited: "bg-amber-500/15 text-amber-300",
    invalid_config: "bg-amber-500/15 text-amber-300",
    paused: "bg-amber-500/15 text-amber-300",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        tone[outcome] ?? "bg-muted text-muted-foreground",
      )}
    >
      {outcome}
    </span>
  );
}

function formatUsdc(atomic: string): string {
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
