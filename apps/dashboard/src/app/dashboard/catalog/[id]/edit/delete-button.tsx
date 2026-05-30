"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Client-only suspend button. Confirms via window.confirm (matches
 * the existing keys-list pattern) then redirects back to the
 * listings table on success. No HTML <form>; the entire flow is an
 * onClick (project convention from CLAUDE.md).
 */
export function DeleteListingButton({
  id,
}: {
  id: string;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function suspend(): Promise<void> {
    if (
      !window.confirm(
        "Suspend this listing? It'll be hidden from the public catalog. The row is preserved for audit.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/catalog/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `delete ${res.status}`);
      }
      router.push("/dashboard/catalog");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button onClick={suspend} disabled={busy} variant="destructive">
        {busy ? "Suspending…" : "Suspend listing"}
      </Button>
      {error !== null && (
        <p className="font-mono text-[11px] text-destructive">{error}</p>
      )}
    </div>
  );
}
