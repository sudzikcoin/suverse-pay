import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { getUserMode } from "@/lib/buyer";
import { WalletsView } from "./view";

export const dynamic = "force-dynamic";

export default async function BuyerWalletsPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const mode = await getUserMode(session.user.id);
  if (mode === "seller") redirect("/dashboard");

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Buyer", href: "/dashboard/buyer" },
          { label: "Wallets" },
        ]}
      />
      <section className="container space-y-6 py-10">
        <div>
          <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
            Wallets
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Register the payer addresses your agents pay from. Every
            settled payment from one of these addresses appears under
            your buyer dashboard.
          </p>
        </div>
        <WalletsView />
      </section>
    </main>
  );
}
