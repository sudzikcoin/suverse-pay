"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type Scope = "user" | "agent_key" | "endpoint";
type Period = "day" | "week" | "month";

interface Limit {
  id: string;
  scope: Scope;
  scopeId: string | null;
  period: Period;
  maxAtomicUsd: string;
  enabled: boolean;
  notifyEmail: boolean;
  autoPause: boolean;
  createdAt: string;
}

interface LimitsResponse {
  limits: Limit[];
}

export function LimitsView(): React.JSX.Element {
  const qc = useQueryClient();
  const [scope, setScope] = useState<Scope>("user");
  const [scopeId, setScopeId] = useState("");
  const [period, setPeriod] = useState<Period>("day");
  const [maxUsd, setMaxUsd] = useState("5.00");
  const [notify, setNotify] = useState(true);
  const [autoPause, setAutoPause] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Limit | null>(null);

  const { data, isLoading } = useQuery<LimitsResponse>({
    queryKey: ["buyer-limits"],
    queryFn: async () => {
      const res = await fetch("/api/buyer/limits");
      if (!res.ok) throw new Error(`limits ${res.status}`);
      return (await res.json()) as LimitsResponse;
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      setError(null);
      const atomic = usdToAtomic(maxUsd);
      if (atomic === null) {
        throw new Error("Amount must be a positive decimal like 5.00 or 0.25.");
      }
      const res = await fetch("/api/buyer/limits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope,
          scopeId: scope === "user" ? null : scopeId.trim(),
          period,
          maxAtomicUsd: atomic,
          notifyEmail: notify,
          autoPause,
        }),
      });
      if (res.status === 409) {
        throw new Error("A limit with this scope+period already exists.");
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
          error?: string;
        };
        throw new Error(
          body.message ?? body.error ?? `Server returned ${res.status}`,
        );
      }
    },
    onSuccess: async () => {
      setScopeId("");
      await qc.invalidateQueries({ queryKey: ["buyer-limits"] });
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : String(e)),
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await fetch(`/api/buyer/limits/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error(`toggle ${res.status}`);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["buyer-limits"] });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/buyer/limits/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`delete ${res.status}`);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["buyer-limits"] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-200">
        Accounting-only in v1 — limits flag overages but don't yet block
        payments. Auto-pause + email alerts land when we wire the
        enforcement layer.
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Add a spending limit
          </h2>
          <HelpTip>
            Pick what to limit (your total spend, a specific agent key,
            or a specific endpoint), the rolling period, and the max
            amount in USDC. Duplicate scope+period pairs are rejected
            with 409.
          </HelpTip>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Labelled label="Scope">
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            >
              <option value="user">All spend (this user)</option>
              <option value="agent_key">Per agent key</option>
              <option value="endpoint">Per endpoint URL hash</option>
            </select>
          </Labelled>
          {scope !== "user" ? (
            <Labelled
              label={scope === "agent_key" ? "Agent key id" : "Endpoint URL sha256"}
            >
              <Input
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
                placeholder={scope === "agent_key" ? "agtkey_..." : "<hex>"}
                className="font-mono text-xs"
              />
            </Labelled>
          ) : null}
          <Labelled label="Period">
            <select
              value={period}
              onChange={(e) => setPeriod(e.target.value as Period)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            >
              <option value="day">Per day</option>
              <option value="week">Per week</option>
              <option value="month">Per month</option>
            </select>
          </Labelled>
          <Labelled label="Max ($ USDC)">
            <Input
              value={maxUsd}
              onChange={(e) => setMaxUsd(e.target.value)}
              inputMode="decimal"
              placeholder="5.00"
              className="font-mono"
            />
          </Labelled>
          <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-1">
            <CheckboxLine
              checked={notify}
              onChange={setNotify}
              label="Notify by email"
            />
            <CheckboxLine
              checked={autoPause}
              onChange={setAutoPause}
              label="Auto-pause"
              disabledNote="future"
            />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="accent"
            size="sm"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Adding…" : "Add limit"}
          </Button>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <header className="border-b border-border px-6 py-4">
          <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Limits
          </h2>
        </header>
        {isLoading ? (
          <div className="space-y-2 px-6 py-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !data || data.limits.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No limits configured.
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {data.limits.map((l) => (
              <li
                key={l.id}
                className="flex flex-col gap-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="text-sm">
                    <span className="font-medium">
                      {humanScope(l)} · per {l.period}
                    </span>{" "}
                    <span className="text-muted-foreground">
                      max ${atomicToUsd(l.maxAtomicUsd)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
                    {l.notifyEmail ? <span>📧 notify</span> : null}
                    {l.autoPause ? <span>⏸ auto-pause</span> : null}
                    <span>created {new Date(l.createdAt).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      toggle.mutate({ id: l.id, enabled: !l.enabled })
                    }
                    disabled={toggle.isPending}
                  >
                    {l.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setDeleteTarget(l)}
                    disabled={remove.isPending}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this limit?"
        body="The threshold is removed and no further alerts fire for it."
        confirmLabel="Delete"
        variant="destructive"
        disabled={remove.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            const id = deleteTarget.id;
            setDeleteTarget(null);
            remove.mutate(id);
          }
        }}
      />
    </div>
  );
}

function humanScope(l: Limit): string {
  if (l.scope === "user") return "All spend";
  if (l.scope === "agent_key") return `Agent ${l.scopeId ?? "?"}`;
  return `Endpoint ${(l.scopeId ?? "").slice(0, 12)}…`;
}

function CheckboxLine({
  checked,
  onChange,
  label,
  disabledNote,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabledNote?: string;
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
      {disabledNote ? (
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          ({disabledNote})
        </span>
      ) : null}
    </label>
  );
}

function Labelled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

function usdToAtomic(s: string): string | null {
  const trimmed = s.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, fracRaw = ""] = trimmed.split(".");
  const frac = (fracRaw + "000000").slice(0, 6);
  const combined = BigInt(whole || "0") * 1_000_000n + BigInt(frac);
  if (combined === 0n) return null;
  return combined.toString();
}

function atomicToUsd(atomic: string): string {
  try {
    const n = BigInt(atomic);
    const whole = n / 1_000_000n;
    const frac = n % 1_000_000n;
    if (frac === 0n) return whole.toString();
    return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
  } catch {
    return "0";
  }
}
