import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { getUserMode } from "@/lib/buyer";
import { LimitsView } from "./view";

export const dynamic = "force-dynamic";

export default async function BuyerLimitsPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const mode = await getUserMode(session.user.id);
  if (mode === "seller") redirect("/dashboard");

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Buyer", href: "/dashboard/buyer" },
          { label: "Limits" },
        ]}
      />
      <section className="container space-y-6 py-10">
        <div>
          <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
            Spending limits
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Set thresholds for your total spend, per agent key, or per
            endpoint. v1 is tracking-only — enforcement (auto-pause /
            email) lands when the buy-side hook is wired.
          </p>
        </div>
        <LimitsView />
      </section>
    </main>
  );
}
