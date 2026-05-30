import { cn, networkLabel } from "@/lib/utils";

interface NetworkBadgesProps {
  networks: ReadonlyArray<string>;
  /** Cap on how many to show inline; the rest collapse into a "+N" pill. */
  max?: number;
  className?: string;
}

/**
 * Compact monospace pills, one per CAIP-2 network. Matches the
 * "small mono pill" language used in the existing networks-table
 * panel but lighter (no dot prefix) — these appear in dense card
 * grids where every pixel matters.
 */
export function NetworkBadges({
  networks,
  max = 5,
  className,
}: NetworkBadgesProps): React.JSX.Element {
  const visible = networks.slice(0, max);
  const overflow = networks.length - visible.length;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {visible.map((net) => (
        <span
          key={net}
          className="rounded border border-border bg-secondary/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
          title={net}
        >
          {networkLabel(net)}
        </span>
      ))}
      {overflow > 0 && (
        <span className="rounded border border-border bg-transparent px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          +{overflow}
        </span>
      )}
    </div>
  );
}
