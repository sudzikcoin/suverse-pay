import { notFound, redirect } from "next/navigation";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { ProxyDetailView } from "./view";
import { auth } from "@/lib/auth";
import { getOwnedProxy } from "@/lib/proxy-config-store";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ProxyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const proxy = await getOwnedProxy({ userId: session.user.id, proxyId: id });
  if (!proxy) notFound();
  const proxyBase =
    process.env["NEXT_PUBLIC_PROXY_BASE_URL"] ?? "https://proxy.suverse.io";
  return (
    <main className="min-h-screen">
      <DashboardHeader
        breadcrumb={[
          { label: "Dashboard", href: "/dashboard" },
          { label: "Proxies", href: "/dashboard/proxies" },
          { label: proxy.displayName ?? proxy.endpointSlug },
        ]}
      />
      <section className="container max-w-5xl py-10">
        <ProxyDetailView proxy={proxy} proxyBase={proxyBase} />
      </section>
    </main>
  );
}
