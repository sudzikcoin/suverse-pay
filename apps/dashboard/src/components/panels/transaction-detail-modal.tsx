"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  explorerUrl,
  formatRelativeTime,
  formatUsd,
  networkLabel,
} from "@/lib/utils";

export interface RecentPaymentForModal {
  id: string;
  createdAt: string;
  network: string;
  amountAtomic: string;
  payer: string | null;
  txHash: string | null;
  endpointSlug: string | null;
  displayName: string | null;
  proxyId: string | null;
  status: string;
}

/**
 * Address-level explorer link. CAIP-2 → block-explorer URL for an
 * address (NOT a tx). Mirrors `explorerUrl` in lib/utils but for
 * the address path. Unknown networks return null.
 */
function addressExplorerUrl(network: string, address: string): string | null {
  if (network.startsWith("eip155:")) {
    const map: Record<string, string> = {
      "eip155:1": "https://etherscan.io/address/",
      "eip155:8453": "https://basescan.org/address/",
      "eip155:42161": "https://arbiscan.io/address/",
      "eip155:10": "https://optimistic.etherscan.io/address/",
      "eip155:137": "https://polygonscan.com/address/",
      "eip155:56": "https://bscscan.com/address/",
      "eip155:43114": "https://snowtrace.io/address/",
      "eip155:84532": "https://sepolia.basescan.org/address/",
    };
    const base = map[network];
    return base ? base + address : null;
  }
  if (network.startsWith("solana:")) {
    return `https://solscan.io/account/${address}`;
  }
  if (network === "cosmos:noble-1") {
    return `https://www.mintscan.io/noble/address/${address}`;
  }
  if (network.startsWith("tron:")) {
    return `https://tronscan.org/#/address/${address}`;
  }
  return null;
}

function explorerHostLabel(network: string): string {
  if (network.startsWith("eip155:8453")) return "BaseScan";
  if (network.startsWith("eip155:1")) return "Etherscan";
  if (network.startsWith("eip155:42161")) return "Arbiscan";
  if (network.startsWith("eip155:10")) return "Optimism Etherscan";
  if (network.startsWith("eip155:137")) return "Polygonscan";
  if (network.startsWith("eip155:56")) return "BscScan";
  if (network.startsWith("eip155:43114")) return "Snowtrace";
  if (network.startsWith("eip155:84532")) return "BaseScan (Sepolia)";
  if (network.startsWith("solana:")) return "Solscan";
  if (network === "cosmos:noble-1") return "Mintscan";
  if (network.startsWith("tron:")) return "TronScan";
  return "explorer";
}

/**
 * Modal showing full detail for one settled payment. Triggered by
 * clicking a row in RecentExternalPayments. Escape and backdrop close.
 */
export function TransactionDetailModal({
  payment,
  onClose,
}: {
  payment: RecentPaymentForModal | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!payment) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [payment, onClose]);

  // Reset "copied" flash when a different row is opened.
  useEffect(() => {
    setCopied(false);
  }, [payment?.id]);

  if (!payment) return null;

  const when = new Date(payment.createdAt);
  const txExplorer = payment.txHash
    ? explorerUrl(payment.network, payment.txHash)
    : null;
  const payerExplorer = payment.payer
    ? addressExplorerUrl(payment.network, payment.payer)
    : null;
  const explorerHost = explorerHostLabel(payment.network);

  const copyDetails = async (): Promise<void> => {
    const lines: string[] = [
      `Time: ${when.toISOString()} (${formatRelativeTime(when)})`,
      `Payer: ${payment.payer ?? "—"}`,
      `Endpoint: ${payment.displayName ?? payment.endpointSlug ?? "direct"}`,
      `Network: ${networkLabel(payment.network)} (${payment.network})`,
      `Amount: ${formatUsd(payment.amountAtomic, 6)} USDC`,
      `Tx hash: ${payment.txHash ?? "—"}`,
      `Status: ${payment.status}`,
      `Payment id: ${payment.id}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore — clipboard may be blocked in dev/insecure contexts
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="tx-detail-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2
            id="tx-detail-title"
            className="text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground"
          >
            Transaction details
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </header>

        <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 px-5 py-5 text-sm">
          <dt className="text-muted-foreground">Time</dt>
          <dd>
            <div>{when.toISOString().replace("T", " ").slice(0, 19)} UTC</div>
            <div className="text-xs text-muted-foreground">
              {formatRelativeTime(when)}
            </div>
          </dd>

          <dt className="text-muted-foreground">Payer</dt>
          <dd className="break-all">
            {payment.payer ? (
              <>
                <div className="font-mono text-[11px]">{payment.payer}</div>
                {payerExplorer ? (
                  <a
                    href={payerExplorer}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-accent hover:underline"
                  >
                    Open on {explorerHost} ↗
                  </a>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </dd>

          <dt className="text-muted-foreground">Endpoint</dt>
          <dd>
            <div className="font-mono text-[12px]">
              {payment.displayName ?? payment.endpointSlug ?? "direct"}
            </div>
            {payment.proxyId ? (
              <Link
                href={`/dashboard/proxies/${payment.proxyId}`}
                className="text-[11px] text-accent hover:underline"
              >
                View endpoint details →
              </Link>
            ) : null}
          </dd>

          <dt className="text-muted-foreground">Network</dt>
          <dd>
            <div>{networkLabel(payment.network)}</div>
            <div className="font-mono text-[11px] text-muted-foreground">
              {payment.network}
            </div>
          </dd>

          <dt className="text-muted-foreground">Amount</dt>
          <dd className="font-mono text-amber-300">
            {formatUsd(payment.amountAtomic, 6)} USDC
          </dd>

          <dt className="text-muted-foreground">Tx hash</dt>
          <dd className="break-all">
            {payment.txHash ? (
              <>
                <div className="font-mono text-[11px]">{payment.txHash}</div>
                {txExplorer ? (
                  <a
                    href={txExplorer}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-accent hover:underline"
                  >
                    Open on {explorerHost} ↗
                  </a>
                ) : null}
              </>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </dd>

          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <span className="inline-flex items-center gap-1 text-emerald-400">
              ● {payment.status}
            </span>
          </dd>
        </dl>

        <footer className="flex items-center justify-between gap-3 border-t border-border bg-secondary/30 px-5 py-3">
          <span
            className={`text-[11px] transition-opacity ${copied ? "opacity-100 text-emerald-400" : "opacity-0"}`}
            aria-live="polite"
          >
            Copied to clipboard
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={copyDetails}>
              Copy details
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
