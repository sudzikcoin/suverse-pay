import { redirect } from "next/navigation";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { NewProxyForm } from "./form";
import { auth } from "@/lib/auth";
import { NETWORKS_CATALOG } from "@/lib/networks-catalog";
import { listLinkedKeysWithLabel } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function NewProxyPage(): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const keys = (await listLinkedKeysWithLabel(session.user.id))
    .filter((k) => k.isActive)
    .map((k) => ({ resourceKeyId: k.resourceKeyId, label: k.label }));

  // No active keys → bounce back; the proxy can't exist without one.
  if (keys.length === 0) {
    redirect("/dashboard");
  }

  const proxyBase =
    process.env["NEXT_PUBLIC_PROXY_BASE_URL"] ?? "https://proxy.suverse.io";

  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Proxies", href: "/dashboard/proxies" },
          { label: "New" },
        ]}
      />

      <section className="container max-w-3xl py-10">
        <div className="mb-8">
          <h1 className="font-display text-2xl font-medium leading-tight sm:text-3xl">
            New API proxy
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Once saved, requests to{" "}
            <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">
              {proxyBase}/v1/proxy/&lt;key&gt;/&lt;slug&gt;
            </code>{" "}
            return a 402 challenge. After payment we forward the request
            to your upstream URL with the headers you set here.
          </p>
        </div>

        <NewProxyForm
          ownedKeys={keys}
          networksCatalog={[...NETWORKS_CATALOG]}
          proxyBase={proxyBase}
        />
      </section>
    </main>
  );
}
