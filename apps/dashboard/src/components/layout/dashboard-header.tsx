import Link from "next/link";
import { MobileNavDrawer } from "./mobile-nav-drawer";

/**
 * Shared dashboard chrome header. Every internal page renders this
 * so the wordmark stays a guaranteed "back to /dashboard" affordance
 * and the breadcrumb tells the user where they are.
 *
 * Pure pass-through component — NO server-only imports. It's safe to
 * import from `"use client"` files (e.g. /dashboard/keys/[id]/
 * configure/view.tsx). Admin / buyer-mode state for the mobile nav
 * drawer is fetched client-side by MobileNavDrawer itself via
 * /api/user/nav-state — keeps the server/client boundary clean and
 * avoids dragging `pg` (transitive via @/lib/auth → @/lib/db) into
 * the client bundle.
 *
 * Layout:
 *   [wordmark] [breadcrumb — hidden <sm] ........ [Help md+] [right slot] [hamburger md:hidden]
 */
export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export function DashboardHeader({
  breadcrumb,
  right,
  sticky = false,
}: {
  breadcrumb: ReadonlyArray<BreadcrumbItem>;
  right?: React.ReactNode;
  /** Sticky header — used on the long /configure form. */
  sticky?: boolean;
}): React.JSX.Element {
  return (
    <header
      className={
        sticky
          ? "sticky top-0 z-20 border-b border-border bg-card/80 backdrop-blur"
          : "border-b border-border bg-card/40 backdrop-blur"
      }
    >
      <div className="container flex h-16 items-center justify-between gap-3">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-baseline gap-3 overflow-hidden"
        >
          <Link
            href="/dashboard"
            className="font-mono text-xs uppercase tracking-[0.3em] text-amber-400 transition-colors hover:text-amber-300"
          >
            Suverse Pay
          </Link>
          <span className="hidden truncate text-sm text-muted-foreground sm:inline">
            {breadcrumb.map((item, i) => {
              const isLast = i === breadcrumb.length - 1;
              return (
                <span key={`${item.label}-${i}`}>
                  <span className="px-1.5 text-muted-foreground/60">/</span>
                  {item.href && !isLast ? (
                    <Link
                      href={item.href}
                      className="transition-colors hover:text-foreground"
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span
                      className={isLast ? "text-foreground" : undefined}
                      aria-current={isLast ? "page" : undefined}
                    >
                      {item.label}
                    </span>
                  )}
                </span>
              );
            })}
          </span>
        </nav>
        <div className="flex flex-none items-center gap-3">
          <Link
            href="/dashboard/help"
            className="hidden text-xs text-muted-foreground transition-colors hover:text-foreground md:inline"
            title="Glossary, FAQ, and contact info"
          >
            Help
          </Link>
          {right}
          <MobileNavDrawer />
        </div>
      </div>
    </header>
  );
}
