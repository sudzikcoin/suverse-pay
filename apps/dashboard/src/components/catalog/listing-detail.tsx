"use client";

import { useState } from "react";
import type { CatalogListing } from "@/lib/catalog-search";
import { Button } from "@/components/ui/button";
import { networkLabel } from "@/lib/utils";
import { NetworkBadges } from "./network-badges";
import { StatusBadge } from "./status-badge";
import { REGIONS } from "@/lib/regions-catalog";

interface ListingDetailProps {
  listing: CatalogListing;
}

/**
 * Full detail panel for /catalog/[id]. Tracks a click event when
 * the user hits the "Use this endpoint" CTA so listing owners
 * eventually get a conversion signal (Phase 6 dashboard panel
 * for analytics is deferred).
 */
export function ListingDetail({ listing }: ListingDetailProps): React.JSX.Element {
  const [clicking, setClicking] = useState(false);

  async function trackAndOpen(): Promise<void> {
    setClicking(true);
    try {
      await fetch(`/api/catalog/${listing.id}/click`, { method: "POST" });
    } catch {
      // best-effort
    }
    // Open in a new tab so the user's discovery context is preserved.
    window.open(listing.endpointUrl, "_blank", "noopener,noreferrer");
    setClicking(false);
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[2fr_1fr]">
      <article className="space-y-8">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status="approved" verified={listing.isVerified} />
            {listing.category !== null && (
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {listing.category}
              </span>
            )}
          </div>
          <h1 className="font-display text-3xl font-medium leading-tight text-foreground sm:text-4xl">
            {listing.title}
          </h1>
          {listing.description !== null && (
            <p className="max-w-2xl text-base leading-relaxed text-foreground/80">
              {listing.description}
            </p>
          )}
        </header>

        <section>
          <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Networks
          </h2>
          <NetworkBadges networks={listing.networks} max={20} />
        </section>

        <section>
          <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Regions
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {listing.regions.map((code) => {
              const r = REGIONS.find((x) => x.code === code);
              return (
                <span
                  key={code}
                  className="rounded-sm border border-border bg-secondary/30 px-2 py-1 font-mono text-[11px] text-foreground/80"
                >
                  {r ? r.name : code.toUpperCase()}
                </span>
              );
            })}
            {listing.regionRestrictions.length > 0 && (
              <span className="rounded-sm border border-destructive/40 bg-destructive/10 px-2 py-1 font-mono text-[11px] text-destructive">
                blocked: {listing.regionRestrictions.join(", ").toUpperCase()}
              </span>
            )}
          </div>
        </section>

        {listing.tags.length > 0 && (
          <section>
            <h2 className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Tags
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {listing.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-sm border border-border bg-secondary/30 px-2 py-1 font-mono text-[11px] text-foreground/80"
                >
                  #{t}
                </span>
              ))}
            </div>
          </section>
        )}

        <section className="border-t border-border pt-6">
          <Button
            onClick={trackAndOpen}
            disabled={clicking}
            variant="accent"
            size="lg"
          >
            {clicking ? "Opening…" : "Use this endpoint"}
          </Button>
        </section>
      </article>

      <aside className="space-y-6">
        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Endpoint
          </h3>
          <code className="block break-all rounded border border-border bg-background px-3 py-2 font-mono text-xs text-foreground/90">
            {listing.endpointUrl}
          </code>
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Pricing
          </h3>
          {listing.priceAtomicMin === null ? (
            <p className="text-sm text-muted-foreground">
              Pricing not declared — check the endpoint's 402 challenge.
            </p>
          ) : (
            <p className="font-mono text-sm text-foreground/90">
              {formatAtomic(listing.priceAtomicMin)}
              {listing.priceAtomicMax !== null
                && listing.priceAtomicMax !== listing.priceAtomicMin && (
                <> – {formatAtomic(listing.priceAtomicMax)}</>
              )}{" "}
              <span className="text-muted-foreground">{listing.priceUnit}</span>
            </p>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Settlement
          </h3>
          {listing.isVerified ? (
            <p className="text-sm leading-relaxed text-foreground/80">
              <span className="font-medium text-amber-300">
                Verified via Suverse Pay.
              </span>{" "}
              Payments settle through our facilitator, with normalized
              receipts across {listing.networks.length} chain
              {listing.networks.length === 1 ? "" : "s"}.
            </p>
          ) : (
            <p className="text-sm leading-relaxed text-foreground/80">
              External listing — settles via{" "}
              <span className="font-mono text-foreground/90">
                {listing.facilitatorUrl ?? "the endpoint's own facilitator"}
              </span>
              . Suverse Pay indexed this listing but does not process the
              payment.
            </p>
          )}
        </div>

        {(listing.homepageUrl !== null || listing.documentationUrl !== null) && (
          <div className="rounded-lg border border-border bg-card p-5">
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Links
            </h3>
            <ul className="space-y-2 text-sm">
              {listing.homepageUrl !== null && (
                <li>
                  <a
                    href={listing.homepageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-amber-300 underline-offset-4 hover:underline"
                  >
                    Homepage ↗
                  </a>
                </li>
              )}
              {listing.documentationUrl !== null && (
                <li>
                  <a
                    href={listing.documentationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-amber-300 underline-offset-4 hover:underline"
                  >
                    Documentation ↗
                  </a>
                </li>
              )}
            </ul>
          </div>
        )}

        <div className="rounded-lg border border-border bg-card p-5 font-mono text-[11px] text-muted-foreground">
          <p>
            Listed{" "}
            {new Date(listing.publishedAt ?? listing.createdAt).toLocaleDateString(
              "en-US",
              { year: "numeric", month: "short", day: "numeric" },
            )}
          </p>
          <p>
            {listing.viewCount.toLocaleString()} views · {listing.clickCount.toLocaleString()} clicks
          </p>
        </div>
      </aside>
    </div>
  );
}

function formatAtomic(atomic: string): string {
  try {
    const v = BigInt(atomic);
    const d = v / 1_000_000n;
    const c = v % 1_000_000n;
    if (d > 0n) return `$${d}.${c.toString().padStart(6, "0").slice(0, 2)}`;
    return `$0.${c.toString().padStart(6, "0").replace(/0+$/, "") || "0"}`;
  } catch {
    return "$?";
  }
}

// Re-exported so the detail page can import label-formatting helpers
// from a single barrel if desired.
export { networkLabel };
