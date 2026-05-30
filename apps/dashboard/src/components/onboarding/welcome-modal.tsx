"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * First-run welcome tour. Four slides explaining what suverse-pay
 * does and how the customer earns. Renders only when
 * `initialDismissedAt` is null (server-rendered hint from
 * dashboard_users.onboarding_dismissed_at). Skipping or finishing
 * POSTs /api/onboarding to flip the flag — the modal then unmounts
 * for good on this account.
 *
 * Deliberately not a portal — sits inside the dashboard layout so
 * dismissing it leaves the page state intact (no re-fetch needed).
 */
export function WelcomeModal({
  initialDismissedAt,
}: {
  initialDismissedAt: string | null;
}): React.JSX.Element | null {
  const [step, setStep] = useState(0);
  const [open, setOpen] = useState(initialDismissedAt === null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") void dismiss();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function dismiss(): Promise<void> {
    if (submitting) return;
    setSubmitting(true);
    try {
      await fetch("/api/onboarding", { method: "POST" });
    } catch {
      // Network error is recoverable — the modal stays hidden for
      // this session and the next page-load will re-prompt.
    }
    setOpen(false);
  }

  if (!open) return null;

  const isLast = step === SLIDES.length - 1;
  const slide = SLIDES[step]!;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) void dismiss();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <div className="p-6 sm:p-8">
          <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-amber-400">
            Step {step + 1} / {SLIDES.length}
          </div>
          <h2
            id="welcome-title"
            className="mt-3 font-display text-xl font-semibold sm:text-2xl"
          >
            {slide.title}
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {slide.body}
          </p>
          {slide.example ? (
            <pre className="mt-4 overflow-x-auto rounded-md border border-border bg-background px-3 py-2.5 font-mono text-[11px] text-foreground">
              {slide.example}
            </pre>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border bg-secondary/30 px-6 py-4">
          <button
            type="button"
            onClick={() => void dismiss()}
            disabled={submitting}
            className="text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {isLast ? "Dismiss" : "Skip tour"}
          </button>
          <div className="flex items-center gap-2">
            <div
              className="flex gap-1"
              aria-label={`Step ${step + 1} of ${SLIDES.length}`}
            >
              {SLIDES.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1.5 w-4 rounded-full transition-colors",
                    i === step ? "bg-amber-400" : "bg-border",
                  )}
                />
              ))}
            </div>
            {step > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setStep((s) => s - 1)}
                disabled={submitting}
              >
                Back
              </Button>
            ) : null}
            {isLast ? (
              <Button
                type="button"
                variant="accent"
                size="sm"
                onClick={() => void dismiss()}
                disabled={submitting}
              >
                {submitting ? "…" : "Get started"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="accent"
                size="sm"
                onClick={() => setStep((s) => s + 1)}
                disabled={submitting}
              >
                Next →
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface Slide {
  title: string;
  body: string;
  example?: string;
}

const SLIDES: readonly Slide[] = [
  {
    title: "Welcome to suverse-pay",
    body:
      "Turn any HTTPS endpoint into a paid API. Buyers hit your URL, " +
      "get a 402 challenge, sign a USDC payment, and you receive the " +
      "money on-chain — no code changes to your upstream service.",
  },
  {
    title: "Step 1 — Generate an API key",
    body:
      "Your API key identifies which seller a payment is settled for. " +
      "It's shown ONCE in plaintext — copy it into your secrets manager. " +
      "We only ever store the hash.",
  },
  {
    title: "Step 2 — Wrap your endpoint",
    body:
      "Open Proxies → New, paste the upstream URL you want to monetise, " +
      "pick a price (e.g. $0.05 per call) and the chains you'll accept. " +
      "We mint a public proxy URL like the one below.",
    example: "https://proxy.suverse.io/v1/proxy/<key>/<slug>",
  },
  {
    title: "Step 3 — Share & get paid",
    body:
      "Share the proxy URL with buyers (agents, ops scripts, paid SaaS). " +
      "Every settled call shows up in Recent settles within ~30 seconds. " +
      "You'll see networks, fees, and tx hashes — and can publish the " +
      "endpoint to the public catalog so new buyers can find it.",
  },
];
