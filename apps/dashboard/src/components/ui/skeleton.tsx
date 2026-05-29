import { cn } from "@/lib/utils";

/**
 * Skeleton — used as the loading state across all panels. NOT
 * spinners (per the design brief). A subtle shimmer reads as
 * "data is loading" without being noisy.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md bg-muted",
        "before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer",
        "before:bg-gradient-to-r before:from-transparent before:via-white/5 before:to-transparent",
        className,
      )}
      {...props}
    />
  );
}
