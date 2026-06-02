import Link from "next/link";
import type { CatalogListing } from "@/lib/catalog-search";
import { CategoryBadge } from "./category-badge";
import { NetworkBadges } from "./network-badges";
import { StatusBadge } from "./status-badge";
import { formatListingPrice } from "@/lib/format-price";

interface ListingCardProps {
  listing: CatalogListing;
}

/**
 * Editorial-grid card. Title in display font, supporting metadata in
 * monospace pills, single sharp accent if verified. No images for v1
 * (logo_url is captured but not displayed in the list view — it
 * surfaces on the detail page) — keeps the grid even-height and
 * legible on mobile.
 */
export function ListingCard({ listing }: ListingCardProps): React.JSX.Element {
  return (
    <Link
      href={`/catalog/${listing.slug}`}
      className="group block rounded-lg border border-border bg-card p-5 transition-colors hover:border-foreground/30"
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <h3 className="text-base font-medium leading-snug text-foreground transition-colors group-hover:text-amber-200 sm:text-lg">
          {listing.title}
        </h3>
        {listing.isVerified && (
          <StatusBadge status="approved" verified className="shrink-0" />
        )}
      </header>

      {listing.description !== null && listing.description.length > 0 && (
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          {listing.description}
        </p>
      )}

      <div className="mb-3">
        <NetworkBadges networks={listing.networks} max={4} />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <CategoryBadge category={listing.category} />
        {listing.priceAtomicMin !== null && (
          <p className="font-mono text-xs text-foreground/80">
            <span className="text-amber-300">
              {formatListingPrice(listing.priceAtomicMin)}
            </span>{" "}
            <span className="text-muted-foreground">
              {formatListingPriceUnit(listing.priceUnit)}
            </span>
          </p>
        )}
      </div>
    </Link>
  );
}

/**
 * Render the price unit in human-readable form. The DB stores the
 * x402 spec value ("per-call") but in UI copy we render the more
 * natural "per call" without the hyphen.
 */
function formatListingPriceUnit(unit: string): string {
  if (unit === "per-call") return "per call";
  return unit;
}
