"use client";

import { signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Slide-in right-side drawer for mobile navigation. Hamburger trigger
 * lives inside DashboardHeader (rendered only via Tailwind `md:hidden`).
 * Panel is fixed-position so it covers content without affecting
 * layout.
 *
 * Built CSS-first — no @radix-ui/dialog or other library. Escape +
 * backdrop click close. Body scroll is locked while open to match
 * native mobile patterns.
 *
 * Nav-state fetch is LAZY (first open) — avoids a per-page GET when
 * the user is on desktop. Fetch hits `/api/user/nav-state` which
 * returns `{ isAdmin, mode }`. Server-only `auth()` lives there,
 * NOT in DashboardHeader — the header must stay importable from
 * `"use client"` files without dragging pg into the client bundle.
 */

interface NavState {
  isAdmin: boolean;
  mode: "seller" | "buyer";
}

interface NavItem {
  href: string;
  label: string;
}

function buildItems(state: NavState | null): ReadonlyArray<NavItem> {
  // Default item set when nav-state hasn't loaded yet OR the user is
  // anonymous (401 from /api/user/nav-state). Keeps the drawer
  // useful even before the fetch resolves.
  const base: NavItem[] = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/dashboard/proxies", label: "Proxies" },
    { href: "/dashboard/catalog", label: "Catalog" },
    { href: "/dashboard/help", label: "Help" },
  ];
  if (!state) return base;
  const out: NavItem[] = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/dashboard/proxies", label: "Proxies" },
    { href: "/dashboard/catalog", label: "Catalog" },
  ];
  if (state.mode === "buyer") {
    out.push(
      { href: "/dashboard/buyer", label: "Buyer · Overview" },
      { href: "/dashboard/buyer/payments", label: "Buyer · Payments" },
      { href: "/dashboard/buyer/wallets", label: "Buyer · Wallets" },
      { href: "/dashboard/buyer/agent-keys", label: "Buyer · Agent keys" },
      { href: "/dashboard/buyer/limits", label: "Buyer · Limits" },
    );
  }
  out.push({ href: "/dashboard/help", label: "Help" });
  if (state.isAdmin) {
    out.push({
      href: "/dashboard/admin/catalog",
      label: "Admin · Catalog moderation",
    });
  }
  return out;
}

export function MobileNavDrawer(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<NavState | null>(null);
  const [fetched, setFetched] = useState(false);
  const pathname = usePathname();

  // Close the drawer when navigating to a new route — otherwise the
  // panel stays open over the new page after tapping a link.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    // Lock body scroll while open — preserves position because
    // the body keeps its existing layout; iOS Safari is happy.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Lazy-fetch nav state on first open. Avoids a per-page GET on
  // desktop where the drawer is never shown. Anonymous (401) falls
  // back to the default item set.
  useEffect(() => {
    if (!open || fetched) return;
    setFetched(true);
    void (async (): Promise<void> => {
      try {
        const res = await fetch("/api/user/nav-state");
        if (res.ok) {
          const body = (await res.json()) as NavState;
          setState(body);
        }
      } catch {
        // Network blip — leave state null, default items shown.
      }
    })();
  }, [open, fetched]);

  const items = buildItems(state);

  return (
    <>
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-11 w-11 items-center justify-center rounded-md text-foreground transition-colors hover:bg-secondary md:hidden"
      >
        {/* Inline SVG — keeps us out of an icon-library dep. 44×44 touch target via the outer button. */}
        {open ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 4l12 12M16 4L4 16" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M3 6h14M3 10h14M3 14h14" />
          </svg>
        )}
      </button>

      {/* Backdrop. Touchable only when open; pointer-events-none
          when closed so the desktop layout isn't blocked. */}
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className={cn(
          "fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity duration-200 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className={cn(
          "fixed right-0 top-0 z-50 flex h-full w-[80vw] max-w-[320px] flex-col border-l border-border bg-card shadow-2xl transition-transform duration-200 md:hidden",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-amber-400">
            Menu
          </span>
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M4 4l12 12M16 4L4 16" />
            </svg>
          </button>
        </header>

        <nav className="flex-1 overflow-y-auto py-2">
          <ul>
            {items.map((item) => {
              const active =
                pathname === item.href ||
                (item.href !== "/dashboard" &&
                  pathname?.startsWith(item.href));
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "flex h-12 items-center px-5 text-sm font-medium transition-colors",
                      active
                        ? "bg-amber-400/10 text-amber-300"
                        : "text-foreground hover:bg-secondary",
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <footer className="border-t border-border p-3">
          <button
            type="button"
            onClick={() => {
              void signOut({ callbackUrl: "/" });
            }}
            className="flex h-11 w-full items-center justify-center rounded-md border border-border text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Sign out
          </button>
        </footer>
      </aside>
    </>
  );
}
