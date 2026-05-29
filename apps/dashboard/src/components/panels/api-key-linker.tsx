"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * Shown when the signed-in user has no linked resource keys.
 * Form: paste plaintext key → POST /api/link-key → on success,
 * invalidate queries so the dashboard immediately shows the new
 * key's data.
 *
 * Self-serve key creation is deferred to Sub-task 2 of this block.
 * For now we show a small "Need a key? Contact us" link.
 */
export function ApiKeyLinker({
  onLinked,
}: {
  onLinked?: () => void;
}): React.JSX.Element {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (value.trim().length < 8) {
      setError("API key looks too short — paste the full value");
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
        setError("That key wasn’t recognized. Check for typos or contact support.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Server returned ${res.status}`);
        return;
      }
      const body = (await res.json()) as { label: string; alreadyLinked: boolean };
      setSuccess(
        body.alreadyLinked
          ? `Already linked to ${body.label}.`
          : `Linked ${body.label}.`,
      );
      setValue("");
      await qc.invalidateQueries({ queryKey: ["linked-keys"] });
      await qc.invalidateQueries({ queryKey: ["stats"] });
      await qc.invalidateQueries({ queryKey: ["settles"] });
      await qc.invalidateQueries({ queryKey: ["networks"] });
      await qc.invalidateQueries({ queryKey: ["volume-chart"] });
      onLinked?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Link an existing API key</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-5 max-w-md text-sm text-muted-foreground">
          Paste a resource API key you’ve already received. We’ll associate it
          with your account so settles show up here.
        </p>

        <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="rk_…"
            aria-label="Resource API key"
            disabled={submitting}
            className="flex-1"
          />
          <Button type="submit" variant="accent" disabled={submitting}>
            {submitting ? "Linking…" : "Link key"}
          </Button>
        </form>

        {error ? (
          <p className="mt-3 text-sm text-destructive">{error}</p>
        ) : success ? (
          <p className="mt-3 text-sm text-emerald-400">{success}</p>
        ) : null}

        <p className="mt-6 text-xs text-muted-foreground">
          Don’t have a key yet? Self-serve signup ships in the next release.
          For now,{" "}
          <a
            href="mailto:keys@suverse.io"
            className="text-accent underline-offset-4 hover:underline"
          >
            email keys@suverse.io
          </a>{" "}
          and we’ll send one within a day.
        </p>
      </CardContent>
    </Card>
  );
}
