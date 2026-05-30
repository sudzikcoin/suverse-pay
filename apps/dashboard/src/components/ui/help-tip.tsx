"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Tiny inline help affordance — a "?" badge that reveals a tooltip
 * card on hover or keyboard focus. CSS-only positioning so we don't
 * pull in a tooltip library for v1. The tip itself is a real DOM
 * node (not a `title` attribute) so it can contain links and rich
 * markup; aria-describedby ties the trigger to the tip text for
 * screen readers.
 *
 * Use sparingly — every "?" is a small attention tax. Reserve for
 * the ~3 highest-value fields per form.
 */
export function HelpTip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className={cn("relative inline-flex", className)}>
      <button
        type="button"
        aria-describedby={open ? id : undefined}
        aria-label="More info"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-border bg-secondary text-[10px] font-bold leading-none text-muted-foreground transition-colors hover:border-amber-400 hover:text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400/40"
      >
        ?
      </button>
      {open ? (
        <span
          role="tooltip"
          id={id}
          className="absolute bottom-full left-1/2 z-30 mb-2 w-64 -translate-x-1/2 rounded-md border border-border bg-card px-3 py-2 text-[11px] leading-relaxed text-foreground shadow-lg"
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}
