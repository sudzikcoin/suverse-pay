import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { listLinkedKeysWithLabel } from "@/lib/queries";
import { ProxiesListView } from "./view";

export const dynamic = "force-dynamic";

/**
 * Proxy list. The server component pulls just enough to decide
 * whether to render the "create a key first" hint vs the full
 * table view; the table itself fetches stats via /api/proxies-with-stats
 * on the client so filters + sort don't pay a round-trip per click.
 */
export default async function ProxiesPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const keys = await listLinkedKeysWithLabel(session.user.id);
  const activeKeys = keys.filter((k) => k.isActive);
  const proxyBase =
    process.env["NEXT_PUBLIC_PROXY_BASE_URL"] ?? "https://proxy.suverse.io";

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Proxies" },
        ]}
        right={
          <Link
            href="/dashboard/docs/configure-resource-server"
            className="hidden text-xs text-muted-foreground hover:text-foreground sm:inline"
          >
            Docs →
          </Link>
        }
      />

      <section className="container py-10">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
              API proxies
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Wrap any HTTPS endpoint behind an x402 paid URL — no
              server-side code required. Filters and sort below; click
              a row to manage the endpoint.
            </p>
          </div>
          {activeKeys.length === 0 ? (
            <Link
              href="/dashboard"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← create a resource key first
            </Link>
          ) : (
            <Button asChild variant="accent">
              <Link href="/dashboard/proxies/new">+ New proxy</Link>
            </Button>
          )}
        </div>

        <ProxiesListView proxyBase={proxyBase} />
      </section>
    </main>
  );
}
