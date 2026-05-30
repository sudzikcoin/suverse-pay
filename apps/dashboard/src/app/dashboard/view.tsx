"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CreateKeyForm } from "@/components/panels/create-key-form";
import { InvoiceDownload } from "@/components/panels/invoice-download";
import { KeysList } from "@/components/panels/keys-list";
import {
  NetworkModeToggle,
  type NetworkMode,
} from "@/components/panels/network-mode-toggle";
import { NetworksTable } from "@/components/panels/networks-table";
import { PeriodToggle, type Period } from "@/components/panels/period-toggle";
import { SettlesTable } from "@/components/panels/settles-table";
import { SummaryCards } from "@/components/panels/summary-cards";
import { VolumeChart } from "@/components/panels/volume-chart";
import { WebhooksSection } from "@/components/panels/webhooks-section";

/**
 * Four-panel dashboard view. Period state lives at this level so
 * Summary / Volume / Networks all see the same toggle; the Settles
 * table has its own status filter (not bound to the period).
 *
 * Layout:
 *   Row 1: KeyPill (left) + "New key" button + Period toggle (right)
 *   Row 2: 4 summary cards
 *   Row 3: Volume chart (full width)
 *   Row 4: Settles (60% width) + Networks (40% width) on lg+
 *           Stack on smaller screens.
 *   Row 5: API keys management list (Sub-task 2)
 *
 * The "New key" affordance opens a small inline dialog rather than
 * navigating away — keeps the dashboard's context visible while the
 * customer reads the one-time plaintext.
 */
export function DashboardView({
  linkedKeys,
}: {
  linkedKeys: ReadonlyArray<{ resource_key_id: string; label: string }>;
}): React.JSX.Element {
  const [period, setPeriod] = useState<Period>("24h");
  const [networkMode, setNetworkMode] = useState<NetworkMode>("mainnet");
  const [showCreate, setShowCreate] = useState(false);
  const includeTestnet = networkMode === "all";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <KeyPill linkedKeys={linkedKeys} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setShowCreate((v) => !v)}
            aria-expanded={showCreate}
          >
            {showCreate ? "Close" : "+ New key"}
          </Button>
          <NetworkModeToggle value={networkMode} onChange={setNetworkMode} />
          <PeriodToggle value={period} onChange={setPeriod} />
        </div>
      </div>

      {showCreate ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Create a new key
          </h3>
          <CreateKeyForm
            className="max-w-xl"
            onCreated={() => {
              /* Keep the panel open so the user can see the one-time
                 plaintext; CreateKeyForm shows its own "I've saved
                 it" dismiss button which clears its internal state. */
            }}
          />
        </div>
      ) : null}

      <SummaryCards period={period} includeTestnet={includeTestnet} />
      <VolumeChart period={period} includeTestnet={includeTestnet} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
        <SettlesTable includeTestnet={includeTestnet} />
        <NetworksTable period={period} includeTestnet={includeTestnet} />
      </div>

      <KeysList />

      <WebhooksSection />

      <InvoiceDownload />
    </div>
  );
}

function KeyPill({
  linkedKeys,
}: {
  linkedKeys: ReadonlyArray<{ resource_key_id: string; label: string }>;
}): React.JSX.Element {
  if (linkedKeys.length === 1) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="font-mono text-[10px] uppercase tracking-wider">
          Key
        </span>
        <span className="font-medium text-foreground">
          {linkedKeys[0]!.label}
        </span>
      </div>
    );
  }
  // Multi-key UI — for v1 we just show count; a per-key filter
  // selector is a follow-on once we see customers using multiple
  // keys in production.
  return (
    <div className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{linkedKeys.length}</span>{" "}
      linked keys
    </div>
  );
}
