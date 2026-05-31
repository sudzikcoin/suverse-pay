import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { ModeToggle } from "@/components/layout/mode-toggle";
import { ApiKeyLinker } from "@/components/panels/api-key-linker";
import { ProgressTracker } from "@/components/onboarding/progress-tracker";
import { WelcomeModal } from "@/components/onboarding/welcome-modal";
import { dbQuery } from "@/lib/db";
import { getUserMode } from "@/lib/buyer";
import { DashboardView } from "./view";

interface LinkedKey {
  resource_key_id: string;
  label: string;
}

interface OnboardingRow {
  onboarding_dismissed_at: string | null;
}

interface ProxyCountRow {
  c: string;
}

interface SettleCountRow {
  c: string;
}

/**
 * Main dashboard server-component. Verifies session, loads the
 * user's linked-keys count, and renders one of two views:
 *   - 0 keys → ApiKeyLinker only
 *   - ≥1 key → the four-panel dashboard (delegated to ./view)
 *
 * Keeping the data-router logic on the server lets us avoid the
 * "show skeletons, fetch, then conditionally render" flicker.
 */
export default async function DashboardPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  // If the user last left in buyer mode, send them straight there.
  // The buyer page re-checks and bounces back if mode is 'seller', so
  // we don't get into a redirect loop.
  const mode = await getUserMode(session.user.id);
  if (mode === "buyer") redirect("/dashboard/buyer");

  const [linkedKeys, onboardingRows, proxyCountRows, settleCountRows] =
    await Promise.all([
      dbQuery<LinkedKey>(
        `
        SELECT k.id AS resource_key_id, k.label
        FROM dashboard_user_resource_keys l
        JOIN resource_api_keys k ON k.id = l.resource_key_id
        WHERE l.user_id = $1 AND k.is_active
        ORDER BY l.linked_at DESC
        `,
        [session.user.id],
      ),
      dbQuery<OnboardingRow>(
        `SELECT onboarding_dismissed_at FROM dashboard_users WHERE id = $1`,
        [session.user.id],
      ),
      dbQuery<ProxyCountRow>(
        `SELECT COUNT(*)::text AS c
           FROM seller_proxy_configs spc
           JOIN dashboard_user_resource_keys l
             ON l.resource_key_id = spc.resource_key_id
          WHERE l.user_id = $1`,
        [session.user.id],
      ),
      dbQuery<SettleCountRow>(
        `SELECT COUNT(*)::text AS c
           FROM facilitator_payments fp
           JOIN dashboard_user_resource_keys l
             ON l.resource_key_id = fp.resource_key_id
          WHERE l.user_id = $1 AND fp.status = 'settled'`,
        [session.user.id],
      ),
    ]);

  const displayName = session.user.name ?? session.user.email ?? "";
  const avatarUrl = session.user.image ?? null;
  const onboardingDismissedAt =
    onboardingRows[0]?.onboarding_dismissed_at ?? null;
  const progress = {
    hasKey: linkedKeys.length > 0,
    hasProxy: Number(proxyCountRows[0]?.c ?? "0") > 0,
    hasSettle: Number(settleCountRows[0]?.c ?? "0") > 0,
  };

  return (
    <main className="min-h-screen">
      <WelcomeModal initialDismissedAt={onboardingDismissedAt} />
      <DashboardHeader
        breadcrumb={[{ label: "Dashboard" }]}
        right={
          <div className="flex items-center gap-4">
            <ModeToggle current="seller" />
            <nav className="hidden items-center gap-3 text-xs text-muted-foreground sm:flex">
              <Link
                href="/dashboard/proxies"
                className="hover:text-foreground"
              >
                Proxies
              </Link>
              <Link
                href="/dashboard/catalog"
                className="hover:text-foreground"
              >
                Catalog
              </Link>
            </nav>
            <UserChip name={displayName} avatarUrl={avatarUrl} />
            <SignOutButton />
          </div>
        }
      />

      <section className="container space-y-6 py-10">
        <ProgressTracker progress={progress} />
        {linkedKeys.length === 0 ? (
          <ApiKeyLinker />
        ) : (
          <DashboardView linkedKeys={linkedKeys} />
        )}
      </section>
    </main>
  );
}

function UserChip({
  name,
  avatarUrl,
}: {
  name: string;
  avatarUrl: string | null;
}): React.JSX.Element {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border border-border bg-secondary text-xs font-medium uppercase">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={name} className="h-full w-full object-cover" />
        ) : (
          initials || "?"
        )}
      </div>
      <span className="hidden text-sm md:inline">{name}</span>
    </div>
  );
}

function SignOutButton(): React.JSX.Element {
  // Hidden on mobile — the same action lives in the MobileNavDrawer
  // footer, no need to crowd the header on narrow screens.
  return (
    <form
      className="hidden md:block"
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
