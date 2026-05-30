import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { NETWORKS_CATALOG, type NetworkEntry } from "@/lib/networks-catalog";
import {
  findOwnedResourceKey,
  getConfig,
  type ResourceServerConfig,
} from "@/lib/seller-config";
import { ConfigureView } from "./view";

const FACILITATOR_URL =
  process.env.SUVERSE_PAY_FACILITATOR_URL ?? "https://facilitator.suverse.io";

/**
 * /dashboard/keys/[id]/configure
 *
 * Server-only entry. Verifies the session, JOINs through the link
 * table to confirm the key belongs to this user, loads any existing
 * config, and hands the prepared state to the client view.
 *
 * Returns 404 (via `notFound()`) on every "key not yours / not
 * found" path to avoid leaking key id existence.
 */
export default async function ConfigureKeyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  const { id } = await params;
  if (!/^reskey_[0-9a-f]+$/.test(id)) {
    notFound();
  }
  const owned = await findOwnedResourceKey({
    userId: session.user.id,
    resourceKeyId: id,
  });
  if (!owned) {
    notFound();
  }
  const config: ResourceServerConfig | null = await getConfig(id);
  const catalog: NetworkEntry[] = [...NETWORKS_CATALOG];
  return (
    <main className="min-h-screen">
      <ConfigureView
        keyId={owned.id}
        keyLabel={owned.label}
        initialConfig={config}
        networksCatalog={catalog}
        facilitatorUrl={FACILITATOR_URL}
      />
    </main>
  );
}
