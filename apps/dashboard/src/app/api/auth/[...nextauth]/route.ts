import { handlers } from "@/lib/auth";

/**
 * NextAuth.js v5 catch-all route. Routes /api/auth/* (sign-in,
 * callbacks, sign-out, session, csrf, providers) through the
 * library handlers configured in src/lib/auth.ts.
 */
export const { GET, POST } = handlers;
