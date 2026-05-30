import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { ModeToggle } from "@/components/layout/mode-toggle";
import { getUserMode } from "@/lib/buyer";

/**
 * Buyer dashboard landing. Renders an empty "coming soon" shell in
 * this commit — the full overview lands in 17.4. The route exists
 * now so the mode toggle's redirect target is real, not a 404.
 *
 * Like the seller landing, this page re-checks preferred_mode and
 * bounces back if the user has been flipped to seller (no redirect
 * loop because seller bounces here only when mode='buyer').
 */
export default async function BuyerLandingPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const mode = await getUserMode(session.user.id);
  if (mode === "seller") redirect("/dashboard");

  const displayName = session.user.name ?? session.user.email ?? "";

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[{ label: "Buyer" }]}
        right={
          <div className="flex items-center gap-4">
            <ModeToggle current="buyer" />
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {displayName}
            </span>
            <SignOutButton />
          </div>
        }
      />

      <section className="container py-10">
        <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
          Buyer dashboard
        </h1>
        <p className="mt-2 max-w-xl text-sm text-muted-foreground">
          Track what your agents are spending across x402 APIs. Register
          a wallet to start seeing purchases here — overview, spend
          breakdowns, and CSV export land over the next few commits.
        </p>
        <p className="mt-6 rounded-md border border-dashed border-border bg-card/30 p-6 text-sm text-muted-foreground">
          Coming next: spend summary cards, per-endpoint breakdown,
          paginated purchase log, wallet registration, spending limits,
          and agent API keys.
        </p>
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
