import Link from "next/link";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { getUserMode } from "@/lib/buyer";
import { MobileNavDrawer, type NavItem } from "./mobile-nav-drawer";

/**
 * Shared dashboard chrome header. Every internal page renders this
 * so the wordmark stays a guaranteed "back to /dashboard" affordance
 * and the breadcrumb tells the user where they are.
 *
 * Now an async server component — calls `auth()` itself to compute
 * the mobile-nav item list (admin link only when ADMIN_EMAILS matches,
 * buyer/seller-specific links by `preferred_mode`). Anonymous renders
 * are safe — the page that mounts the header would already have
 * redirected before getting here.
 *
 * Layout:
 *   [wordmark] [breadcrumb — hidden <sm] ........ [right slot] [hamburger md:hidden]
 *
 * The hamburger reveals MobileNavDrawer which carries the same routes
 * the right-slot would have shown on desktop, plus Sign out.
 */
export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export async function DashboardHeader({
  breadcrumb,
  right,
  sticky = false,
}: {
  breadcrumb: ReadonlyArray<BreadcrumbItem>;
  right?: React.ReactNode;
  /** Sticky header — used on the long /configure form. */
  sticky?: boolean;
}): Promise<React.JSX.Element> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  const userId = session?.user?.id ?? null;
  const mode = userId ? await getUserMode(userId) : "seller";
  const admin = isAdminEmail(email);

  const navItems: NavItem[] = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/dashboard/proxies", label: "Proxies" },
    { href: "/dashboard/catalog", label: "Catalog" },
    { href: "/dashboard/buyer", label: "Buyer", show: mode === "buyer" },
    { href: "/dashboard/buyer/payments", label: "Buyer · Payments", show: mode === "buyer" },
    { href: "/dashboard/buyer/wallets", label: "Buyer · Wallets", show: mode === "buyer" },
    { href: "/dashboard/buyer/agent-keys", label: "Buyer · Agent keys", show: mode === "buyer" },
    { href: "/dashboard/buyer/limits", label: "Buyer · Limits", show: mode === "buyer" },
    { href: "/dashboard/help", label: "Help" },
    { href: "/dashboard/admin/catalog", label: "Admin · Catalog moderation", show: admin },
  ];

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
          {/* Right-slot still rendered on md+ for desktop affordances
              (ModeToggle, sign-out, per-page nav). On mobile we wrap
              it in a flex so the ModeToggle (always present on the
              dashboard landing) stays visible alongside the hamburger. */}
          {right}
          <MobileNavDrawer items={navItems} />
        </div>
      </div>
    </header>
  );
}
