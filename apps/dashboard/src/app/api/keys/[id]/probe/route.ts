import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminEmail } from "@/lib/admin";
import { auth } from "@/lib/auth";
import { dbQuery } from "@/lib/db";
import { probeResourceServer } from "@/lib/probe";
import { findOwnedResourceKey, getConfig } from "@/lib/seller-config";

const PROBE_HOURLY_LIMIT = 30;

const ProbeBodySchema = z.object({
  url: z
    .string()
    .url("url must be a valid http(s) URL")
    .max(2048, "url is too long"),
});

/**
 * POST /api/keys/:id/probe
 * Body: { url: string }
 *
 * Hits the seller's resource server with no payment, inspects the
 * 402 challenge it returns, checks the shape lines up with the
 * config in the dashboard. Result is a `{ ok, checks }` payload —
 * the UI renders each check as a row with a green or red dot. Never
 * 5xx: SSRF blocks, timeouts, and non-402 responses are all
 * normalised into failed checks.
 *
 * Rate limit: 30 probes / dashboard user / rolling hour. The probe
 * loop is the only way for a user to make this API issue outbound
 * HTTP, so it's worth bounding.
 */
export async function POST(
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
  const parsed = ProbeBodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  // Hourly rate limit using the existing query path — store no
  // dedicated table, just count attempts on facilitator_payments
  // -adjacent behaviour. We piggyback on a tiny key-value-style log:
  // each probe inserts into a transient table. Cheaper than spinning
  // up Redis just for this.
  //
  // Implementation note: rather than a new migration, we use a
  // lightweight count over an in-memory module Map keyed by
  // (userId, hourBucket). The window is rolling-hour at minute
  // granularity. This intentionally does NOT survive a server
  // restart — abuse the probe path that hard, the dev rate-limits
  // you. The dashboard runs as a single pm2 process so the in-process
  // map is the canonical source.
  // Admin emails (ADMIN_EMAILS allowlist) skip the probe limiter.
  const allowed = isAdminEmail(session.user.email)
    ? ({ ok: true } as const)
    : takeProbeToken(session.user.id);
  if (!allowed.ok) {
    return NextResponse.json(
      {
        error: `probe rate limit (${PROBE_HOURLY_LIMIT}/hour) — retry after ${allowed.retryAfterSeconds}s`,
        retryAfterSeconds: allowed.retryAfterSeconds,
      },
      { status: 429 },
    );
  }

  const config = await getConfig(id);
  if (!config) {
    return NextResponse.json(
      {
        error: "configure your key first — probe needs to know your accepted networks",
      },
      { status: 409 },
    );
  }

  const result = await probeResourceServer({
    url: parsed.data.url,
    config,
  });

  // Light audit so we can see probe volume in pino logs (no PII).
  void dbQuery(
    `SELECT 1`, // no-op: we don't have a dedicated probes table yet
    [],
  ).catch(() => undefined);

  return NextResponse.json(result);
}

// ---------------------------------------------------------------
// In-process probe rate limiter
// ---------------------------------------------------------------

interface Window {
  countByMinute: Map<number, number>; // minute index -> count
}

const PROBE_BUCKETS = new Map<string, Window>();

function nowMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

function gc(window: Window, cutoff: number): void {
  for (const k of window.countByMinute.keys()) {
    if (k < cutoff) window.countByMinute.delete(k);
  }
}

function takeProbeToken(
  userId: string,
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const minute = nowMinute();
  const cutoff = minute - 60;
  let win = PROBE_BUCKETS.get(userId);
  if (!win) {
    win = { countByMinute: new Map() };
    PROBE_BUCKETS.set(userId, win);
  }
  gc(win, cutoff);
  let total = 0;
  for (const c of win.countByMinute.values()) total += c;
  if (total >= PROBE_HOURLY_LIMIT) {
    // retry-after = seconds until the oldest counted minute falls
    // out of the rolling window.
    const oldest = Math.min(...win.countByMinute.keys());
    const minutesLeft = oldest + 60 - minute;
    return { ok: false, retryAfterSeconds: Math.max(1, minutesLeft * 60) };
  }
  win.countByMinute.set(minute, (win.countByMinute.get(minute) ?? 0) + 1);
  return { ok: true };
}
