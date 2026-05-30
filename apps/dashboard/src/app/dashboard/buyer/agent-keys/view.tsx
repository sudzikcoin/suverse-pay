"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface AgentKey {
  id: string;
  label: string;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface CreatedAgentKey extends AgentKey {
  plaintext: string;
}

interface KeysResponse {
  keys: AgentKey[];
}

export function AgentKeysView(): React.JSX.Element {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<CreatedAgentKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AgentKey | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery<KeysResponse>({
    queryKey: ["buyer-agent-keys"],
    queryFn: async () => {
      const res = await fetch("/api/buyer/agent-keys");
      if (!res.ok) throw new Error(`agent-keys ${res.status}`);
      return (await res.json()) as KeysResponse;
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      setError(null);
      const res = await fetch("/api/buyer/agent-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Server returned ${res.status}`);
      }
      return (await res.json()) as CreatedAgentKey;
    },
    onSuccess: async (key) => {
      setCreated(key);
      setLabel("");
      await qc.invalidateQueries({ queryKey: ["buyer-agent-keys"] });
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/buyer/agent-keys/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`revoke ${res.status}`);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["buyer-agent-keys"] });
    },
  });

  async function copyPlain(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      {created ? (
        <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-5">
          <div className="text-[10px] font-medium uppercase tracking-[0.18em] text-amber-400">
            Save this key now
          </div>
          <p className="mt-2 text-sm">
            <span className="font-medium">You cannot see this key again.</span>{" "}
            Paste it into your agent's secrets manager. We only store the hash.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-background px-3 py-2 font-mono text-sm">
              {created.plaintext}
            </code>
            <Button
              type="button"
              size="sm"
              variant={copied ? "accent" : "outline"}
              onClick={() => copyPlain(created.plaintext)}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="mt-4"
            onClick={() => setCreated(null)}
          >
            I've saved it
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Create an agent key
            </h2>
            <HelpTip>
              Agent keys identify your agents in the SDK / MCP server.
              Format: <code>sup_agent_</code>+32 chars. Shown ONCE in
              plaintext at creation — we only store the SHA-256 hash.
            </HelpTip>
          </div>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. crawler-bot or daily-research-agent"
              maxLength={80}
              className="flex-1"
            />
            <Button
              type="button"
              variant="accent"
              size="sm"
              disabled={create.isPending || label.trim().length === 0}
              onClick={() => create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create key"}
            </Button>
          </div>
          {error ? (
            <p className="mt-2 text-sm text-destructive">{error}</p>
          ) : null}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card">
        <header className="border-b border-border px-6 py-4">
          <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Agent keys
          </h2>
        </header>
        {isLoading ? (
          <div className="space-y-2 px-6 py-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !data || data.keys.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No agent keys yet — create one above.
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {data.keys.map((k) => (
              <li
                key={k.id}
                className="flex flex-col gap-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{k.label}</span>
                    <ActivePill active={k.isActive} />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    <span>{k.id}</span>
                    <span>·</span>
                    <span>created {new Date(k.createdAt).toLocaleDateString()}</span>
                    {k.lastUsedAt ? (
                      <>
                        <span>·</span>
                        <span>used {new Date(k.lastUsedAt).toLocaleDateString()}</span>
                      </>
                    ) : (
                      <>
                        <span>·</span>
                        <span>never used</span>
                      </>
                    )}
                  </div>
                </div>
                {k.isActive ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setRevokeTarget(k)}
                    disabled={revoke.isPending}
                  >
                    Revoke
                  </Button>
                ) : (
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    revoked
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        title={`Revoke "${revokeTarget?.label ?? ""}"?`}
        body="The key stops working immediately. Past purchases remain visible in your history."
        confirmLabel="Revoke"
        variant="destructive"
        disabled={revoke.isPending}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget) {
            const id = revokeTarget.id;
            setRevokeTarget(null);
            revoke.mutate(id);
          }
        }}
      />
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
