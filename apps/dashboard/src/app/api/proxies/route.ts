import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  createProxy,
  listProxies,
  ProxyConfigInputSchema,
  validateProxyConfig,
} from "@/lib/proxy-config-store";
import { findOwnedResourceKey } from "@/lib/seller-config";

/**
 * GET /api/proxies
 *
 * Returns every proxy config under any resource key linked to the
 * caller. Used by /dashboard/proxies.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const rows = await listProxies(session.user.id);
  return NextResponse.json({ proxies: rows });
}

/**
 * POST /api/proxies
 * Body: { resourceKeyId, ...ProxyConfigInput }
 *
 * Creates a new proxy under the given resource key. Verifies that
 * the key is linked to the caller (defence-in-depth — the form
 * already only lists the user's keys, but never trust the client).
 */
const CreateBody = z.object({
  resourceKeyId: z.string().min(1),
  config: ProxyConfigInputSchema,
});

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const owned = await findOwnedResourceKey({
    userId: session.user.id,
    resourceKeyId: parsed.data.resourceKeyId,
  });
  if (!owned) {
    return NextResponse.json(
      { error: "resource_key_not_owned" },
      { status: 404 },
    );
  }
  const crossField = validateProxyConfig(parsed.data.config);
  if (crossField.length > 0) {
    return NextResponse.json(
      { error: "validation_failed", details: crossField },
      { status: 400 },
    );
  }
  try {
    const created = await createProxy({
      resourceKeyId: parsed.data.resourceKeyId,
      input: parsed.data.config,
    });
    return NextResponse.json({ proxy: created }, { status: 201 });
  } catch (err: unknown) {
    // 23505 = unique_violation (slug already used for this key).
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "23505") {
      return NextResponse.json(
        {
          error: "slug_taken",
          message:
            "another proxy under this key already uses that slug — pick a different one",
        },
        { status: 409 },
      );
    }
    throw err;
  }
}
