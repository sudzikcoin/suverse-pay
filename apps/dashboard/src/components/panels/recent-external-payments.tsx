"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TransactionDetailModal,
  type RecentPaymentForModal,
} from "@/components/panels/transaction-detail-modal";
import {
  explorerUrl,
  formatRelativeTime,
  formatUsd,
  networkLabel,
  truncateMiddle,
} from "@/lib/utils";

interface RecentPayment {
  id: string;
  createdAt: string;
  network: string;
  amountAtomic: string;
  payer: string | null;
  txHash: string | null;
  endpointSlug: string | null;
  displayName: string | null;
  proxyId: string | null;
  status: string;
}

async function fetchRecent(): Promise<RecentPayment[]> {
  const res = await fetch(
    "/api/dashboard/recent-payments?limit=10&external_only=true",
    { cache: "no-store" },
  );
  if (!res.ok) throw new Error(`recent-payments ${res.status}`);
  const j = (await res.json()) as { payments: RecentPayment[] };
  return j.payments;
}

/**
 * Last 10 external (real-buyer) payments. The exclude list comes
 * from the `internal_wallets` DB table (mig 034) so adding a new QA
 * bot is a single INSERT, not a code change.
 *
 * Auto-refreshes every 30 s. New rows that arrive while the panel is
 * open get a brief amber highlight, and if the tab is in the
 * background the document title prefixes "(N) " so the operator
 * notices at a glance.
 */
export function RecentExternalPayments(): React.JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard-recent-external"],
    queryFn: fetchRecent,
    refetchInterval: 30_000,
    // Re-fetch the moment the tab comes back to the foreground so we
    // don't show stale data after a long idle window.
    refetchOnWindowFocus: true,
  });

  const [selected, setSelected] = useState<RecentPaymentForModal | null>(null);

  // ───── new-row tracking (highlight + tab-title flash) ─────
  const seenIdsRef = useRef<Set<string>>(new Set());
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  const newSinceHiddenRef = useRef<number>(0);

  useEffect(() => {
    if (!data) return;
    const seen = seenIdsRef.current;

    // First render: seed the seen set without highlighting; we don't
    // want to amber-flash every row on initial load.
    if (seen.size === 0) {
      for (const p of data) seen.add(p.id);
      return;
    }

    const fresh = data.filter((p) => !seen.has(p.id));
    if (fresh.length === 0) return;

    for (const p of fresh) seen.add(p.id);

    setHighlightIds((prev) => {
      const next = new Set(prev);
      for (const p of fresh) next.add(p.id);
      return next;
    });

    // Drop the amber highlight after ~3 s — matches the UX brief.
    const ids = fresh.map((p) => p.id);
    const t = setTimeout(() => {
      setHighlightIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, 3000);

    // Background-tab counter.
    if (typeof document !== "undefined" && document.hidden) {
      newSinceHiddenRef.current += fresh.length;
      updateTitlePrefix(newSinceHiddenRef.current);
    }

    return () => clearTimeout(t);
  }, [data]);

  // Reset the title counter the moment the tab is foregrounded again.
  useEffect(() => {
    function onVis(): void {
      if (!document.hidden) {
        newSinceHiddenRef.current = 0;
        updateTitlePrefix(0);
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      // On unmount, clear any lingering "(N) " prefix.
      updateTitlePrefix(0);
    };
  }, []);

  return (
    <div className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Recent external activity
        </h3>
        <span className="text-[11px] text-muted-foreground">
          auto-refreshes every 30 s
        </span>
      </header>
      <div className="overflow-x-auto">
        {isLoading ? (
          <div className="space-y-2 px-6 py-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="px-6 py-8 text-sm text-muted-foreground">
            Couldn’t load recent payments — try refreshing.
          </div>
        ) : !data || data.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No external payments yet — share an endpoint URL with a
            buyer to see settles land here.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                <th className="px-6 py-3">When</th>
                <th className="px-6 py-3">Endpoint</th>
                <th className="px-6 py-3 hidden sm:table-cell">Network</th>
                <th className="px-6 py-3 text-right">Amount</th>
                <th className="px-6 py-3 hidden md:table-cell">Payer</th>
                <th className="px-6 py-3 hidden lg:table-cell">Tx</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => {
                const tx = p.txHash ? explorerUrl(p.network, p.txHash) : null;
                const isNew = highlightIds.has(p.id);
                return (
                  <tr
                    key={p.id}
                    className={
                      "cursor-pointer border-t border-border/50 transition-colors hover:bg-secondary/40 " +
                      (isNew ? "bg-amber-300/10 animate-pulse" : "")
                    }
                    onClick={() => setSelected(p)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(p);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-label={`Open transaction ${p.id} details`}
                  >
                    <td className="px-6 py-3 text-muted-foreground whitespace-nowrap">
                      {formatRelativeTime(new Date(p.createdAt))}
                    </td>
                    <td className="px-6 py-3">
                      {p.endpointSlug ? (
                        <span className="font-mono text-[11px] text-foreground">
                          {p.displayName ?? p.endpointSlug}
                        </span>
                      ) : (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          direct
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-3 hidden sm:table-cell text-muted-foreground">
                      {networkLabel(p.network)}
                    </td>
                    <td className="px-6 py-3 text-right font-mono text-amber-300">
                      {formatUsd(p.amountAtomic, 6)}
                    </td>
                    <td className="px-6 py-3 hidden md:table-cell font-mono text-[11px] text-muted-foreground">
                      {p.payer ? (
                        <span title={p.payer}>
                          {truncateMiddle(p.payer, 6, 4)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-6 py-3 hidden lg:table-cell font-mono text-[11px] text-muted-foreground">
                      {p.txHash ? (
                        // Stop click from bubbling so the link opens the
                        // explorer instead of the detail modal.
                        tx ? (
                          <a
                            href={tx}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="hover:text-accent hover:underline"
                          >
                            {truncateMiddle(p.txHash, 8, 6)}
                          </a>
                        ) : (
                          <span title={p.txHash}>
                            {truncateMiddle(p.txHash, 8, 6)}
                          </span>
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <footer className="border-t border-border px-6 py-3 text-right">
        <Link
          href="/dashboard/proxies"
          className="text-[11px] text-muted-foreground hover:text-foreground"
        >
          See all endpoints →
        </Link>
      </footer>

      <TransactionDetailModal
        payment={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

/**
 * Adjusts document.title so a background-tab operator sees a fresh
 * count without us having to own the title string when count is 0.
 */
const TITLE_PREFIX_RE = /^\(\d+\)\s+/;
function updateTitlePrefix(count: number): void {
  if (typeof document === "undefined") return;
  const stripped = document.title.replace(TITLE_PREFIX_RE, "");
  document.title = count > 0 ? `(${count}) ${stripped}` : stripped;
}
