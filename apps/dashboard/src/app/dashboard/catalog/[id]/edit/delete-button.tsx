"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Client-only suspend button. Confirms via ConfirmDialog then
 * redirects back to the listings table on success. No HTML <form>;
 * the entire flow is an onClick (project convention from CLAUDE.md).
 */
export function DeleteListingButton({
  id,
}: {
  id: string;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function suspend(): Promise<void> {
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
      <Button
        onClick={() => setPending(true)}
        disabled={busy}
        variant="destructive"
      >
        {busy ? "Suspending…" : "Suspend listing"}
      </Button>
      {error !== null && (
        <p className="font-mono text-[11px] text-destructive">{error}</p>
      )}
      <ConfirmDialog
        open={pending}
        title="Suspend this listing?"
        body="It'll be hidden from the public catalog. The row is preserved for audit."
        confirmLabel="Suspend"
        variant="destructive"
        disabled={busy}
        onCancel={() => setPending(false)}
        onConfirm={() => {
          setPending(false);
          void suspend();
        }}
      />
    </div>
  );
}
