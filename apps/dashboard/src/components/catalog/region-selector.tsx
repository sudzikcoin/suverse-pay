"use client";

import { useMemo, useState } from "react";
import {
  REGIONS,
  regionGroupLabel,
  regionsByGroup,
  type Region,
} from "@/lib/regions-catalog";
import { cn } from "@/lib/utils";

interface RegionSelectorProps {
  selected: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  /** "available" = positive list, "restricted" = exclusion list. */
  mode?: "available" | "restricted";
  className?: string;
}

/**
 * Multi-select region picker grouped by display-group. Designed for
 * the submission/edit form; reused on the public catalog as a
 * sidebar filter (single-select via the `mode="available"` variant
 * + a tiny shim wrapper).
 *
 * No HTML <form>; pure toggle handlers per the dashboard-wide
 * convention to use onClick instead of <form action>.
 */
export function RegionSelector({
  selected,
  onChange,
  mode = "available",
  className,
}: RegionSelectorProps): React.JSX.Element {
  const groups = useMemo(() => regionsByGroup(), []);
  const selectedSet = useMemo(
    () => new Set(selected.map((s) => s.toLowerCase())),
    [selected],
  );
  const [query, setQuery] = useState("");

  function toggle(code: string): void {
    const next = new Set(selectedSet);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    // 'global' is mutually exclusive with specific regions in
    // "available" mode — picking global wipes the rest.
    if (mode === "available" && code === "global" && next.has("global")) {
      onChange(["global"]);
      return;
    }
    if (mode === "available" && code !== "global" && next.has(code)) {
      next.delete("global");
    }
    onChange(Array.from(next));
  }

  const filterFn = (r: Region) =>
    query.trim().length === 0
      ? true
      : r.name.toLowerCase().includes(query.toLowerCase())
        || r.code.toLowerCase().includes(query.toLowerCase());

  return (
    <div className={cn("space-y-3", className)}>
      <input
        type="search"
        placeholder="Filter regions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />

      <div className="max-h-[400px] space-y-4 overflow-y-auto pr-1">
        {groups.map(({ group, regions }) => {
          const visible = regions.filter(filterFn);
          if (visible.length === 0) return null;
          return (
            <div key={group}>
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {regionGroupLabel(group)}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {visible.map((r) => {
                  const isSel = selectedSet.has(r.code);
                  return (
                    <button
                      key={r.code}
                      type="button"
                      onClick={() => toggle(r.code)}
                      className={cn(
                        "rounded-sm border px-2 py-1 font-mono text-[11px] transition-colors",
                        isSel
                          ? mode === "restricted"
                            ? "border-destructive/60 bg-destructive/15 text-destructive"
                            : "border-amber-400/60 bg-amber-400/10 text-amber-200"
                          : "border-border bg-secondary/30 text-foreground/70 hover:border-foreground/40 hover:bg-secondary/60",
                      )}
                      title={r.name}
                    >
                      {r.code === "global" ? "Global" : r.code.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selected.length > 0 && (
        <p className="font-mono text-[11px] text-muted-foreground">
          {selected.length} selected:{" "}
          {selected
            .map(
              (code) =>
                REGIONS.find((r) => r.code === code)?.name ?? code.toUpperCase(),
            )
            .join(", ")}
        </p>
      )}
    </div>
  );
}
