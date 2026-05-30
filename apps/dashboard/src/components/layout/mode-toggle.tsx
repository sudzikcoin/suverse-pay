"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Seller / Buyer mode toggle. Sits in DashboardHeader. POSTs to
 * /api/buyer/mode and triggers a router push to the appropriate
 * landing page — the server-rendered redirect logic in
 * /dashboard/page.tsx + /dashboard/buyer/page.tsx then takes over.
 */
export function ModeToggle({
  current,
}: {
  current: "seller" | "buyer";
}): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState<"seller" | "buyer" | null>(null);

  async function flip(mode: "seller" | "buyer"): Promise<void> {
    if (mode === current || pending !== null) return;
    setPending(mode);
    try {
      const res = await fetch("/api/buyer/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      if (!res.ok) {
        setPending(null);
        return;
      }
      // Push to the landing page for the new mode. The server
      // components on each route re-check preferred_mode and would
      // bounce back if we got it wrong — so the push here is just
      // the happy-path optimization.
      router.push(mode === "buyer" ? "/dashboard/buyer" : "/dashboard");
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Dashboard mode"
      className="inline-flex items-center gap-px rounded-md border border-border bg-card p-0.5 text-[10px] font-medium uppercase tracking-wider"
    >
      <ModeButton
        active={current === "seller"}
        loading={pending === "seller"}
        onClick={() => void flip("seller")}
      >
        Seller
      </ModeButton>
      <ModeButton
        active={current === "buyer"}
        loading={pending === "buyer"}
        onClick={() => void flip("buyer")}
      >
        Buyer
      </ModeButton>
    </div>
  );
}

function ModeButton({
  active,
  loading,
  onClick,
  children,
}: {
  active: boolean;
  loading: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      disabled={loading}
      className={cn(
        "rounded px-2.5 py-1 transition-colors",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:text-foreground",
        loading && "opacity-60",
      )}
    >
      {children}
    </button>
  );
}
