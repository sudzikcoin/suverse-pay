import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Three-step progress strip rendered on /dashboard. Server-derived
 * step state — no client query — so the banner appears immediately
 * on page-load and disappears the moment all three are complete.
 *
 * Steps:
 *   1. Linked at least one API key
 *   2. Created at least one proxy
 *   3. Received at least one settled payment
 *
 * Hides when all three are done (steady state for established users).
 */
export interface OnboardingProgress {
  hasKey: boolean;
  hasProxy: boolean;
  hasSettle: boolean;
}

export function ProgressTracker({
  progress,
}: {
  progress: OnboardingProgress;
}): React.JSX.Element | null {
  const steps = [
    {
      done: progress.hasKey,
      label: "Generate an API key",
      hint: "Above — click + New key",
      href: null as string | null,
    },
    {
      done: progress.hasProxy,
      label: "Create your first proxy",
      hint: "Wrap an HTTPS endpoint behind a paid URL",
      href: progress.hasKey ? "/dashboard/proxies/new" : null,
    },
    {
      done: progress.hasSettle,
      label: "Receive your first payment",
      hint: "Share the proxy URL with a buyer; settles arrive within ~30s",
      href: progress.hasProxy ? "/dashboard/proxies" : null,
    },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  if (completedCount === steps.length) return null;

  const next = steps.find((s) => !s.done);

  return (
    <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-amber-400">
            Get started · {completedCount} / {steps.length} done
          </div>
          {next ? (
            <div className="mt-1 text-sm">
              <span className="font-medium">Next: {next.label}</span>{" "}
              <span className="text-muted-foreground">— {next.hint}</span>
            </div>
          ) : null}
        </div>
        {next?.href ? (
          <Link
            href={next.href}
            className="rounded-md border border-amber-400/50 px-3 py-1.5 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-400/10"
          >
            Continue →
          </Link>
        ) : null}
      </div>
      <ol className="mt-4 grid gap-2 sm:grid-cols-3">
        {steps.map((s, i) => (
          <li
            key={i}
            className={cn(
              "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
              s.done
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
                : "border-border bg-card/40 text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                s.done
                  ? "bg-emerald-500/30 text-emerald-100"
                  : "border border-muted-foreground/40",
              )}
            >
              {s.done ? "✓" : i + 1}
            </span>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
