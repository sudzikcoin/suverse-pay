/**
 * Pure profile-extraction helpers for the NextAuth signIn callback.
 *
 * Split out from auth.ts so we can unit-test the mapping from
 * provider-shaped profile objects to our internal column set without
 * spinning up NextAuth's machinery.
 *
 * Google and GitHub return very different `profile` shapes; the
 * provider strings ("google" / "github") select the extractor.
 */

export type Provider = "google" | "github";

export interface ExtractedProfile {
  /** GitHub `login`. NULL for Google. */
  githubUsername: string | null;
  /** Provider-asserted email verification. NULL when unknown. */
  emailVerified: boolean | null;
  /** BCP-47 (Google `locale`). NULL for GitHub (no field). */
  locale: string | null;
  /** Provider profile URL (GitHub `html_url`). NULL for Google. */
  profileUrl: string | null;
  /** GitHub `company`. NULL for Google. */
  company: string | null;
  /** GitHub `bio`. NULL for Google. */
  bio: string | null;
  /** GitHub `location`. NULL for Google. */
  location: string | null;
}

interface GoogleProfile {
  email_verified?: boolean;
  locale?: string;
}

interface GitHubProfile {
  login?: string;
  html_url?: string;
  company?: string | null;
  bio?: string | null;
  location?: string | null;
  // GitHub's userinfo doesn't carry verification on the primary
  // profile object; the dedicated /user/emails endpoint does. We
  // treat absence as "unknown" rather than guessing false.
}

/**
 * Map a raw OAuth profile object to the columns we persist.
 *
 * Unknown providers return all-nulls — callers should guard before
 * calling, but defaulting to nulls avoids accidentally tripping a
 * NOT NULL constraint if a new provider is added later.
 */
export function extractProfile(
  provider: Provider,
  profile: unknown,
): ExtractedProfile {
  const empty: ExtractedProfile = {
    githubUsername: null,
    emailVerified: null,
    locale: null,
    profileUrl: null,
    company: null,
    bio: null,
    location: null,
  };
  if (!profile || typeof profile !== "object") return empty;

  if (provider === "google") {
    const p = profile as GoogleProfile;
    return {
      ...empty,
      emailVerified: typeof p.email_verified === "boolean"
        ? p.email_verified
        : null,
      locale: typeof p.locale === "string" && p.locale.length > 0
        ? p.locale
        : null,
    };
  }

  if (provider === "github") {
    const p = profile as GitHubProfile;
    return {
      ...empty,
      githubUsername: typeof p.login === "string" && p.login.length > 0
        ? p.login
        : null,
      profileUrl: typeof p.html_url === "string" && p.html_url.length > 0
        ? p.html_url
        : null,
      company: typeof p.company === "string" && p.company.length > 0
        ? p.company
        : null,
      bio: typeof p.bio === "string" && p.bio.length > 0 ? p.bio : null,
      location: typeof p.location === "string" && p.location.length > 0
        ? p.location
        : null,
    };
  }

  return empty;
}
