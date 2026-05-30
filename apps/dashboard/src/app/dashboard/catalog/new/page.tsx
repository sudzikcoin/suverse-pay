import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { SubmissionForm } from "@/components/catalog/submission-form";
import { auth } from "@/lib/auth";
import { listLinkedKeysWithLabel } from "@/lib/queries";

/**
 * Authenticated "new listing" page. Loads the user's owned
 * resource keys so the form can render a "link & auto-verify"
 * selector. Listings linked to an owned key publish immediately;
 * everything else goes through moderation.
 */
export default async function NewListingPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const keys = (await listLinkedKeysWithLabel(session.user.id))
    .filter((k) => k.isActive)
    .map((k) => ({ resourceKeyId: k.resourceKeyId, label: k.label }));

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Catalog", href: "/dashboard/catalog" },
          { label: "New" },
        ]}
      />

      <section className="container max-w-3xl py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
            New listing
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Linking one of your suverse-pay keys auto-publishes the
            listing as Verified. Otherwise it goes through the
            moderation queue.
          </p>
        </div>

        <SubmissionForm mode="authenticated" ownedKeys={keys} />
      </section>
    </main>
  );
}
