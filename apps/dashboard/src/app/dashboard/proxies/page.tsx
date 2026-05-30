import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";
import { listProxies } from "@/lib/proxy-config-store";
import { listLinkedKeysWithLabel } from "@/lib/queries";

export const dynamic = "force-dynamic";

/**
 * Proxy list. Server-rendered like /dashboard/catalog — the row
 * count per user is tiny so a single round-trip beats client-side
 * fetch + skeleton.
 */
export default async function ProxiesPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [proxies, keys] = await Promise.all([
    listProxies(session.user.id),
    listLinkedKeysWithLabel(session.user.id),
  ]);
  const activeKeys = keys.filter((k) => k.isActive);
  const proxyBase = process.env["NEXT_PUBLIC_PROXY_BASE_URL"]
    ?? "https://proxy.suverse.io";

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
              server-side code required. Buyers pay in USDC; we forward
              the request to your upstream with your auth headers
              already attached.
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

        {proxies.length === 0 ? (
          <EmptyState hasKey={activeKeys.length > 0} />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full">
              <thead className="border-b border-border bg-card/40">
                <tr className="text-left text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  <th className="px-6 py-3">Endpoint</th>
                  <th className="px-6 py-3 hidden md:table-cell">Upstream</th>
                  <th className="px-6 py-3 text-right">Price</th>
                  <th className="px-6 py-3 hidden sm:table-cell">Networks</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((p) => {
                  const proxyUrl = `${proxyBase}/v1/proxy/${p.resourceKeyId}/${p.endpointSlug}`;
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-border last:border-0 hover:bg-secondary/30"
                    >
                      <td className="px-6 py-3">
                        <Link
                          href={`/dashboard/proxies/${p.id}`}
                          className="font-medium text-foreground hover:text-amber-200"
                        >
                          {p.displayName ?? p.endpointSlug}
                        </Link>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                          {proxyUrl}
                        </div>
                      </td>
                      <td className="px-6 py-3 hidden md:table-cell">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {p.originalMethod} {truncate(p.originalUrl, 40)}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-right font-mono">
                        ${atomicToUsdc(p.priceAtomic)}
                      </td>
                      <td className="px-6 py-3 hidden sm:table-cell">
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {p.acceptedNetworks.length}
                        </span>
                      </td>
                      <td className="px-6 py-3">
                        <StatusPill active={p.isActive} />
                      </td>
                      <td className="px-6 py-3 text-right">
                        <Link
                          href={`/dashboard/proxies/${p.id}`}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          Manage →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function EmptyState({ hasKey }: { hasKey: boolean }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/30 p-12 text-center">
      <h3 className="font-display text-lg font-medium">No proxies yet</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Create a proxy to monetise any existing HTTPS endpoint — point
        us at the upstream, pick a price, and share the generated URL
        with paying clients.
      </p>
      {hasKey ? (
        <Button asChild variant="accent" className="mt-6">
          <Link href="/dashboard/proxies/new">Create your first proxy</Link>
        </Button>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          You need a resource API key first —{" "}
          <Link
            href="/dashboard"
            className="text-amber-400 underline-offset-4 hover:underline"
          >
            head to the dashboard
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function StatusPill({ active }: { active: boolean }): React.JSX.Element {
  return (
    <span
      className={
        "inline-flex rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider " +
        (active
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-amber-500/15 text-amber-300")
      }
    >
      {active ? "Live" : "Paused"}
    </span>
  );
}

function atomicToUsdc(atomic: string): string {
  try {
    const n = BigInt(atomic);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
  } catch {
    return "0";
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
