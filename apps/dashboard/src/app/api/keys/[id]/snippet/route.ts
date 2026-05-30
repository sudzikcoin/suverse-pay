import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { findOwnedResourceKey, getConfig } from "@/lib/seller-config";
import {
  isFramework,
  renderSnippet,
  SUPPORTED_FRAMEWORKS,
} from "@/lib/snippet-templates";

const FACILITATOR_URL =
  process.env.SUVERSE_PAY_FACILITATOR_URL ?? "https://facilitator.suverse.io";

/**
 * GET /api/keys/:id/snippet?framework=express|fastapi|fastify
 *
 * Renders a working integration snippet using the seller's actual
 * config values. Server-side render only — the templates are pure
 * functions in src/lib/snippet-templates, easy to snapshot-test.
 *
 * Plaintext API key is NEVER inlined — we don't store it. The
 * snippet refers to `process.env.SUVERSE_PAY_API_KEY` (or the Python
 * equivalent) and the response includes a `envVars` block the UI
 * can offer as a separate Copy button.
 */
export async function GET(
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

  const url = new URL(request.url);
  const frameworkParam = url.searchParams.get("framework") ?? "express";
  if (!isFramework(frameworkParam)) {
    return NextResponse.json(
      {
        error: `unknown framework — supported: ${SUPPORTED_FRAMEWORKS.join(", ")}`,
      },
      { status: 400 },
    );
  }

  const config = await getConfig(id);
  if (!config) {
    return NextResponse.json(
      { error: "configure your key first" },
      { status: 409 },
    );
  }
  if (config.acceptedNetworks.length === 0) {
    return NextResponse.json(
      {
        error:
          "select at least one accepted network in your config before generating a snippet",
      },
      { status: 409 },
    );
  }

  const snippet = renderSnippet({
    framework: frameworkParam,
    keyId: id,
    facilitatorUrl: FACILITATOR_URL,
    config,
  });
  return NextResponse.json({ snippet });
}
