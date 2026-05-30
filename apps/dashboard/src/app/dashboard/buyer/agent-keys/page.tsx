import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { getUserMode } from "@/lib/buyer";
import { AgentKeysView } from "./view";

export const dynamic = "force-dynamic";

export default async function BuyerAgentKeysPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const mode = await getUserMode(session.user.id);
  if (mode === "seller") redirect("/dashboard");

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Buyer", href: "/dashboard/buyer" },
          { label: "Agent keys" },
        ]}
      />
      <section className="container space-y-6 py-10">
        <div>
          <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
            Agent API keys
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Identifiers your agents (SDK, MCP server, custom scripts)
            pass when calling paid endpoints. Each key can be revoked
            independently and shows up in your usage logs.
          </p>
        </div>
        <AgentKeysView />
      </section>
    </main>
  );
}
