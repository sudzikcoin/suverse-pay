import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getPool } from "@/lib/db";
import {
  KNOWN_EVENT_TYPES,
  createWebhookEndpoint,
  listEndpointsForUser,
  type WebhookEventType,
} from "@suverse-pay/webhooks";

const CreateBodySchema = z.object({
  url: z.string().url("URL must be a valid http(s) URL"),
  description: z.string().max(200).optional(),
  events: z.array(z.enum(KNOWN_EVENT_TYPES as readonly [WebhookEventType, ...WebhookEventType[]])).min(1).optional(),
});

interface PublicEndpoint {
  id: string;
  url: string;
  description: string;
  events: ReadonlyArray<WebhookEventType>;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

function toPublic(row: {
  id: string;
  url: string;
  description: string;
  events: ReadonlyArray<WebhookEventType>;
  isActive: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}): PublicEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * GET /api/webhooks
 *
 * Returns the current user's webhook endpoints. The signing secret
 * is intentionally OMITTED — it was shown once at create time and
 * is not safe to re-display in a list view (could be read off a
 * screenshot, shoulder-surfed, etc.).
 */
export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  const rows = await listEndpointsForUser({
    client: pool,
    dashboardUserId: session.user.id,
  });
  return NextResponse.json({ endpoints: rows.map(toPublic) });
}

/**
 * POST /api/webhooks
 * Body: { url, description?, events? }
 *
 * Creates a new endpoint. Returns the full endpoint plus the
 * plaintext signing secret EXACTLY ONCE. Subsequent reads do NOT
 * include the secret — customer must re-create the endpoint to get
 * a new one (intentional friction; matches Stripe / other webhook
 * providers' policy).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid request" },
      { status: 400 },
    );
  }
  const pool = getPool();
  try {
    const { row, secretPlaintext } = await createWebhookEndpoint({
      client: pool,
      dashboardUserId: session.user.id,
      url: parsed.data.url,
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description }
        : {}),
      ...(parsed.data.events !== undefined ? { events: parsed.data.events } : {}),
    });
    return NextResponse.json(
      {
        ...toPublic(row),
        secret: secretPlaintext,
      },
      { status: 201 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "create failed" },
      { status: 400 },
    );
  }
}
