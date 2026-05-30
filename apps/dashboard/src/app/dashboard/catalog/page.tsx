import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/catalog/status-badge";
import { auth } from "@/lib/auth";
import { listUserListings } from "@/lib/catalog-store";

/**
 * Per-user listing manager. Table view with status pills + edit
 * shortcuts per row. Server-rendered (no flicker, no loading
 * skeleton) — the row count is small enough that we render the
 * whole list in one go.
 */
export default async function DashboardCatalogPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const listings = await listUserListings(session.user.id);
  const counts = {
    approved: listings.filter((l) => l.status === "approved").length,
    pending: listings.filter((l) => l.status === "pending").length,
    rejected: listings.filter((l) => l.status === "rejected").length,
    suspended: listings.filter((l) => l.status === "suspended").length,
  };

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Catalog" },
        ]}
        right={
          <Link
            href="/catalog"
            className="hidden text-xs text-muted-foreground hover:text-foreground sm:inline"
          >
            Browse public catalog →
          </Link>
        }
      />

      <section className="container py-10">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
              Your listings
            </h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {listings.length} total · {counts.approved} approved ·{" "}
              {counts.pending} pending · {counts.rejected} rejected ·{" "}
              {counts.suspended} suspended
            </p>
          </div>
          <Button asChild variant="accent">
            <Link href="/dashboard/catalog/new">New listing</Link>
          </Button>
        </div>

        {listings.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full">
              <thead className="border-b border-border bg-card/40">
                <tr>
                  <Th>Title</Th>
                  <Th className="hidden sm:table-cell">Networks</Th>
                  <Th className="hidden md:table-cell">Status</Th>
                  <Th className="hidden md:table-cell">Created</Th>
                  <Th className="text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => (
                  <tr
                    key={l.id}
                    className="border-b border-border last:border-0 hover:bg-secondary/30"
                  >
                    <Td>
                      <Link
                        href={`/catalog/${l.slug}`}
                        className="font-medium text-foreground hover:text-amber-200"
                      >
                        {l.title}
                      </Link>
                      <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                        {l.endpointUrl}
                      </p>
                    </Td>
                    <Td className="hidden sm:table-cell">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {l.networks.length} chain
                        {l.networks.length === 1 ? "" : "s"}
                      </span>
                    </Td>
                    <Td className="hidden md:table-cell">
                      <StatusBadge status={l.status} verified={l.isVerified} />
                    </Td>
                    <Td className="hidden md:table-cell">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {new Date(l.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                    </Td>
                    <Td className="text-right">
                      <Link
                        href={`/dashboard/catalog/${l.id}/edit`}
                        className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground hover:text-foreground"
                      >
                        Edit
                      </Link>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <th
      className={`px-4 py-3 text-left font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <td className={`px-4 py-3 text-sm align-middle ${className ?? ""}`}>
      {children}
    </td>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/40 p-12 text-center">
      <h3 className="font-display text-lg text-foreground">
        Publish your endpoint to the public catalog
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Listings show up at{" "}
        <Link
          href="/catalog"
          className="text-amber-400 underline-offset-4 hover:underline"
        >
          /catalog
        </Link>{" "}
        so AI agents and buyers can discover your paid endpoint. You can
        list any x402-compatible URL — even ones routed through a
        different facilitator.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <Button asChild variant="accent" size="sm">
          <Link href="/dashboard/catalog/new">Create your first listing</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/catalog">Browse catalog</Link>
        </Button>
      </div>
    </div>
  );
}
