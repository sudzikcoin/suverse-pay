"use client";

import { useState } from "react";
import { PeriodToggle, type Period } from "@/components/panels/period-toggle";
import { SummaryCards } from "@/components/panels/summary-cards";
import { VolumeChart } from "@/components/panels/volume-chart";
import { SettlesTable } from "@/components/panels/settles-table";
import { NetworksTable } from "@/components/panels/networks-table";

/**
 * Four-panel dashboard view. Period state lives at this level so
 * Summary / Volume / Networks all see the same toggle; the Settles
 * table has its own status filter (not bound to the period).
 *
 * Layout:
 *   Row 1: Period toggle (right-aligned)
 *   Row 2: 4 summary cards
 *   Row 3: Volume chart (full width)
 *   Row 4: Settles (60% width) + Networks (40% width) on lg+
 *           Stack on smaller screens.
 */
export function DashboardView({
  linkedKeys,
}: {
  linkedKeys: ReadonlyArray<{ resource_key_id: string; label: string }>;
}): React.JSX.Element {
  const [period, setPeriod] = useState<Period>("24h");

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <KeyPill linkedKeys={linkedKeys} />
        <PeriodToggle value={period} onChange={setPeriod} />
      </div>

      <SummaryCards period={period} />
      <VolumeChart period={period} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
        <SettlesTable />
        <NetworksTable period={period} />
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
        <span className="font-medium text-foreground">{linkedKeys[0]!.label}</span>
      </div>
    );
  }
  // Multi-key UI — for v1 we just list count; a real key selector
  // (filter the panels by chosen key) is Phase 5 Sub-task 2 follow-on.
  return (
    <div className="text-sm text-muted-foreground">
      <span className="font-medium text-foreground">{linkedKeys.length}</span> linked
      keys
    </div>
  );
}
