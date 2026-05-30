import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { getUserMode, listWallets } from "@/lib/buyer";
import { PaymentsView } from "./view";

export const dynamic = "force-dynamic";

/**
 * Buyer-side paginated payments table at /dashboard/buyer/payments.
 * Mirrors the seller settles table but scoped by payer rather than
 * resource_key_id.
 */
export default async function BuyerPaymentsPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const mode = await getUserMode(session.user.id);
  if (mode === "seller") redirect("/dashboard");

  const wallets = await listWallets(session.user.id);

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Buyer", href: "/dashboard/buyer" },
          { label: "Payments" },
        ]}
      />
      <section className="container space-y-6 py-10">
        <div>
          <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
            Payments
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Every settled / failed payment from your registered wallets.
            Filter by network or recipient address, narrow by date,
            export the result set as CSV.
          </p>
        </div>
        <PaymentsView hasWallets={wallets.length > 0} />
      </section>
    </main>
  );
}
