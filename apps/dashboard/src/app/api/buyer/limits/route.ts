import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createLimit, listLimits } from "@/lib/buyer";

const Body = z.object({
  scope: z.enum(["user", "agent_key", "endpoint"]),
  scopeId: z.string().nullable(),
  period: z.enum(["day", "week", "month"]),
  maxAtomicUsd: z.string().regex(/^\d+$/),
  notifyEmail: z.boolean().optional(),
  autoPause: z.boolean().optional(),
});

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const limits = await listLimits(session.user.id);
  return NextResponse.json({ limits });
}

export async function POST(req: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  try {
    const result = await createLimit({
      userId: session.user.id,
      scope: parsed.data.scope,
      scopeId: parsed.data.scopeId,
      period: parsed.data.period,
      maxAtomicUsd: parsed.data.maxAtomicUsd,
      notifyEmail: parsed.data.notifyEmail ?? true,
      autoPause: parsed.data.autoPause ?? false,
    });
    if (result === null) {
      return NextResponse.json(
        { error: "duplicate", message: "A limit with this scope+period already exists." },
        { status: 409 },
      );
    }
    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}
