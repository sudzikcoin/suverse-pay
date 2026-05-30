import Link from "next/link";
import { verifyExternalSubmission } from "@/lib/catalog-store";

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Email-verification landing page. Linked from the verification
 * email (logged to stdout for v1 — see catalog-moderation.ts).
 * Confirms verification synchronously then renders an outcome
 * panel. The listing remains 'pending' until admin moderation.
 */
export default async function VerifyPage({
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  const { token } = await searchParams;

  let body: React.ReactNode;
  if (token === undefined || token.length === 0) {
    body = (
      <Outcome
        title="Missing token"
        tone="error"
        detail="The verification URL is malformed — the token query parameter is empty."
      />
    );
  } else {
    const result = await verifyExternalSubmission(token);
    if (!result.ok) {
      body = (
        <Outcome
          title={result.reason === "expired" ? "Link expired" : "Token not found"}
          tone="error"
          detail={
            result.reason === "expired"
              ? "This verification link is older than 7 days. Re-submit your listing to receive a fresh link."
              : "We couldn't match this token to a pending submission. It may have already been consumed or never existed."
          }
        />
      );
    } else if (result.reason === "already-verified") {
      body = (
        <Outcome
          title="Already verified"
          tone="success"
          detail="Your email was already confirmed for this listing. It'll appear in the public catalog once an admin approves it."
          listingId={result.listingId}
        />
      );
    } else {
      body = (
        <Outcome
          title="Email verified"
          tone="success"
          detail="Thanks — your submission is now in the moderation queue. We'll publish it shortly."
          listingId={result.listingId}
        />
      );
    }
  }

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

      <section className="container max-w-2xl py-16">{body}</section>
    </main>
  );
}

function Outcome({
  title,
  tone,
  detail,
  listingId,
}: {
  title: string;
  tone: "success" | "error";
  detail: string;
  listingId?: string;
}): React.JSX.Element {
  const accent =
    tone === "success"
      ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-300"
      : "border-destructive/40 bg-destructive/10 text-destructive";
  return (
    <div className={`rounded-lg border p-8 ${accent}`}>
      <p className="font-mono text-[10px] uppercase tracking-[0.3em]">
        {tone === "success" ? "Verification" : "Verification failed"}
      </p>
      <h1 className="mt-3 font-display text-2xl font-medium text-foreground">
        {title}
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-foreground/80">
        {detail}
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        {listingId !== undefined && (
          <Link
            href={`/catalog/${listingId}`}
            className="rounded-md border border-border bg-secondary px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-foreground hover:bg-secondary/70"
          >
            View listing
          </Link>
        )}
        <Link
          href="/catalog"
          className="rounded-md border border-border bg-transparent px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground hover:bg-secondary"
        >
          Back to catalog
        </Link>
      </div>
    </div>
  );
}
