import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/**
 * Root page. If the user is signed in → redirect to /dashboard.
 * If not → show the login screen. Both flows take one click.
 */
export default async function Home(): Promise<React.JSX.Element> {
  const session = await auth();
  if (session?.user?.id) {
    redirect("/dashboard");
  }
  return <LoginScreen />;
}

import { signIn } from "@/lib/auth";

function LoginScreen(): React.JSX.Element {
  return (
    <main className="relative flex min-h-screen items-center justify-center px-6">
      {/* Off-centre composition — the headline floats slightly to the
          right of centre, the login affordances sit beneath. No card
          chrome around them; the page is the layout. */}
      <div className="grid w-full max-w-5xl gap-12 md:grid-cols-2 md:items-center">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-amber-400">
            Suverse Pay
          </p>
          <h1 className="mt-6 font-display text-4xl font-medium leading-tight md:text-5xl">
            One dashboard for every chain you accept.
          </h1>
          <p className="mt-6 max-w-md text-base text-muted-foreground">
            Settles, volume, and success rate across x402, MPP, and t402 —
            18&nbsp;EVM mainnets, TRON, Solana, Cosmos, and seven more
            namespaces — in a single feed.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
            Sign in
          </p>
          <form
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/dashboard" });
            }}
          >
            <button
              type="submit"
              className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-md border border-border bg-card px-5 text-sm font-medium transition-colors hover:bg-secondary"
            >
              <GoogleIcon />
              Continue with Google
            </button>
          </form>

          <form
            action={async () => {
              "use server";
              await signIn("github", { redirectTo: "/dashboard" });
            }}
          >
            <button
              type="submit"
              className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-md border border-border bg-card px-5 text-sm font-medium transition-colors hover:bg-secondary"
            >
              <GitHubIcon />
              Continue with GitHub
            </button>
          </form>

          <p className="mt-2 text-xs text-muted-foreground">
            No passwords. We never see your provider credentials — the only
            thing we read is your email + display name.
          </p>
        </div>
      </div>

      <footer className="absolute inset-x-0 bottom-6 text-center text-xs text-muted-foreground">
        <a
          href="https://github.com/sudzikcoin/suverse-pay"
          className="hover:text-foreground"
          target="_blank"
          rel="noreferrer"
        >
          github.com/sudzikcoin/suverse-pay
        </a>
        <span className="px-2">·</span>
        <span>v0.5.0-alpha · Phase 5</span>
      </footer>
    </main>
  );
}

function GoogleIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M22 12.2c0-.7-.1-1.4-.2-2H12v3.9h5.6c-.2 1.3-1 2.4-2.1 3.1v2.6h3.4c2-1.8 3.1-4.5 3.1-7.6Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-1 .6-2.2 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.7v2.7C4.4 19.5 8 22 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.2 13.6c-.2-.6-.3-1.2-.3-1.8 0-.6.1-1.2.3-1.8V7.3H2.7C2 8.7 1.5 10.3 1.5 12s.5 3.3 1.2 4.7l3.5-3.1Z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.4c1.5 0 2.9.5 4 1.5l3-3C17.1 2.3 14.7 1.5 12 1.5 8 1.5 4.4 4 2.7 7.3l3.5 2.7c.8-2.5 3.1-4.6 5.8-4.6Z"
        fill="#EA4335"
      />
    </svg>
  );
}

function GitHubIcon(): React.JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.3c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.3 1.3-3.2-.1-.3-.5-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2.8.9 1.3 2 1.3 3.3 0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z" />
    </svg>
  );
}
