"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import type { CatalogListing } from "@/lib/catalog-search";

interface Props {
  initialListings: CatalogListing[];
}

/**
 * Pending-listings moderation queue. Renders one card per listing
 * with all the fields a moderator needs in one glance (title,
 * endpoint, networks, description, samples). Approve is a one-click
 * action; reject uses ConfirmDialog with a required reason input.
 *
 * Optimistic: after a successful PATCH we drop the row from local
 * state — no full refetch needed. If the queue gets bigger later
 * we'll switch to TanStack Query + invalidate, but for v1 the
 * local-list pattern is plenty.
 */
export function ModerationQueue({ initialListings }: Props): React.JSX.Element {
  const [listings, setListings] = useState(initialListings);
  const [pendingReject, setPendingReject] = useState<CatalogListing | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const moderate = useMutation({
    mutationFn: async (args: {
      id: string;
      decision: "approved" | "rejected";
      reason?: string;
    }) => {
      const body =
        args.decision === "approved"
          ? { decision: "approved" }
          : { decision: "rejected", reason: args.reason };
      const res = await fetch(`/api/admin/catalog/${args.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
    },
    onMutate: ({ id }) => {
      setBusyId(id);
      setError(null);
    },
    onSuccess: async (_, args) => {
      setListings((prev) => prev.filter((l) => l.id !== args.id));
      await qc.invalidateQueries({ queryKey: ["catalog"] });
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    },
    onSettled: () => setBusyId(null),
  });

  if (listings.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-card/30 p-10 text-center">
        <h3 className="font-display text-lg text-foreground">
          Queue empty
        </h3>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          No pending listings. New submissions land here automatically —
          this page auto-refreshes only on navigation.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {listings.map((l) => (
        <article
          key={l.id}
          className="rounded-lg border border-border bg-card p-5"
        >
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{l.title}</h2>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {l.endpointUrl}
              </p>
              <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
                {l.category ? (
                  <span className="rounded bg-secondary px-2 py-0.5 font-mono uppercase tracking-wider text-muted-foreground">
                    {l.category}
                  </span>
                ) : null}
                {l.networks.map((n) => (
                  <span
                    key={n}
                    className="rounded bg-secondary/60 px-2 py-0.5 font-mono text-muted-foreground"
                  >
                    {n}
                  </span>
                ))}
                {l.tags.slice(0, 6).map((t) => (
                  <span
                    key={t}
                    className="rounded border border-border px-2 py-0.5 font-mono text-muted-foreground"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="accent"
                size="sm"
                disabled={busyId === l.id}
                onClick={() =>
                  moderate.mutate({ id: l.id, decision: "approved" })
                }
              >
                {busyId === l.id ? "…" : "Approve"}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busyId === l.id}
                onClick={() => {
                  setPendingReject(l);
                  setRejectReason("");
                }}
              >
                Reject
              </Button>
            </div>
          </header>

          {l.description ? (
            <p className="mt-4 text-sm text-foreground/80">{l.description}</p>
          ) : (
            <p className="mt-4 text-sm italic text-muted-foreground">
              No description supplied.
            </p>
          )}

          {l.sampleRequestCurl ? (
            <details className="mt-4 rounded-md border border-border bg-secondary/30 px-3 py-2">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">
                Sample request
              </summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
                {l.sampleRequestCurl}
              </pre>
            </details>
          ) : null}

          {l.sampleResponseJson ? (
            <details className="mt-2 rounded-md border border-border bg-secondary/30 px-3 py-2">
              <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-muted-foreground">
                Sample response
              </summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
                {l.sampleResponseJson}
              </pre>
            </details>
          ) : null}

          <footer className="mt-4 flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground">
            <span>id: {l.id}</span>
            <span>slug: {l.slug}</span>
            <span>submitted: {new Date(l.createdAt).toLocaleString()}</span>
            {l.isVerified ? (
              <span className="text-emerald-300">verified link</span>
            ) : null}
          </footer>
        </article>
      ))}

      <ConfirmDialog
        open={pendingReject !== null}
        title={`Reject "${pendingReject?.title ?? ""}"?`}
        body={
          <div className="space-y-2">
            <p>
              The submitter sees this reason on their dashboard. Keep it
              short and actionable — &ldquo;Description too vague&rdquo;,
              &ldquo;Endpoint returns 404&rdquo;, etc.
            </p>
            <Input
              autoFocus
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason (3–500 chars)"
              maxLength={500}
            />
          </div>
        }
        confirmLabel="Reject listing"
        variant="destructive"
        disabled={
          busyId === pendingReject?.id ||
          rejectReason.trim().length < 3
        }
        onCancel={() => {
          setPendingReject(null);
          setRejectReason("");
        }}
        onConfirm={() => {
          if (!pendingReject) return;
          const id = pendingReject.id;
          const reason = rejectReason.trim();
          setPendingReject(null);
          moderate.mutate({ id, decision: "rejected", reason });
        }}
      />
    </div>
  );
}
