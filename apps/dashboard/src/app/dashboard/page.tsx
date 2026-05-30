import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { ApiKeyLinker } from "@/components/panels/api-key-linker";
import { dbQuery } from "@/lib/db";
import { DashboardView } from "./view";

interface LinkedKey {
  resource_key_id: string;
  label: string;
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

  const linkedKeys = await dbQuery<LinkedKey>(
    `
    SELECT k.id AS resource_key_id, k.label
    FROM dashboard_user_resource_keys l
    JOIN resource_api_keys k ON k.id = l.resource_key_id
    WHERE l.user_id = $1 AND k.is_active
    ORDER BY l.linked_at DESC
    `,
    [session.user.id],
  );

  const displayName = session.user.name ?? session.user.email ?? "";
  const avatarUrl = session.user.image ?? null;

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[{ label: "Dashboard" }]}
        right={
          <div className="flex items-center gap-4">
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

      <section className="container py-10">
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
