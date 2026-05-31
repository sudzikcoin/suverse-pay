"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Bottom tab bar rendered ONLY when the page is open in PWA
 * "Add to Home Screen" / standalone display mode. In a normal
 * browser session it stays hidden — desktop / regular mobile users
 * keep the existing header nav + hamburger drawer.
 *
 * Visibility is two-layered:
 *   * Tailwind `md:hidden`  — never visible on tablets/desktops
 *   * `pwa-standalone-only` CSS class — only visible when
 *     @media (display-mode: standalone) matches. Defined in
 *     globals.css; this keeps the rule out of every browser's
 *     paint when the user isn't installed.
 *
 * Touch targets are 56px tall (Apple HIG min 44pt; we use 56 for
 * comfort + label legibility). Active route gets an amber tint.
 *
 * Wired in apps/dashboard/src/app/layout.tsx so every page gets it
 * for free.
 */
export function MobileBottomNav(): React.JSX.Element {
  const pathname = usePathname() ?? "";
  const items: Array<{ href: string; label: string; icon: React.ReactNode; match: (p: string) => boolean }> = [
    {
      href: "/dashboard",
      label: "Home",
      match: (p) => p === "/dashboard" || p === "/dashboard/buyer",
      icon: (
        <IconHome />
      ),
    },
    {
      href: "/catalog",
      label: "Catalog",
      match: (p) => p === "/catalog" || p.startsWith("/catalog/"),
      icon: <IconCatalog />,
    },
    {
      href: "/dashboard/proxies",
      label: "Proxies",
      match: (p) => p.startsWith("/dashboard/proxies"),
      icon: <IconProxies />,
    },
    {
      href: "/dashboard/help",
      label: "Help",
      match: (p) => p === "/dashboard/help",
      icon: <IconHelp />,
    },
  ];

  return (
    <nav
      aria-label="Primary"
      className="pwa-standalone-only fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card/95 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid grid-cols-4">
        {items.map((it) => {
          const active = it.match(pathname);
          return (
            <li key={it.href}>
              <Link
                href={it.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-1 text-[10px] font-medium uppercase tracking-wider transition-colors",
                  active
                    ? "text-amber-300"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span aria-hidden className="block">
                  {it.icon}
                </span>
                {it.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/* ────────────────────────────────────────────────────────────────
   Inline icons — 20×20, stroke-based. Kept here to avoid an icon
   library dependency for 4 glyphs.
   ──────────────────────────────────────────────────────────────── */

function IconHome(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l7-6 7 6v8a1 1 0 0 1-1 1h-3v-5H7v5H4a1 1 0 0 1-1-1V9z" />
    </svg>
  );
}

function IconCatalog(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 4h14M3 10h14M3 16h14" />
    </svg>
  );
}

function IconProxies(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7h6M3 13h6M11 4h6v4h-6zM11 12h6v4h-6z" />
    </svg>
  );
}

function IconHelp(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M8 8a2 2 0 1 1 3 1.7c-.8.5-1 1-1 1.6V12" />
      <circle cx="10" cy="14.5" r="0.5" fill="currentColor" />
    </svg>
  );
}
