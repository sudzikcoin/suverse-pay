import Link from "next/link";
import type { CatalogListing } from "@/lib/catalog-search";
import { NetworkBadges } from "./network-badges";
import { StatusBadge } from "./status-badge";

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
      href={`/catalog/${listing.id}`}
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
        <p className="font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
          {listing.category ?? "uncategorized"}
        </p>
        {listing.priceAtomicMin !== null && (
          <p className="font-mono text-xs text-foreground/80">
            from{" "}
            <span className="text-amber-300">
              {formatAtomicUsd(listing.priceAtomicMin)}
            </span>
            {listing.priceAtomicMax !== null
              && listing.priceAtomicMax !== listing.priceAtomicMin
              && (
                <>
                  {" – "}
                  <span className="text-amber-300">
                    {formatAtomicUsd(listing.priceAtomicMax)}
                  </span>
                </>
              )}{" "}
            <span className="text-muted-foreground">{listing.priceUnit}</span>
          </p>
        )}
      </div>
    </Link>
  );
}

/** Atomic USDC (6-dec) → human dollar string. */
function formatAtomicUsd(atomic: string): string {
  try {
    const v = BigInt(atomic);
    const dollars = v / 1_000_000n;
    const cents = v % 1_000_000n;
    if (dollars > 0n) {
      const trimmed = cents.toString().padStart(6, "0").slice(0, 2);
      return `$${dollars}.${trimmed}`;
    }
    // Sub-dollar — show full 6-dec precision (typical x402 pricing).
    return `$0.${cents.toString().padStart(6, "0").replace(/0+$/, "") || "0"}`;
  } catch {
    return "$?";
  }
}
