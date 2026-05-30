import { cn } from "@/lib/utils";

type Status = "pending" | "approved" | "rejected" | "suspended";

interface StatusBadgeProps {
  status: Status;
  verified?: boolean;
  className?: string;
}

/**
 * Renders the moderation status of a listing. Verified listings get
 * the amber accent treatment (used sparingly across the dashboard —
 * see globals.css notes); pending stays muted; rejected/suspended
 * lean on destructive but with restraint.
 */
export function StatusBadge({
  status,
  verified,
  className,
}: StatusBadgeProps): React.JSX.Element {
  if (verified && status === "approved") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sm border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-amber-300",
          className,
        )}
        title="Linked to a resource key you own — published automatically"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
        Verified
      </span>
    );
  }
  const styles: Record<Status, string> = {
    approved:
      "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
    pending:
      "border-muted-foreground/30 bg-muted/30 text-muted-foreground",
    rejected:
      "border-destructive/50 bg-destructive/10 text-destructive",
    suspended:
      "border-muted-foreground/30 bg-muted/30 text-muted-foreground line-through",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]",
        styles[status],
        className,
      )}
    >
      {status}
    </span>
  );
}
