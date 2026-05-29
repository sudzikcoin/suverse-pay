import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { linkResourceKey, listLinkedKeysWithLabel } from "@/lib/queries";

/**
 * POST /api/link-key
 * Body: { resourceKey: "<plaintext>" }
 *
 * Validates the key against resource_api_keys.key_hash (sha256 hex)
 * and creates a dashboard_user_resource_keys link row. Returns the
 * matched key id + label so the UI can show "Linked <label>".
 *
 * Generic 404 on unknown keys — never confirm "key exists but is
 * inactive" vs "key not found" (would let attackers enumerate
 * valid keys).
 */
const BodySchema = z.object({
  resourceKey: z.string().min(8).max(256),
});

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const result = await linkResourceKey({
    userId: session.user.id,
    plaintext: parsed.data.resourceKey,
  });
  if (result === null) {
    return NextResponse.json(
      { error: "unknown or inactive resource key" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    resourceKeyId: result.resourceKeyId,
    label: result.label,
    alreadyLinked: result.alreadyLinked,
  });
}

/** GET /api/link-key returns the current user's linked keys + labels. */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const keys = await listLinkedKeysWithLabel(session.user.id);
  return NextResponse.json({ keys });
}
