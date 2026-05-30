import Link from "next/link";
import { notFound } from "next/navigation";
import { ListingDetail } from "@/components/catalog/listing-detail";
import { getListing, incrementViewCount } from "@/lib/catalog-store";

interface PageProps {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public listing detail page. Server-renders the entire detail
 * (no client fetch) for SEO + sub-100ms first paint. Click
 * tracking is delegated to the client-side detail component.
 */
export default async function ListingDetailPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const listing = await getListing(id);
  if (listing === null || listing.status !== "approved") notFound();

  // Fire-and-forget view counter. Same pattern as the API route —
  // we never block the render on it.
  incrementViewCount(id).catch(() => {});

  return (
    <main className="min-h-screen">
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
              className="font-mono uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
            >
              ← Catalog
            </Link>
          </nav>
        </div>
      </header>

      <section className="container py-10">
        <ListingDetail listing={listing} />
      </section>
    </main>
  );
}
