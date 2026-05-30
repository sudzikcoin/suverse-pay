import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { SubmissionForm } from "@/components/catalog/submission-form";
import { StatusBadge } from "@/components/catalog/status-badge";
import { DeleteListingButton } from "./delete-button";
import { auth } from "@/lib/auth";
import { getListing } from "@/lib/catalog-store";

interface PageProps {
  params: Promise<{ id: string }>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Edit page for a single listing. Cross-tenant guarded — we 404
 * if the listing exists but the caller didn't submit it (vs
 * confirming "exists, no permission" — same data-leak avoidance
 * pattern as elsewhere in the dashboard).
 */
export default async function EditListingPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const listing = await getListing(id);
  if (listing === null) notFound();
  // Stranger trying to edit someone else's listing — 404, not 403.
  // (The store doesn't return submitter info on getListing, so we
  // re-derive ownership: only listings in the user's submissions
  // list are editable. A direct getListing returns ALL approved
  // listings publicly, so we filter here for the edit grant.)
  const session_uid = session.user.id;
  const ownerOnly = await import("@/lib/catalog-store").then((m) =>
    m.listUserListings(session_uid),
  );
  if (!ownerOnly.some((l) => l.id === id)) notFound();

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Catalog", href: "/dashboard/catalog" },
          { label: "Edit" },
        ]}
        right={
          <Link
            href="/dashboard/catalog"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ← All listings
          </Link>
        }
      />

      <section className="container max-w-3xl py-10">
        <div className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
              {listing.title}
            </h1>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              {listing.id}
            </p>
          </div>
          <StatusBadge status={listing.status} verified={listing.isVerified} />
        </div>

        {listing.rejectionReason !== null && (
          <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/10 p-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-destructive">
              Rejected
            </p>
            <p className="mt-1 text-sm text-foreground/80">
              {listing.rejectionReason}
            </p>
          </div>
        )}

        <SubmissionForm
          mode="edit"
          listingId={id}
          initial={{
            title: listing.title,
            description: listing.description ?? "",
            endpointUrl: listing.endpointUrl,
            category: listing.category ?? "",
            tags: listing.tags.join(", "),
            priceAtomicMin: listing.priceAtomicMin ?? "",
            priceAtomicMax: listing.priceAtomicMax ?? "",
            priceUnit: listing.priceUnit,
            networks: [...listing.networks],
            regions: [...listing.regions],
            regionRestrictions: [...listing.regionRestrictions],
            facilitatorUrl: listing.facilitatorUrl ?? "",
            homepageUrl: listing.homepageUrl ?? "",
            documentationUrl: listing.documentationUrl ?? "",
          }}
        />

        <div className="mt-12 border-t border-border pt-6">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.18em] text-destructive">
            Danger zone
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Suspending hides the listing from the public catalog. The row
            stays in the database for audit; admins can restore it.
          </p>
          <DeleteListingButton id={id} />
        </div>
      </section>
    </main>
  );
}
