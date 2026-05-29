"use client";

import { cn } from "@/lib/utils";

export type Period = "24h" | "7d" | "30d";

const OPTIONS: ReadonlyArray<{ value: Period; label: string }> = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

/**
 * Period segmented control. Plain HTML radio-group semantics with
 * a custom skin — fewer dependencies than a Radix wrapper for a
 * three-button toggle and keeps Tab/Arrow keyboard nav free.
 */
export function PeriodToggle({
  value,
  onChange,
}: {
  value: Period;
  onChange: (next: Period) => void;
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Time period"
      className="inline-flex items-center gap-px rounded-md border border-border bg-card p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
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
