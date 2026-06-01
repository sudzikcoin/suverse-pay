import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { WalletsView } from "./view";

export const dynamic = "force-dynamic";

/**
 * Admin /dashboard/wallets — operator visibility for every
 * SuVerse-controlled wallet (merchants + swaps + service +
 * smoke buyers). Server component is admin-gated; the data fetch
 * happens client-side through /api/wallets/* so refresh and per-
 * wallet drill-down can use tanstack-query without an SSR round-
 * trip per click.
 */
export default async function WalletsPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!isAdminEmail(session.user.email)) {
    return (
      <main className="min-h-screen">
        <DashboardHeader
          breadcrumb={[
            { label: "Dashboard", href: "/dashboard" },
            { label: "Admin · Wallets" },
          ]}
        />
        <section className="container py-16">
          <div className="mx-auto max-w-md rounded-lg border border-border bg-card p-8 text-center">
            <h1 className="font-display text-xl font-medium">Admin only</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This page surfaces SuVerse-controlled wallet balances and
              activity. Restricted to operators whose email is listed in
              the <code>ADMIN_EMAILS</code> env var.
            </p>
            <Link
              href="/dashboard"
              className="mt-6 inline-block text-xs uppercase tracking-wider text-amber-400 hover:underline"
            >
              ← back to dashboard
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Admin · Wallets" },
        ]}
      />
      <section className="container py-10">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
              SuVerse wallets
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Every wallet SuVerse operates — merchants, swap liquidity,
              service payers, smoke-test buyers. Balances are pulled live
              from each chain&apos;s RPC; activity comes from
              facilitator_payments + swap_transactions + swap_refunds.
            </p>
          </div>
        </div>
        <WalletsView />
      </section>
    </main>
  );
}
