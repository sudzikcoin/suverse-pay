import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { ListingDetail } from "@/components/catalog/listing-detail";
import {
  getListing,
  getListingBySlug,
  incrementViewCount,
} from "@/lib/catalog-store";

interface PageProps {
  params: Promise<{ slug: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Public listing detail page. v2 of the route — slug-keyed for SEO
 * + memorability. Falls through to UUID lookup if someone hits the
 * page with a UUID-shaped param (covers the old /catalog/<uuid>
 * inbound links until we drop the legacy redirect in a future cleanup).
 */
export default async function ListingDetailPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const listing = UUID_RE.test(slug)
    ? await getListing(slug)
    : await getListingBySlug(slug);
  if (listing === null || listing.status !== "approved") notFound();
  // If we resolved via UUID, redirect to the canonical slug URL so
  // crawlers index one URL per listing.
  if (UUID_RE.test(slug) && listing.slug !== slug) {
    redirect(`/catalog/${listing.slug}`);
  }

  // Fire-and-forget view counter; never blocks the render.
  incrementViewCount(listing.id).catch(() => {});

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

/**
 * Per-listing SEO + OG metadata. Description is truncated to 160
 * chars (Google's typical snippet cap); title prefixes with the
 * brand so search results look consistent.
 */
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const listing = UUID_RE.test(slug)
    ? await getListing(slug)
    : await getListingBySlug(slug);
  if (listing === null || listing.status !== "approved") {
    return { title: "Listing not found · Suverse Pay" };
  }
  const desc = (listing.description ?? "").slice(0, 160);
  return {
    title: `${listing.title} · Suverse Pay`,
    description: desc.length > 0 ? desc : `${listing.title} — paid x402 endpoint`,
    openGraph: {
      title: listing.title,
      description: desc,
      type: "website",
      url: `/catalog/${listing.slug}`,
    },
    twitter: {
      card: "summary",
      title: listing.title,
      description: desc,
    },
  };
}
