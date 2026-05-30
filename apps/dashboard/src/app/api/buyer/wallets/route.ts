import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { addWallet, listWallets } from "@/lib/buyer";

const NetworkFamily = z.enum(["evm", "solana", "cosmos", "tron"]);
const Body = z.object({
  networkFamily: NetworkFamily,
  address: z.string().min(20).max(80),
  label: z.string().max(80).optional(),
});

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const wallets = await listWallets(session.user.id);
  return NextResponse.json({ wallets });
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
    const result = await addWallet(session.user.id, parsed.data);
    if (result === null) {
      return NextResponse.json(
        { error: "already_linked" },
        { status: 409 },
      );
    }
    return NextResponse.json({ id: result.id }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("invalid_address:")) {
      return NextResponse.json(
        { error: "invalid_address", message: msg.slice("invalid_address:".length) },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
