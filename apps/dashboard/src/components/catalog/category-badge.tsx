import { cn } from "@/lib/utils";

/**
 * Curated colour palette for v1 categories. Anything not in this
 * table (legacy free-text values from before migration 030, or a
 * future addition that hasn't been styled yet) falls through to the
 * neutral muted style — never a hard error and never invisible.
 */
const CATEGORY_STYLES: Record<string, string> = {
  swap:
    "border-amber-400/40 bg-amber-400/10 text-amber-200",
  "crypto-prices":
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  "solana-tools":
    "border-purple-500/40 bg-purple-500/10 text-purple-300",
  "base-tools":
    "border-blue-500/40 bg-blue-500/10 text-blue-300",
  "cosmos-tools":
    "border-indigo-500/40 bg-indigo-500/10 text-indigo-300",
  "defi-data":
    "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  "market-sentiment":
    "border-pink-500/40 bg-pink-500/10 text-pink-300",
  forex:
    "border-sky-500/40 bg-sky-500/10 text-sky-300",
  weather:
    "border-teal-500/40 bg-teal-500/10 text-teal-300",
  commodities:
    "border-yellow-500/40 bg-yellow-500/10 text-yellow-300",
  "sec-filings":
    "border-slate-500/40 bg-slate-500/10 text-slate-300",
  other:
    "border-border bg-secondary/30 text-foreground/70",
};

const NEUTRAL =
  "border-border bg-secondary/30 text-muted-foreground";

interface CategoryBadgeProps {
  category: string | null;
  className?: string;
}

/**
 * Category pill used on the catalog list card and detail header.
 * Null/empty category renders a low-emphasis "uncategorized" badge
 * rather than nothing — it surfaces missing data instead of hiding
 * it, so the moderation backlog stays visible.
 */
export function CategoryBadge({
  category,
  className,
}: CategoryBadgeProps): React.JSX.Element {
  const value = category ?? "uncategorized";
  const tone = category !== null ? CATEGORY_STYLES[category] ?? NEUTRAL : NEUTRAL;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em]",
        tone,
        className,
      )}
    >
      {value}
    </span>
  );
}
