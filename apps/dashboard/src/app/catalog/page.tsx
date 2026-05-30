import Link from "next/link";
import { Suspense } from "react";
import { FiltersSidebar } from "@/components/catalog/filters-sidebar";
import { ListingCard } from "@/components/catalog/listing-card";
import { Button } from "@/components/ui/button";
import {
  applyFilter,
  paginate,
  sortForFeed,
  truncateDescription,
  type CatalogFilter,
} from "@/lib/catalog-search";
import { listApprovedListings } from "@/lib/catalog-store";

interface PageProps {
  searchParams: Promise<{
    q?: string;
    network?: string;
    region?: string;
    category?: string;
    verified?: string;
    cursor?: string;
  }>;
}

/**
 * Public discovery catalog. Server-rendered for SEO + first-paint
 * speed. Filters live in the URL and reapply by replacing the URL
 * client-side (FiltersSidebar handles that).
 */
export default async function CatalogPage({ searchParams }: PageProps): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const filter: CatalogFilter = {};
  if (sp.q !== undefined && sp.q.length > 0) filter.q = sp.q;
  if (sp.network !== undefined && sp.network.length > 0) filter.network = sp.network;
  if (sp.region !== undefined && sp.region.length > 0) filter.region = sp.region;
  if (sp.category !== undefined && sp.category.length > 0) filter.category = sp.category;
  if (sp.verified === "true") filter.verified = true;

  const all = await listApprovedListings();
  const filtered = all.filter((l) => applyFilter(l, filter)).sort(sortForFeed);
  const cursor =
    sp.cursor !== undefined && /^\d+$/.test(sp.cursor)
      ? Number(sp.cursor)
      : null;
  const { page, nextCursor } = paginate(filtered, 20, cursor);

  const truncated = page.map((l) => ({
    ...l,
    description: truncateDescription(l.description),
  }));

  return (
    <main className="min-h-screen">
      <CatalogHeader />

      <section className="container py-8 sm:py-12">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber-400">
              Suverse Pay
            </p>
            <h1 className="mt-2 font-display text-3xl font-medium leading-tight sm:text-4xl">
              Pay-per-call discovery
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Endpoints you can call with USDC over the x402 protocol —
              {" "}verified through Suverse Pay or self-listed by their
              {" "}operators.
            </p>
          </div>
          <Button asChild variant="accent">
            <Link href="/catalog/submit">List your endpoint</Link>
          </Button>
        </div>

        <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
          <Suspense fallback={null}>
            <FiltersSidebar />
          </Suspense>

          <div className="space-y-6">
            <p className="font-mono text-[11px] text-muted-foreground">
              {filtered.length} listing{filtered.length === 1 ? "" : "s"}
            </p>

            {truncated.length === 0 ? (
              <EmptyState hasFilter={Object.keys(filter).length > 0} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {truncated.map((l) => (
                  <ListingCard key={l.id} listing={l} />
                ))}
              </div>
            )}

            {nextCursor !== null && (
              <div className="flex justify-center pt-6">
                <NextPageLink
                  searchParams={sp}
                  nextCursor={nextCursor}
                />
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function CatalogHeader(): React.JSX.Element {
  return (
    <header className="border-b border-border bg-card/40 backdrop-blur">
      <div className="container flex h-14 items-center justify-between">
        <Link
          href="/"
          className="font-mono text-xs uppercase tracking-[0.3em] text-amber-400"
        >
          Suverse Pay
        </Link>
        <nav className="flex items-center gap-6 text-xs">
          <Link
            href="/catalog"
            className="font-mono uppercase tracking-[0.2em] text-foreground"
          >
            Catalog
          </Link>
          <Link
            href="/dashboard"
            className="font-mono uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
          >
            Dashboard
          </Link>
        </nav>
      </div>
    </header>
  );
}

function NextPageLink({
  searchParams,
  nextCursor,
}: {
  searchParams: Record<string, string | undefined>;
  nextCursor: number;
}): React.JSX.Element {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (k === "cursor") continue;
    if (v !== undefined) sp.set(k, v);
  }
  sp.set("cursor", String(nextCursor));
  return (
    <Link
      href={`/catalog?${sp.toString()}`}
      className="rounded-md border border-border px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-foreground hover:bg-secondary"
    >
      Next page →
    </Link>
  );
}

function EmptyState({ hasFilter }: { hasFilter: boolean }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/40 p-12 text-center">
      <h3 className="font-display text-lg text-foreground">
        {hasFilter ? "No listings match this filter." : "The catalog is empty."}
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        {hasFilter
          ? "Try a broader region, a different network, or clear the search."
          : "Be the first to list a paid endpoint."}
      </p>
      <div className="mt-6">
        <Button asChild variant="accent" size="sm">
          <Link href="/catalog/submit">List your endpoint</Link>
        </Button>
      </div>
    </div>
  );
}
