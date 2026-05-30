"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { HelpTip } from "@/components/ui/help-tip";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

type Family = "evm" | "solana" | "cosmos" | "tron";

interface Wallet {
  id: string;
  networkFamily: Family;
  address: string;
  label: string | null;
  linkedAt: string;
}

interface WalletsResponse {
  wallets: Wallet[];
}

const FAMILIES: Array<{ value: Family; label: string; placeholder: string }> = [
  { value: "evm", label: "EVM (Base, Polygon, etc.)", placeholder: "0x..." },
  { value: "solana", label: "Solana", placeholder: "base58 pubkey" },
  { value: "cosmos", label: "Cosmos · Noble", placeholder: "noble1..." },
  { value: "tron", label: "TRON", placeholder: "T..." },
];

export function WalletsView(): React.JSX.Element {
  const qc = useQueryClient();
  const [family, setFamily] = useState<Family>("evm");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Wallet | null>(null);

  const { data, isLoading } = useQuery<WalletsResponse>({
    queryKey: ["buyer-wallets"],
    queryFn: async () => {
      const res = await fetch("/api/buyer/wallets");
      if (!res.ok) throw new Error(`wallets ${res.status}`);
      return (await res.json()) as WalletsResponse;
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      setError(null);
      const res = await fetch("/api/buyer/wallets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          networkFamily: family,
          address: address.trim(),
          label: label.trim() || undefined,
        }),
      });
      if (res.status === 409) {
        throw new Error("Already linked.");
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
      setAddress("");
      setLabel("");
      await qc.invalidateQueries({ queryKey: ["buyer-wallets"] });
    },
    onError: (e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/buyer/wallets/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`delete ${res.status}`);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["buyer-wallets"] });
    },
  });

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Add a payer address
          </h2>
          <HelpTip>
            We surface payments where the on-chain payer matches one of
            your registered addresses. v1 trusts the claim — there's no
            sign-in-with-wallet proof yet, so you can technically list
            someone else's address and see their public on-chain spend.
          </HelpTip>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-[180px_1fr_200px]">
          <Labelled label="Chain family">
            <select
              value={family}
              onChange={(e) => setFamily(e.target.value as Family)}
              className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
            >
              {FAMILIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Address">
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder={
                FAMILIES.find((f) => f.value === family)?.placeholder ?? ""
              }
              className="font-mono text-xs"
            />
          </Labelled>
          <Labelled label="Label (optional)">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="agent-main"
              maxLength={80}
            />
          </Labelled>
        </div>
        <div className="mt-4 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="accent"
            size="sm"
            disabled={create.isPending || address.trim().length === 0}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Adding…" : "Add wallet"}
          </Button>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <header className="border-b border-border px-6 py-4">
          <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Registered wallets
          </h2>
        </header>
        {isLoading ? (
          <div className="space-y-2 px-6 py-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !data || data.wallets.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No wallets yet — add one above to start tracking purchases.
          </div>
        ) : (
          <ul className="divide-y divide-border/40">
            {data.wallets.map((w) => (
              <li
                key={w.id}
                className="flex flex-col gap-2 px-6 py-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="rounded bg-secondary px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {w.networkFamily}
                    </span>
                    {w.label ? (
                      <span className="text-sm font-medium">{w.label}</span>
                    ) : null}
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {w.address}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    added {new Date(w.linkedAt).toLocaleDateString()}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setPendingDelete(w)}
                  disabled={remove.isPending}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Remove this wallet?"
        body={
          <>
            Future payments from{" "}
            <code>
              {pendingDelete?.address.slice(0, 10)}…
            </code>{" "}
            will stop appearing in your dashboard. Re-add it any time
            to resume tracking.
          </>
        }
        confirmLabel="Remove"
        variant="destructive"
        disabled={remove.isPending}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) {
            const id = pendingDelete.id;
            setPendingDelete(null);
            remove.mutate(id);
          }
        }}
      />
    </div>
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
