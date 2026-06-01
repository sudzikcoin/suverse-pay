"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { BalancesCards } from "@/components/panels/balances-cards";
import { CreateKeyForm } from "@/components/panels/create-key-form";
import { ExternalVolumeChart } from "@/components/panels/external-volume-chart";
import { InvoiceDownload } from "@/components/panels/invoice-download";
import { KeysList } from "@/components/panels/keys-list";
import { RecentExternalPayments } from "@/components/panels/recent-external-payments";
import { RevenueSummary } from "@/components/panels/revenue-summary";
import { TopEndpoints } from "@/components/panels/top-endpoints";
import { WebhooksSection } from "@/components/panels/webhooks-section";

/**
 * Redesigned dashboard overview. The block order follows what an
 * operator wants to see at-a-glance, top to bottom:
 *
 *   1. Balances        on-chain USDC across all payout wallets
 *   2. Revenue         external vs self split with period tabs
 *   3. Volume chart    external-only series
 *   4. Top 5           highest-grossing endpoints (24h external)
 *   5. Recent payments last 10 external settles
 *   6. API keys        management — moved down: it's housekeeping,
 *                      not a primary view
 *   7. Webhooks        ditto
 *   8. Invoice export  ditto
 *
 * Each block manages its own period state (where applicable) so a
 * user can compare 24h revenue alongside a 7d chart without one
 * widget hijacking the other.
 */
export function DashboardView({
  linkedKeys,
}: {
  linkedKeys: ReadonlyArray<{ resource_key_id: string; label: string }>;
}): React.JSX.Element {
  const [showCreate, setShowCreate] = useState(false);

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
        </div>
      </div>

      {showCreate ? (
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="mb-4 text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Create a new key
          </h3>
          <CreateKeyForm className="max-w-xl" onCreated={() => {}} />
        </div>
      ) : null}

      <section aria-labelledby="balances-heading" className="space-y-3">
        <h2
          id="balances-heading"
          className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground"
        >
          Balances · on-chain
        </h2>
        <BalancesCards />
      </section>

      <RevenueSummary />

      <ExternalVolumeChart />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <TopEndpoints />
        <RecentExternalPayments />
      </div>

      <div className="border-t border-border pt-8">
        <h2 className="mb-4 text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
          Account · keys, webhooks, invoices
        </h2>
        <div className="flex flex-col gap-8">
          <KeysList />
          <WebhooksSection />
          <InvoiceDownload />
        </div>
      </div>
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
  return (
    <div className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{linkedKeys.length}</span>{" "}
      linked keys
    </div>
  );
}
