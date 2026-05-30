"use client";

import { cn } from "@/lib/utils";

export type NetworkMode = "mainnet" | "all";

/**
 * Two-state pill that gates whether dashboard aggregates include
 * testnet (and synthetic-mock) rows. Default = mainnet-only, which
 * matches what production sellers actually care about.
 */
export function NetworkModeToggle({
  value,
  onChange,
}: {
  value: NetworkMode;
  onChange: (next: NetworkMode) => void;
}): React.JSX.Element {
  const options: ReadonlyArray<{ value: NetworkMode; label: string; title: string }> = [
    { value: "mainnet", label: "Mainnet", title: "Production networks only" },
    { value: "all", label: "All", title: "Include testnet + synthetic mock rows" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Network mode"
      className="inline-flex items-center gap-px rounded-md border border-border bg-card p-0.5"
    >
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded px-3 py-1.5 text-xs font-medium transition-colors",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
