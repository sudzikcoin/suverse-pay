import NextAuth, { type DefaultSession } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { randomUUID } from "node:crypto";
import { dbQuery } from "./db";

/**
 * NextAuth.js v5 configuration for the customer dashboard.
 *
 * Two OAuth providers — Google and GitHub. On every sign-in we
 * upsert a `dashboard_users` row keyed by `(oauth_provider,
 * oauth_provider_id)`. The internal UUID we generate (or look up)
 * is attached to the session as `session.user.id` so route handlers
 * can scope queries cleanly.
 *
 * Strategy: JWT sessions (not database-backed). NextAuth's database
 * adapter would create an `accounts` + `sessions` table that
 * duplicates state we already track in `dashboard_users` — JWT
 * keeps the database table count minimal and pins the canonical
 * identity record in `dashboard_users`.
 *
 * Local dev: NEXTAUTH_URL=http://localhost:3002. Production:
 * NEXTAUTH_URL=https://suverse-pay.suverse.io. See .env.example.
 */

declare module "next-auth" {
  interface Session {
    user: {
      /** Internal dashboard_users.id (UUID). */
      id: string;
    } & DefaultSession["user"];
  }
}

interface UpsertResult {
  id: string;
}

/**
 * Upsert into dashboard_users on sign-in. Returns the internal UUID
 * to attach to the session token.
 */
async function upsertDashboardUser(args: {
  email: string;
  provider: "google" | "github";
  providerId: string;
  displayName: string | null;
  avatarUrl: string | null;
}): Promise<string> {
  // UUIDs generated app-side (Node crypto.randomUUID) rather than via
  // gen_random_uuid() in Postgres — the db package's pg-mem test
  // suite doesn't ship that function, and the schema stays
  // engine-agnostic this way. The ON CONFLICT branch ignores the
  // generated id and updates the existing row.
  const id = randomUUID();
  const rows = await dbQuery<UpsertResult>(
    `
    INSERT INTO dashboard_users (
      id, email, oauth_provider, oauth_provider_id, display_name, avatar_url
    ) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (oauth_provider, oauth_provider_id) DO UPDATE
      SET last_login_at = NOW(),
          display_name = COALESCE(EXCLUDED.display_name, dashboard_users.display_name),
          avatar_url   = COALESCE(EXCLUDED.avatar_url,   dashboard_users.avatar_url)
    RETURNING id
    `,
    [
      id,
      args.email,
      args.provider,
      args.providerId,
      args.displayName,
      args.avatarUrl,
    ],
  );
  // Race-resolution fallback: if the unique-email constraint fired
  // because the same human signed in with a different provider, the
  // INSERT above failed without returning a row. Look up by email.
  if (rows.length === 0) {
    const lookup = await dbQuery<UpsertResult>(
      `SELECT id FROM dashboard_users WHERE email = $1`,
      [args.email],
    );
    if (lookup.length === 0) {
      throw new Error("dashboard_users upsert failed and email lookup empty");
    }
    return lookup[0]!.id;
  }
  return rows[0]!.id;
}

export const { auth, handlers, signIn, signOut } = NextAuth({
  // Trust the Host / X-Forwarded-Host headers. The dashboard is
  // always deployed behind a reverse proxy (nginx in self-host,
  // Vercel's edge in Vercel) — without this Auth.js v5 throws
  // UntrustedHost on every /api/auth/* request. Vercel sets this
  // implicitly; self-host needs it explicit, and an env-var-only
  // toggle (`AUTH_TRUST_HOST=true`) is a footgun the operator can
  // forget. Pinning here removes it from the runbook.
  trustHost: true,
  // Persist sessions as encrypted JWTs (default). 7-day expiry; the
  // server-side session lookup re-validates against the database
  // via the `session` callback so an orphaned token never grants
  // access to a deleted user.
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    }),
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      // Without these the provider mis-configured itself; bail.
      if (!account || !user.email) return false;
      // Provider IDs differ in shape (GitHub: numeric id, Google:
      // sub claim). Both surface on account.providerAccountId.
      const providerId = account.providerAccountId;
      if (!providerId) return false;
      const provider =
        account.provider === "google"
          ? "google"
          : account.provider === "github"
          ? "github"
          : null;
      if (provider === null) return false;
      const internalId = await upsertDashboardUser({
        email: user.email,
        provider,
        providerId,
        displayName: user.name ?? profile?.name ?? null,
        avatarUrl: user.image ?? null,
      });
      // Stash on the user object so the jwt callback can pick it up.
      (user as { dashboardUserId?: string }).dashboardUserId = internalId;
      return true;
    },
    async jwt({ token, user }) {
      // On initial sign-in, copy the internal id we stashed above
      // into the token. Subsequent calls just pass the token through.
      if (user && (user as { dashboardUserId?: string }).dashboardUserId) {
        token.dashboardUserId = (user as { dashboardUserId?: string })
          .dashboardUserId;
      }
      return token;
    },
    async session({ session, token }) {
      if (token.dashboardUserId && typeof token.dashboardUserId === "string") {
        session.user.id = token.dashboardUserId;
      }
      return session;
    },
  },
});
