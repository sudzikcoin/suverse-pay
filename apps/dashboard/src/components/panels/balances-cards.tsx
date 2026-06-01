"use client";

import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatUsd, truncateMiddle } from "@/lib/utils";

interface WalletBalance {
  address: string;
  balanceAtomic: string;
  error: string | null;
}

interface ChainBalance {
  chain: "base" | "solana" | "cosmos";
  totalAtomic: string;
  wallets: WalletBalance[];
}

interface BalancesResponse {
  base: ChainBalance;
  solana: ChainBalance;
  cosmos: ChainBalance;
  totalUsdAtomic: string;
}

async function fetchBalances(): Promise<BalancesResponse> {
  const res = await fetch("/api/dashboard/balances", { cache: "no-store" });
  if (!res.ok) throw new Error(`balances ${res.status}`);
  return (await res.json()) as BalancesResponse;
}

/**
 * Three on-chain balance cards + a grand-total tile. RPC requests
 * fan out in parallel on the server, so the panel either loads in
 * one ~1s tick or falls back to per-chain errors without blocking.
 */
export function BalancesCards(): React.JSX.Element {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard-balances"],
    queryFn: fetchBalances,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Card
        title="Base"
        chain="base"
        chainBal={data?.base ?? null}
        loading={isLoading}
        error={isError}
      />
      <Card
        title="Solana"
        chain="solana"
        chainBal={data?.solana ?? null}
        loading={isLoading}
        error={isError}
      />
      <Card
        title="Cosmos · Noble"
        chain="cosmos"
        chainBal={data?.cosmos ?? null}
        loading={isLoading}
        error={isError}
      />
      <TotalCard
        totalAtomic={data?.totalUsdAtomic ?? null}
        loading={isLoading}
        error={isError}
      />
    </div>
  );
}

function Card({
  title,
  chain,
  chainBal,
  loading,
  error,
}: {
  title: string;
  chain: ChainBalance["chain"];
  chainBal: ChainBalance | null;
  loading: boolean;
  error: boolean;
}): React.JSX.Element {
  const hasWallets = chainBal !== null && chainBal.wallets.length > 0;
  const anyError =
    chainBal !== null && chainBal.wallets.some((w) => w.error !== null);

  return (
    <div className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          {title}
        </h4>
        <ChainDot chain={chain} />
      </div>
      <div className="mt-3 min-h-[2.25rem]">
        {loading ? (
          <Skeleton className="h-9 w-32" />
        ) : error ? (
          <span className="font-display text-3xl text-muted-foreground">—</span>
        ) : !hasWallets ? (
          <span className="font-display text-base text-muted-foreground">
            no wallet
          </span>
        ) : (
          <span className="stat-value font-display text-3xl font-medium leading-none">
            {formatUsd(chainBal!.totalAtomic, 6)}
          </span>
        )}
      </div>
      <div className="mt-3 space-y-1">
        {hasWallets
          ? chainBal!.wallets.map((w) => (
              <div
                key={w.address}
                className="flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground"
              >
                <span title={w.address} className="truncate">
                  {truncateMiddle(w.address, 6, 6)}
                </span>
                {w.error ? (
                  <span
                    className="text-destructive/80"
                    title={w.error}
                  >
                    rpc err
                  </span>
                ) : (
                  <span>{formatUsd(w.balanceAtomic, 6)}</span>
                )}
              </div>
            ))
          : null}
        {anyError ? (
          <div className="mt-1 text-[10px] text-amber-300/80">
            one or more lookups failed — totals may be stale
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TotalCard({
  totalAtomic,
  loading,
  error,
}: {
  totalAtomic: string | null;
  loading: boolean;
  error: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-5 py-4">
      <h4 className="text-[10px] font-medium uppercase tracking-[0.2em] text-amber-300">
        Total USDC
      </h4>
      <div className="mt-3 min-h-[2.25rem]">
        {loading ? (
          <Skeleton className="h-9 w-32" />
        ) : error || totalAtomic === null ? (
          <span className="font-display text-3xl text-muted-foreground">—</span>
        ) : (
          <span className="stat-value font-display text-3xl font-medium leading-none text-amber-400">
            {formatUsd(totalAtomic, 6)}
          </span>
        )}
      </div>
      <div className="mt-3 text-[10px] text-muted-foreground">
        on-chain across Base + Solana + Noble
      </div>
    </div>
  );
}

function ChainDot({ chain }: { chain: ChainBalance["chain"] }): React.JSX.Element {
  const tone = {
    base: "bg-blue-400",
    solana: "bg-purple-400",
    cosmos: "bg-emerald-400",
  } as const;
  return (
    <span
      className={cn("inline-block h-1.5 w-1.5 rounded-full", tone[chain])}
      aria-hidden
    />
  );
}
