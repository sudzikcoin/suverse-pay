import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { ModeToggle } from "@/components/layout/mode-toggle";
import { getUserMode, listWallets } from "@/lib/buyer";
import { BuyerOverview } from "./overview";

/**
 * Buyer dashboard landing. Server component — checks mode + loads
 * wallet count, hands a flag to the client overview which renders
 * either the empty-state CTA or the summary panels.
 *
 * Re-checks preferred_mode and bounces back if user is in seller
 * mode (no redirect loop — seller bounces here only when mode='buyer').
 */
export default async function BuyerLandingPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const mode = await getUserMode(session.user.id);
  if (mode === "seller") redirect("/dashboard");

  const wallets = await listWallets(session.user.id);
  const displayName = session.user.name ?? session.user.email ?? "";

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[{ label: "Buyer" }]}
        right={
          <div className="flex items-center gap-4">
            <ModeToggle current="buyer" />
            <nav className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
              <a href="/dashboard/buyer/payments" className="hover:text-foreground">
                Payments
              </a>
              <a href="/dashboard/buyer/wallets" className="hover:text-foreground">
                Wallets
              </a>
              <a href="/dashboard/buyer/agent-keys" className="hover:text-foreground">
                Agent keys
              </a>
              <a href="/dashboard/buyer/limits" className="hover:text-foreground">
                Limits
              </a>
            </nav>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {displayName}
            </span>
            <SignOutButton />
          </div>
        }
      />

      <section className="container space-y-6 py-10">
        <div>
          <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
            Spend overview
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Aggregate of every settled x402 payment from your registered
            wallets. Refreshes every 30 seconds.
          </p>
        </div>
        <BuyerOverview hasWallets={wallets.length > 0} />
      </section>
    </main>
  );
}

function SignOutButton(): React.JSX.Element {
  return (
    <form
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/" });
      }}
    >
      <button
        type="submit"
        className="text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        Sign out
      </button>
    </form>
  );
}
