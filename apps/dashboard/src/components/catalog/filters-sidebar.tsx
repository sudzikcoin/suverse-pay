"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { NETWORKS_CATALOG } from "@/lib/networks-catalog";
import { REGIONS } from "@/lib/regions-catalog";
import { cn } from "@/lib/utils";

/**
 * Sidebar that drives the public catalog's filter set. State lives
 * in the URL query string so the page is shareable and the back
 * button works as a user expects.
 *
 * Categories are the v1 taxonomy backfilled by db migration 030.
 * Buttons match the values stored in `catalog_listings.category`
 * exactly so a click reliably narrows the feed.
 */
const QUICK_CATEGORIES = [
  "swap",
  "crypto-prices",
  "solana-tools",
  "base-tools",
  "cosmos-tools",
  "defi-data",
  "market-sentiment",
  "forex",
  "weather",
  "commodities",
  "sec-filings",
  "other",
];

export function FiltersSidebar(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();

  const set = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null || value.length === 0) next.delete(key);
      else next.set(key, value);
      next.delete("cursor"); // reset pagination on every filter change
      router.replace(`/catalog?${next.toString()}`);
    },
    [params, router],
  );

  const q = params.get("q") ?? "";
  const region = params.get("region") ?? "";
  const network = params.get("network") ?? "";
  const category = params.get("category") ?? "";
  const verified = params.get("verified");

  const sortedRegions = useMemo(
    () => REGIONS.filter((r) => r.code !== "global"),
    [],
  );

  return (
    <aside className="space-y-6">
      <div>
        <label
          htmlFor="catalog-search"
          className="mb-2 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground"
        >
          Search
        </label>
        <input
          id="catalog-search"
          type="search"
          placeholder="weather, geo, ai…"
          value={q}
          onChange={(e) => set("q", e.target.value)}
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
      </div>

      <FilterGroup
        label="Verified only"
        renderControl={() => (
          <button
            type="button"
            onClick={() =>
              set("verified", verified === "true" ? null : "true")
            }
            className={cn(
              "flex h-9 w-full items-center justify-between rounded-md border px-3 font-mono text-xs transition-colors",
              verified === "true"
                ? "border-amber-400/60 bg-amber-400/10 text-amber-200"
                : "border-border bg-transparent text-muted-foreground hover:border-foreground/30",
            )}
          >
            <span>Show verified only</span>
            <span>{verified === "true" ? "ON" : "OFF"}</span>
          </button>
        )}
      />

      <FilterGroup
        label="Region"
        renderControl={() => (
          <select
            value={region}
            onChange={(e) => set("region", e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <option value="">Any region</option>
            {sortedRegions.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name}
              </option>
            ))}
          </select>
        )}
      />

      <FilterGroup
        label="Network"
        renderControl={() => (
          <select
            value={network}
            onChange={(e) => set("network", e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <option value="">Any network</option>
            {NETWORKS_CATALOG.filter((n) => n.testnet !== true).map((n) => (
              <option key={n.caip2} value={n.caip2}>
                {n.label}
              </option>
            ))}
          </select>
        )}
      />

      <FilterGroup
        label="Category"
        renderControl={() => (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => set("category", null)}
              className={cn(
                "rounded-sm border px-2 py-1 font-mono text-[11px] transition-colors",
                category.length === 0
                  ? "border-foreground/60 bg-secondary text-foreground"
                  : "border-border bg-secondary/30 text-foreground/70 hover:border-foreground/40",
              )}
            >
              all
            </button>
            {QUICK_CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set("category", category === c ? null : c)}
                className={cn(
                  "rounded-sm border px-2 py-1 font-mono text-[11px] transition-colors",
                  category === c
                    ? "border-amber-400/60 bg-amber-400/10 text-amber-200"
                    : "border-border bg-secondary/30 text-foreground/70 hover:border-foreground/40",
                )}
              >
                {c}
              </button>
            ))}
          </div>
        )}
      />
    </aside>
  );
}

function FilterGroup({
  label,
  renderControl,
}: {
  label: string;
  renderControl: () => React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      {renderControl()}
    </div>
  );
}
