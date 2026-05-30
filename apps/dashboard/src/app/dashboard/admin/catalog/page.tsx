import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { listPendingListings } from "@/lib/catalog-store";
import { ModerationQueue } from "./view";

export const dynamic = "force-dynamic";

/**
 * Admin moderation queue at /dashboard/admin/catalog. Server-fetches
 * the pending listings, hands them to a client island that lets the
 * admin approve / reject with reason. No DB-backed admin role yet —
 * we gate on ADMIN_EMAILS env-var match against the session email.
 */
export default async function CatalogModerationPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  if (!isAdminEmail(session.user.email)) {
    return (
      <main className="min-h-screen">
        <DashboardHeader
          breadcrumb={[
            { label: "Dashboard", href: "/dashboard" },
            { label: "Admin" },
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

  const pending = await listPendingListings();

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Admin", href: "/dashboard/admin/catalog" },
          { label: "Catalog moderation" },
        ]}
      />
      <section className="container space-y-6 py-10">
        <div>
          <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
            Catalog moderation
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Pending listings, oldest first. Approve to publish at{" "}
            <Link
              href="/catalog"
              className="text-amber-400 underline-offset-4 hover:underline"
            >
              /catalog
            </Link>
            . Reject with a short reason — the submitter sees it on
            their dashboard.
          </p>
        </div>
        <ModerationQueue initialListings={pending} />
      </section>
    </main>
  );
}
