import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ANON_SUBMIT_LIMIT_PER_DAY,
  CreateListingSchema,
  countAnonymousSubmissionsLast24h,
  createExternalSubmission,
  insertListing,
} from "@/lib/catalog-store";
import {
  decideAnonymousTier,
  logVerificationLink,
} from "@/lib/catalog-moderation";

/**
 * POST /api/catalog/public-submit
 *
 * Anonymous (no session). Creates a pending listing + an external
 * verification row, then logs a verification link to stdout. The
 * listing stays pending even after email verification — admin
 * moderation is a separate step (deferred to a follow-up sub-task).
 *
 * Rate limit: 3 submissions per IP per 24h. Cheap defence; not
 * a CAPTCHA replacement. The IP comes from `x-forwarded-for`
 * (nginx) and is stored on the listing row purely as an opaque
 * limit key.
 */
const PublicSubmitSchema = CreateListingSchema.extend({
  email: z.string().email("valid email required"),
}).omit({ linkResourceKey: true });

export async function POST(request: Request): Promise<NextResponse> {
  const ip = extractIp(request);

  // Anonymous rate-limit: must be checked BEFORE any DB write so a
  // flood doesn't fill the table. Falls open (IP null → no limit)
  // because a missing XFF in production would be a misconfigured
  // proxy, and silently dropping requests would be worse than the
  // abuse window we'd plug.
  if (ip !== null) {
    const recent = await countAnonymousSubmissionsLast24h(ip);
    if (recent >= ANON_SUBMIT_LIMIT_PER_DAY) {
      return NextResponse.json(
        {
          error: `Rate limit: max ${ANON_SUBMIT_LIMIT_PER_DAY} anonymous submissions per IP per day. Sign in to bypass.`,
        },
        { status: 429 },
      );
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const parsed = PublicSubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }
  const decision = decideAnonymousTier();
  // CreateListingSchema doesn't include `email`, so strip it.
  const { email, ...listingInput } = parsed.data;

  const listing = await insertListing({
    input: listingInput,
    submittedByUserId: null,
    submittedEmail: email,
    submissionIp: ip,
    isVerified: decision.isVerified,
    status: decision.status,
  });
  const verification = await createExternalSubmission({
    listingId: listing.id,
    email,
  });
  const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3002";
  logVerificationLink({
    baseUrl,
    token: verification.verificationToken,
    email,
  });

  return NextResponse.json(
    {
      listing,
      verification: {
        email,
        expiresAt: verification.expiresAt,
        // Token NOT returned in the response — it'd defeat the
        // email-verification step. Tests that need it should read
        // it from the DB (or assert against the stdout log).
      },
    },
    { status: 201 },
  );
}

function extractIp(request: Request): string | null {
  const xff = request.headers.get("x-forwarded-for");
  if (xff !== null && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return request.headers.get("x-real-ip") ?? null;
}
