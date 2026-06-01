/**
 * On-chain USDC balance lookups for the redesigned dashboard
 * Balances block. Reads the user's distinct payTo addresses from
 * their proxy configs, then asks each chain's RPC for the USDC
 * holdings at that address.
 *
 * Defaults work without env config — we hit public RPCs (Base
 * mainnet, Solana mainnet, Noble LCD). Operators can override
 * via DASHBOARD_BASE_RPC_URL / DASHBOARD_SOLANA_RPC_URL /
 * DASHBOARD_NOBLE_LCD_URL when they want their own infra.
 *
 * Each lookup runs with a 4-second timeout; failures degrade to a
 * null balance + error message on the response rather than
 * collapsing the whole dashboard card. The result struct includes
 * which addresses were polled so the UI can surface "balance for
 * 3 wallets" rather than pretending it knows about one.
 */

import { dbQuery } from "./db";

/** USDC contract on Base mainnet (Circle, native USDC, 6 decimals). */
const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** USDC mint on Solana mainnet (Circle, 6 decimals). */
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Noble's native USDC denom (uusdc, 6 decimals). */
const NOBLE_USDC_DENOM = "uusdc";

const DEFAULTS = {
  baseRpc: "https://mainnet.base.org",
  solanaRpc: "https://api.mainnet-beta.solana.com",
  nobleLcd: "https://noble-api.polkachu.com",
};

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

export interface WalletBalance {
  address: string;
  /** USDC balance in atomic units (1e6) as a base-10 string. */
  balanceAtomic: string;
  /** Short error string when the RPC call fails; null on success. */
  error: string | null;
}

export interface ChainBalance {
  chain: "base" | "solana" | "cosmos";
  /** Total across all wallets on this chain, atomic units. */
  totalAtomic: string;
  wallets: WalletBalance[];
}

export interface DashboardBalances {
  base: ChainBalance;
  solana: ChainBalance;
  cosmos: ChainBalance;
  totalUsdAtomic: string;
}

/**
 * Pull the user's distinct payTo addresses per chain family from
 * their proxy configs. NULL values are skipped — a seller who
 * hasn't configured a Cosmos payTo gets an empty Cosmos card.
 */
export async function getPayToWalletsForUser(
  userId: string,
): Promise<{ base: string[]; solana: string[]; cosmos: string[] }> {
  const rows = await dbQuery<{
    pay_to_evm: string | null;
    pay_to_solana: string | null;
    pay_to_cosmos: string | null;
  }>(
    `
    SELECT DISTINCT c.pay_to_evm, c.pay_to_solana, c.pay_to_cosmos
    FROM seller_proxy_configs c
    JOIN dashboard_user_resource_keys l ON l.resource_key_id = c.resource_key_id
    WHERE l.user_id = $1
    `,
    [userId],
  );
  const base = new Set<string>();
  const solana = new Set<string>();
  const cosmos = new Set<string>();
  for (const r of rows) {
    if (r.pay_to_evm) base.add(r.pay_to_evm);
    if (r.pay_to_solana) solana.add(r.pay_to_solana);
    if (r.pay_to_cosmos) cosmos.add(r.pay_to_cosmos);
  }
  return {
    base: Array.from(base),
    solana: Array.from(solana),
    cosmos: Array.from(cosmos),
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 4000,
): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * eth_call USDC.balanceOf(address) on Base. Returns the raw atomic
 * (6-decimal) string. Throws on RPC error / malformed reply — the
 * caller wraps and turns it into a per-wallet error message.
 */
async function fetchBaseUsdcBalance(addr: string): Promise<string> {
  const rpc = env("DASHBOARD_BASE_RPC_URL", DEFAULTS.baseRpc);
  // balanceOf(address) selector + 32-byte zero-padded address arg.
  const cleaned = addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const data = "0x70a08231" + cleaned;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: BASE_USDC_CONTRACT, data }, "latest"],
  };
  const res = await fetchWithTimeout(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`base rpc ${res.status}`);
  const j = (await res.json()) as { result?: string; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  if (!j.result) throw new Error("no result");
  // eth_call returns 0x-prefixed hex; "0x" alone = zero balance.
  const hex = j.result.replace(/^0x/, "");
  if (hex.length === 0) return "0";
  return BigInt("0x" + hex).toString(10);
}

