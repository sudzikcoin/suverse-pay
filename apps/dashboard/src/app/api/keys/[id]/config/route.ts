import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { NETWORKS_CATALOG } from "@/lib/networks-catalog";
import {
  ConfigInputSchema,
  findOwnedResourceKey,
  getConfig,
  upsertConfig,
  validateConfig,
} from "@/lib/seller-config";

/**
 * GET /api/keys/:id/config
 *
 * Returns the seller config for an owned key plus the catalog of
 * networks the dashboard knows about (so the picker doesn't need a
 * second round-trip). Returns `config: null` when the key has never
 * been configured — the UI shows the empty state without an extra
 * 404 dance.
 *
 * Cross-tenant guard: every read of resource_api_keys is gated
 * through findOwnedResourceKey, which JOINs the link table. A
 * request for a stranger's key returns 404, never confirms existence.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!/^reskey_[0-9a-f]+$/.test(id)) {
    return NextResponse.json({ error: "invalid key id format" }, { status: 400 });
  }
  const owned = await findOwnedResourceKey({
    userId: session.user.id,
    resourceKeyId: id,
  });
  if (!owned) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const config = await getConfig(id);
  return NextResponse.json({
    key: { id: owned.id, label: owned.label },
    config,
    networksCatalog: NETWORKS_CATALOG,
  });
}

/**
 * PUT /api/keys/:id/config
 *
 * Upsert the seller's configuration. Body is Zod-validated for shape
 * + range; cross-field validation (e.g. "payToEvm required when an
 * eip155:* network is selected") is in `validateConfig` and the
 * response includes per-field error rows the UI can map back to
 * input components.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!/^reskey_[0-9a-f]+$/.test(id)) {
    return NextResponse.json({ error: "invalid key id format" }, { status: 400 });
  }
  const owned = await findOwnedResourceKey({
    userId: session.user.id,
    resourceKeyId: id,
  });
  if (!owned) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = ConfigInputSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      {
        error: first?.message ?? "invalid body",
        field: first?.path.join(".") ?? null,
      },
      { status: 400 },
    );
  }
  const crossFieldErrors = validateConfig(parsed.data);
  if (crossFieldErrors.length > 0) {
    return NextResponse.json(
      { error: crossFieldErrors[0]!.message, fieldErrors: crossFieldErrors },
      { status: 400 },
    );
  }

  const config = await upsertConfig({
    resourceKeyId: id,
    input: parsed.data,
  });
  return NextResponse.json({ config });
}
