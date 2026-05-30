/**
 * Pure helpers that drive the "is this listing auto-approved?"
 * decision tree. Kept out of catalog-store.ts so we can unit-test
 * the policy without a database.
 *
 * Decision matrix:
 *
 *   linkResourceKey?  | userOwnsKey? | tier
 *   ------------------+--------------+----------------------------
 *   present + valid   | yes          | verified + approved
 *   present + valid   | no           | external  + pending
 *   absent            | n/a          | external  + pending
 *
 * Anonymous submissions skip this entirely — they're always pending
 * regardless of the body (no session to own a key against).
 */

export interface ModerationDecision {
  isVerified: boolean;
  status: "pending" | "approved";
}

export function decideAuthenticatedTier(args: {
  hasResourceKeyLink: boolean;
  userOwnsKey: boolean;
}): ModerationDecision {
  if (args.hasResourceKeyLink && args.userOwnsKey) {
    return { isVerified: true, status: "approved" };
  }
  return { isVerified: false, status: "pending" };
}

/**
 * Anonymous submissions are always pending. Exposed as a function
 * (rather than a constant) for callsite symmetry with
 * decideAuthenticatedTier above.
 */
export function decideAnonymousTier(): ModerationDecision {
  return { isVerified: false, status: "pending" };
}

/**
 * Console-logs the verification link a user would have received by
 * email. Returns the link so tests can assert against it. Real SMTP
 * is deferred to a follow-up sub-task; this keeps the flow E2E-able
 * (operator pulls the link from the journalctl log).
 */
export function logVerificationLink(args: {
  baseUrl: string;
  token: string;
  email: string;
}): string {
  const url = `${args.baseUrl.replace(/\/$/, "")}/catalog/verify?token=${encodeURIComponent(args.token)}`;
  // Stderr-ish stream so it stands out from request logs. Using
  // process.stdout to match the existing dashboard tool patterns
  // (see auth.ts upsertDashboardUser flow).
  process.stdout.write(
    `[catalog] verification link for ${args.email}: ${url}\n`,
  );
  return url;
}
