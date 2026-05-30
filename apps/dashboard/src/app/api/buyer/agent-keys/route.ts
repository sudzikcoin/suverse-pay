import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createAgentKey, listAgentKeys } from "@/lib/buyer";

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const keys = await listAgentKeys(session.user.id);
  return NextResponse.json({ keys });
}

const Body = z.object({ label: z.string().min(1).max(80) });

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
  const created = await createAgentKey({
    userId: session.user.id,
    label: parsed.data.label,
  });
  return NextResponse.json(created, { status: 201 });
}
