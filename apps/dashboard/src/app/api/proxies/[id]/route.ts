import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  deleteProxy,
  getOwnedProxy,
  ProxyConfigInputSchema,
  updateProxy,
  validateProxyConfig,
} from "@/lib/proxy-config-store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/proxies/[id] */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const proxy = await getOwnedProxy({
    userId: session.user.id,
    proxyId: id,
  });
  if (!proxy) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ proxy });
}

/**
 * PUT /api/proxies/[id]
 *
 * Body: partial ProxyConfigInput (slug is immutable — change it by
 * deleting and recreating).
 */
const PutBody = ProxyConfigInputSchema.omit({ endpointSlug: true }).partial();

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  // Cross-field check needs the merged view, so load current and
  // overlay the patch before validating.
  const current = await getOwnedProxy({
    userId: session.user.id,
    proxyId: id,
  });
  if (!current) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const merged = {
    endpointSlug: current.endpointSlug,
    originalUrl: parsed.data.originalUrl ?? current.originalUrl,
    originalMethod: parsed.data.originalMethod ?? current.originalMethod,
    displayName: parsed.data.displayName ?? current.displayName,
    description: parsed.data.description ?? current.description,
    priceAtomic: parsed.data.priceAtomic ?? current.priceAtomic,
    acceptedNetworks:
      parsed.data.acceptedNetworks ?? current.acceptedNetworks,
    payToEvm: parsed.data.payToEvm ?? current.payToEvm,
    payToSolana: parsed.data.payToSolana ?? current.payToSolana,
    payToCosmos: parsed.data.payToCosmos ?? current.payToCosmos,
    payToTron: parsed.data.payToTron ?? current.payToTron,
    isActive: parsed.data.isActive ?? current.isActive,
  };
  const crossField = validateProxyConfig(merged);
  if (crossField.length > 0) {
    return NextResponse.json(
      { error: "validation_failed", details: crossField },
      { status: 400 },
    );
  }
  const updated = await updateProxy({
    userId: session.user.id,
    proxyId: id,
    patch: parsed.data,
  });
  return NextResponse.json({ proxy: updated });
}

/** DELETE /api/proxies/[id] */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const ok = await deleteProxy({
    userId: session.user.id,
    proxyId: id,
  });
  if (!ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

// Silence unused import warning in some TS strict configs.
void z;