/**
 * Solana getTokenAccountsByOwner → sum the amount of every USDC
 * token account the wallet owns. We use jsonParsed encoding so the
 * decoded `tokenAmount.amount` lives directly on the response.
 */
async function fetchSolanaUsdcBalance(addr: string): Promise<string> {
  const rpc = env("DASHBOARD_SOLANA_RPC_URL", DEFAULTS.solanaRpc);
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [
      addr,
      { mint: SOLANA_USDC_MINT },
      { encoding: "jsonParsed" },
    ],
  };
  const res = await fetchWithTimeout(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`solana rpc ${res.status}`);
  const j = (await res.json()) as {
    result?: {
      value: Array<{
        account: {
          data: {
            parsed: { info: { tokenAmount: { amount: string } } };
          };
        };
      }>;
    };
    error?: { message?: string };
  };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  let total = 0n;
  for (const acct of j.result?.value ?? []) {
    const amt = acct.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (amt && /^\d+$/.test(amt)) total += BigInt(amt);
  }
  return total.toString(10);
}

/**
 * Noble LCD: query bank balances for the address and sum the uusdc
 * denom. Noble is the canonical Cosmos USDC issuer, so uusdc = USDC
 * 1:1 with 6 decimals.
 */
async function fetchCosmosUsdcBalance(addr: string): Promise<string> {
  const lcd = env("DASHBOARD_NOBLE_LCD_URL", DEFAULTS.nobleLcd);
  const url = `${lcd.replace(/\/$/, "")}/cosmos/bank/v1beta1/balances/${encodeURIComponent(addr)}`;
  const res = await fetchWithTimeout(url, { method: "GET" });
  if (!res.ok) throw new Error(`noble lcd ${res.status}`);
  const j = (await res.json()) as {
    balances?: Array<{ denom: string; amount: string }>;
  };
  let total = 0n;
  for (const c of j.balances ?? []) {
    if (c.denom === NOBLE_USDC_DENOM && /^\d+$/.test(c.amount)) {
      total += BigInt(c.amount);
    }
  }
  return total.toString(10);
}

async function fetchOne(
  fetcher: (addr: string) => Promise<string>,
  addr: string,
): Promise<WalletBalance> {
  try {
    const bal = await fetcher(addr);
    return { address: addr, balanceAtomic: bal, error: null };
  } catch (err) {
    return {
      address: addr,
      balanceAtomic: "0",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function sumAtomic(wallets: ReadonlyArray<WalletBalance>): string {
  let total = 0n;
  for (const w of wallets) {
    if (/^\d+$/.test(w.balanceAtomic)) total += BigInt(w.balanceAtomic);
  }
  return total.toString(10);
}

/**
 * Fan out balance lookups in parallel across all three chains.
 * `base + solana + cosmos` chunks happen at once; within a chunk,
 * multiple wallets also run in parallel. This caps the round-trip
 * at ~one slow RPC, regardless of how many addresses are configured.
 */
export async function loadDashboardBalances(
  userId: string,
): Promise<DashboardBalances> {
  const wallets = await getPayToWalletsForUser(userId);

  const [base, solana, cosmos] = await Promise.all([
    Promise.all(wallets.base.map((a) => fetchOne(fetchBaseUsdcBalance, a))),
    Promise.all(wallets.solana.map((a) => fetchOne(fetchSolanaUsdcBalance, a))),
    Promise.all(wallets.cosmos.map((a) => fetchOne(fetchCosmosUsdcBalance, a))),
  ]);

  const baseTotal = sumAtomic(base);
  const solanaTotal = sumAtomic(solana);
  const cosmosTotal = sumAtomic(cosmos);

  const grand = (BigInt(baseTotal) + BigInt(solanaTotal) + BigInt(cosmosTotal)).toString(10);

  return {
    base: { chain: "base", totalAtomic: baseTotal, wallets: base },
    solana: { chain: "solana", totalAtomic: solanaTotal, wallets: solana },
    cosmos: { chain: "cosmos", totalAtomic: cosmosTotal, wallets: cosmos },
    totalUsdAtomic: grand,
  };
}
