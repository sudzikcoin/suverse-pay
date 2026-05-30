"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface CreatedKey {
  resourceKeyId: string;
  plaintext: string;
  label: string;
  createdAt: string;
}

/**
 * Self-serve key creation form.
 *
 * Two phases:
 *   1. **Form** — user types a label, hits "Create key", server
 *      mints + hashes + links.
 *   2. **Reveal** — the response's plaintext appears EXACTLY ONCE
 *      with a copy-to-clipboard button and a sharply-worded
 *      "you cannot see this again" warning. Closing the reveal
 *      clears the plaintext from React state too (the secret
 *      survives only as long as this component is mounted).
 *
 * The "Cannot see this again" wording is deliberate — copying it
 * from Stripe's audit-tested pattern rather than hedging with
 * something softer like "this is the only time". Customers who
 * mis-handle the secret blame the dashboard, so the warning has to
 * read as a hard rule, not a suggestion.
 */
export function CreateKeyForm({
  onCreated,
  className,
}: {
  onCreated?: () => void;
  className?: string;
}): React.JSX.Element {
  const qc = useQueryClient();
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (label.trim().length === 0) {
      setError("Give the key a label so you can recognise it later.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Server returned ${res.status}`);
        return;
      }
      const body = (await res.json()) as CreatedKey;
      setCreated(body);
      setLabel("");
      await qc.invalidateQueries({ queryKey: ["keys"] });
      await qc.invalidateQueries({ queryKey: ["linked-keys"] });
      onCreated?.();
    } finally {
      setSubmitting(false);
    }
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Older browsers / disallowed contexts — fall back silently;
      // the input is still selectable.
    }
  }

  function dismiss(): void {
    // Clear the plaintext from memory the moment the user
    // acknowledges the warning.
    setCreated(null);
    setCopied(false);
    // Re-fetch the server tree so dashboard/page.tsx switches from
    // the zero-keys "Get started" landing to the four-panel view
    // (the conditional is server-rendered from a Postgres count,
    // so a TanStack query invalidate alone won't flip it). Calling
    // refresh here — not at mint time — preserves the one-time
    // plaintext reveal: a mid-reveal refresh would unmount this
    // component before the customer copies the secret.
    router.refresh();
  }

  if (created) {
    return (
      <div className={cn("flex flex-col gap-5", className)}>
        <div className="rounded-md border border-amber-400/40 bg-amber-400/5 p-4">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber-400">
            Save this key now
          </p>
          <p className="mt-2 text-sm">
            <span className="font-medium text-foreground">
              You cannot see this key again.
            </span>{" "}
            Copy it into your secrets manager — we only ever stored the hash.
          </p>
        </div>

        <div className="rounded-md border border-border bg-secondary/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {created.label}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-background px-3 py-2 font-mono text-sm">
              {created.plaintext}
            </code>
            <Button
              type="button"
              size="sm"
              variant={copied ? "accent" : "outline"}
              onClick={() => copy(created.plaintext)}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Id: {created.resourceKeyId}
          </p>
        </div>

        <Button type="button" variant="default" onClick={dismiss}>
          I’ve saved it
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Key label</span>
        <HelpTip>
          A human-friendly name so you can tell keys apart later. The
          label appears next to settles in the dashboard. Common
          conventions: the upstream API hostname, or
          <code> staging / prod</code>.
        </HelpTip>
      </div>
      <Input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="e.g. weather-api.example.com"
        maxLength={80}
        aria-label="Key label"
        disabled={submitting}
        className="font-sans"
      />
      <Button type="submit" variant="accent" disabled={submitting}>
        {submitting ? "Creating…" : "Create key"}
      </Button>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          The label is for your reference — appears next to settles + in the
          keys list. You can have up to 5 active keys.
        </p>
      )}
    </form>
  );
}
