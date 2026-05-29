"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CreateKeyForm } from "./create-key-form";

/**
 * Shown when the signed-in user has no linked resource keys.
 * Two flows in one card via a small tab switcher:
 *   - **Create new key** (default, primary) — self-serve generation
 *     via `<CreateKeyForm />`.
 *   - **Link existing key** — paste plaintext, POST /api/link-key.
 *
 * The new-user happy path is "click sign-in → create a key →
 * dashboard renders". The link-existing flow remains for the
 * out-of-band issuance case (a teammate sends a key, ops manually
 * provisioned one, etc.).
 */
export function ApiKeyLinker({
  onChanged,
}: {
  onChanged?: () => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<"create" | "link">("create");
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Get started</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-5 max-w-md text-sm text-muted-foreground">
          You need a resource API key before settles can flow through
          this account.
        </p>

        <div
          role="tablist"
          aria-label="Key flow"
          className="mb-5 inline-flex items-center gap-px rounded-md border border-border bg-card p-0.5"
        >
          <TabButton
            active={tab === "create"}
            onClick={() => setTab("create")}
          >
            Create new
          </TabButton>
          <TabButton
            active={tab === "link"}
            onClick={() => setTab("link")}
          >
            Link existing
          </TabButton>
        </div>

        {tab === "create" ? (
          <CreateKeyForm onCreated={onChanged} />
        ) : (
          <LinkExistingForm onLinked={onChanged} />
        )}
      </CardContent>
    </Card>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function LinkExistingForm({
  onLinked,
}: {
  onLinked?: () => void;
}): React.JSX.Element {
  const qc = useQueryClient();
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (value.trim().length < 8) {
      setError("API key looks too short — paste the full value.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/link-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resourceKey: value.trim() }),
      });
      if (res.status === 404) {
        setError(
          "That key wasn’t recognized. Check for typos or generate a new one in the Create tab.",
        );
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Server returned ${res.status}`);
        return;
      }
      const body = (await res.json()) as {
        label: string;
        alreadyLinked: boolean;
      };
      setSuccess(
        body.alreadyLinked
          ? `Already linked to ${body.label}.`
          : `Linked ${body.label}.`,
      );
      setValue("");
      await qc.invalidateQueries({ queryKey: ["keys"] });
      await qc.invalidateQueries({ queryKey: ["linked-keys"] });
      await qc.invalidateQueries({ queryKey: ["stats"] });
      await qc.invalidateQueries({ queryKey: ["settles"] });
      await qc.invalidateQueries({ queryKey: ["networks"] });
      await qc.invalidateQueries({ queryKey: ["volume-chart"] });
      // Flip the server-rendered conditional in dashboard/page.tsx
      // from "zero linked keys" to "has linked keys" so the four-
      // panel view replaces this card. Safe to call immediately —
      // unlike CreateKeyForm there's no one-time plaintext reveal
      // that an early unmount would destroy.
      router.refresh();
      onLinked?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="sup_live_…"
        aria-label="Resource API key"
        disabled={submitting}
      />
      <Button type="submit" variant="accent" disabled={submitting}>
        {submitting ? "Linking…" : "Link key"}
      </Button>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : success ? (
        <p className="text-sm text-emerald-400">{success}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Use this if a teammate sent you a key, or if ops issued one
          for you out of band.
        </p>
      )}
    </form>
  );
}
