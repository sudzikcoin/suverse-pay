"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatRelativeTime } from "@/lib/utils";

interface LinkedKey {
  resourceKeyId: string;
  label: string;
  linkedAt: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface KeysResponse {
  keys: LinkedKey[];
  limits: { maxKeysPerUser: number; createCooldownMs: number };
}

async function fetchKeys(): Promise<KeysResponse> {
  const res = await fetch("/api/keys", { cache: "no-store" });
  if (!res.ok) throw new Error(`keys ${res.status}`);
  return (await res.json()) as KeysResponse;
}

async function revokeKey(id: string): Promise<void> {
  const res = await fetch(`/api/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `revoke ${res.status}`);
  }
}

/**
 * Keys management panel. Visible in the dashboard when the user has
 * ≥1 linked key. Shows label, id, age, last-used, active/revoked
 * pill + a Revoke button per row. The header surfaces the remaining
 * key budget (e.g. "3 / 5 active") so users know where they stand
 * relative to the cap.
 */
export function KeysList(): React.JSX.Element {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["keys"],
    queryFn: fetchKeys,
    refetchOnWindowFocus: true,
  });
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRevoke(id: string, label: string): Promise<void> {
    if (
      !window.confirm(
        `Revoke "${label}"? Settles already routed under this key keep working, but new requests using it will be rejected.`,
      )
    ) {
      return;
    }
    setError(null);
    setRevokingId(id);
    try {
      await revokeKey(id);
      await qc.invalidateQueries({ queryKey: ["keys"] });
      await qc.invalidateQueries({ queryKey: ["linked-keys"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRevokingId(null);
    }
  }

  const active = data?.keys.filter((k) => k.isActive).length ?? 0;
  const max = data?.limits.maxKeysPerUser ?? 5;

  return (
    <div className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h3 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            API keys
          </h3>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          {active} / {max} active
        </span>
      </header>

      {isLoading ? (
        <div className="space-y-2 px-6 py-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="px-6 py-8 text-sm text-muted-foreground">
          Couldn’t load keys — try refreshing.
        </div>
      ) : !data || data.keys.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-muted-foreground">
          No keys yet.
        </div>
      ) : (
        <ul className="divide-y divide-border/50">
          {data.keys.map((k) => (
            <li
              key={k.resourceKeyId}
              className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{k.label}</span>
                  <ActivePill active={k.isActive} />
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
                  <span>{k.resourceKeyId}</span>
                  <span>·</span>
                  <span>created {formatRelativeTime(new Date(k.createdAt))}</span>
                  {k.lastUsedAt ? (
                    <>
                      <span>·</span>
                      <span>
                        last used {formatRelativeTime(new Date(k.lastUsedAt))}
                      </span>
                    </>
                  ) : (
                    <>
                      <span>·</span>
                      <span>never used</span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {k.isActive ? (
                  <>
                    <Link
                      href={`/dashboard/keys/${encodeURIComponent(k.resourceKeyId)}/configure`}
                      className="inline-flex h-9 items-center rounded-md border border-border bg-transparent px-3 text-xs font-medium hover:bg-secondary"
                    >
                      Configure
                    </Link>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onRevoke(k.resourceKeyId, k.label)}
                      disabled={revokingId === k.resourceKeyId}
                    >
                      {revokingId === k.resourceKeyId ? "Revoking…" : "Revoke"}
                    </Button>
                  </>
                ) : (
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    revoked
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <div className="border-t border-border px-6 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}

function ActivePill({ active }: { active: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        active
          ? "bg-emerald-500/15 text-emerald-300"
          : "bg-muted text-muted-foreground",
      )}
    >
      {active ? "Active" : "Revoked"}
    </span>
  );
}

