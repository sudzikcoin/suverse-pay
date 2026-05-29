/**
 * NextAuth.js redirects unauthenticated users (and OAuth error
 * recovery) to /login per the `pages.signIn` config in lib/auth.ts.
 * We share the same screen as the root page — keeps one set of
 * sign-in affordances and one design.
 */
export { default } from "../page";
