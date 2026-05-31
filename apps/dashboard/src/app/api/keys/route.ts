import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminEmail } from "@/lib/admin";
import { auth } from "@/lib/auth";
import {
  CREATE_COOLDOWN_MS,
  MAX_KEYS_PER_USER,
  checkCreateKeyRateLimit,
  createResourceKey,
  listLinkedKeysWithLabel,
} from "@/lib/queries";

/**
 * GET /api/keys
 *
 * Returns the current user's linked keys with metadata (label,
 * created_at, last_used_at, is_active). Used by the dashboard's
 * key-management panel.
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const keys = await listLinkedKeysWithLabel(session.user.id);
  return NextResponse.json({
    keys,
    limits: {
      maxKeysPerUser: MAX_KEYS_PER_USER,
      createCooldownMs: CREATE_COOLDOWN_MS,
    },
  });
}

/**
 * POST /api/keys
 * Body: { label: string }
 *
 * Generates a fresh resource API key, hashes it, inserts into
 * resource_api_keys, links to the dashboard user. Rate-limited:
 *   - ≤ 5 active keys per user
 *   - ≤ 1 new key per hour
 *
 * Returns the plaintext EXACTLY ONCE. The dashboard UI surfaces it
 * with a copy-to-clipboard + "you cannot see this again" warning;
 * once the response leaves this handler, the plaintext is gone.
 */
const CreateBodySchema = z.object({
  label: z
    .string()
    .min(1, "label is required")
    .max(80, "label must be 80 characters or fewer")
    .trim()
    .refine((s) => s.length > 0, "label is required"),
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
  const parsed = CreateBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  // Admin emails (ADMIN_EMAILS allowlist) bypass both the per-user
  // cap and the per-hour cooldown — operator-side tooling needs to
  // churn through keys without waiting.
  const bypass = isAdminEmail(session.user.email);

  // Rate limit BEFORE generating any secret — the order matters
  // because the only way to fail later is a DB write error, and
  // returning "rate-limited" after we already minted a plaintext
  // would surface a wasted secret if the user retried.
  const limit = bypass
    ? ({ ok: true } as const)
    : await checkCreateKeyRateLimit(session.user.id);
  if (!limit.ok) {
    const message =
      limit.reason === "max-keys-reached"
        ? `You already have ${limit.activeKeys} active keys (limit ${MAX_KEYS_PER_USER}). Revoke one before creating another.`
        : `You can only create one key per hour. Try again at ${limit.cooldownEndsAt}.`;
    return NextResponse.json(
      {
        error: message,
        reason: limit.reason,
        activeKeys: limit.activeKeys,
        cooldownEndsAt: limit.cooldownEndsAt,
      },
      { status: 429 },
    );
  }

  const created = await createResourceKey({
    userId: session.user.id,
    label: parsed.data.label,
  });

  return NextResponse.json(
    {
      resourceKeyId: created.resourceKeyId,
      plaintext: created.plaintext,
      label: created.label,
      createdAt: created.createdAt,
    },
    { status: 201 },
  );
}
