import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { tryGetWalletById } from "@/lib/suverse-wallets";
import { WalletDetailView } from "./view";

export const dynamic = "force-dynamic";

/**
 * Drill-down for a single SuVerse wallet at /dashboard/wallets/[id].
 * Server component validates the id against the static registry —
 * unknown id → 404 (Next.js `notFound`). Admin-gated; non-admins
 * see the same restricted-access panel as /dashboard/wallets.
 *
 * The view itself fetches the per-wallet balance + activity client-
 * side so tab switches and refreshes don't re-hit the server.
 */
export default async function WalletDetailPage(
  { params }: { params: Promise<{ id: string }> },
): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const wallet = tryGetWalletById(id);
  if (!wallet) notFound();

  if (!isAdminEmail(session.user.email)) {
    return (
      <main className="min-h-screen">
        <DashboardHeader
          breadcrumb={[
            { label: "Dashboard", href: "/dashboard" },
            { label: "Wallets", href: "/dashboard/wallets" },
            { label: wallet.label },
          ]}
        />
        <section className="container py-16">
          <div className="mx-auto max-w-md rounded-lg border border-border bg-card p-8 text-center">
            <h1 className="font-display text-xl font-medium">Admin only</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This page is restricted to operators whose email is listed in
              the <code>ADMIN_EMAILS</code> env var.
            </p>
            <Link
              href="/dashboard/wallets"
              className="mt-6 inline-block text-xs uppercase tracking-wider text-amber-400 hover:underline"
            >
              ← back to wallets
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
          { label: "Wallets", href: "/dashboard/wallets" },
          { label: wallet.label },
        ]}
      />
      <section className="container py-10">
        <WalletDetailView wallet={wallet} />
      </section>
    </main>
  );
}
