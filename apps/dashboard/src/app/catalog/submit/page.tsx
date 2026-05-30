import Link from "next/link";
import { SubmissionForm } from "@/components/catalog/submission-form";

/**
 * Public anonymous submission page. Asks for an email + endpoint
 * details + verification link is logged server-side. The listing
 * stays pending until both (a) the verification link is clicked
 * and (b) an admin approves it.
 */
export default function PublicSubmitPage(): React.JSX.Element {
  return (
    <main className="min-h-screen">
      <header className="border-b border-border bg-card/40 backdrop-blur">
        <div className="container flex h-14 items-center justify-between">
          <Link
            href="/"
            className="font-mono text-xs uppercase tracking-[0.3em] text-amber-400"
          >
            Suverse Pay
          </Link>
          <Link
            href="/catalog"
            className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-foreground"
          >
            ← Catalog
          </Link>
        </div>
      </header>

      <section className="container max-w-3xl py-10">
        <div className="mb-8">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-amber-400">
            Submit a listing
          </p>
          <h1 className="mt-2 font-display text-3xl font-medium leading-tight sm:text-4xl">
            List your x402 endpoint
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            You don't need to use Suverse Pay as your facilitator —
            list anything that accepts payment over the x402 protocol.
            Verified listings (linked to a Suverse Pay resource key)
            publish instantly; others go through a moderation queue.
          </p>
          <p className="mt-3 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Prefer not to manage submissions anonymously?{" "}
            <Link
              href="/login"
              className="text-amber-300 underline-offset-4 hover:underline"
            >
              Sign in
            </Link>{" "}
            to manage your listings from the dashboard.
          </p>
        </div>

        <SubmissionForm mode="public" />
      </section>
    </main>
  );
}
