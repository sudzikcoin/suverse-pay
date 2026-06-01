/**
 * On-chain reads for the admin /dashboard/wallets page.
 *
 * Per wallet we return:
 *   - native gas-token balance (ETH on Base, SOL on Solana, NOBLE
 *     ATOM-like on Cosmos),
 *   - USDC balance,
 *   - any extra tokens the caller asked us to track. For swap
 *     wallets the caller passes the output-mint set from
 *     `swap_transactions` so the page can flag orphaned tokens.
 *
 * Each read runs under a short timeout and falls back to a
 * `{ error }` shape rather than throwing — one bad RPC reply on a
 * single wallet must not collapse the whole page.
 *
 * Public RPC defaults match the existing onchain-balances helper:
 *   - Base:   https://mainnet.base.org   (override DASHBOARD_BASE_RPC_URL)
 *   - Solana: https://api.mainnet-beta.solana.com  (override DASHBOARD_SOLANA_RPC_URL)
 *   - Noble:  https://noble-api.polkachu.com       (override DASHBOARD_NOBLE_LCD_URL)
 */

import type { SuverseWallet } from "./suverse-wallets";
import { chainOf } from "./suverse-wallets";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOBLE_USDC_DENOM = "uusdc";
const NOBLE_NATIVE_DENOM = "unoble";

const DEFAULTS = {
  baseRpc: "https://mainnet.base.org",
  solanaRpc: "https://api.mainnet-beta.solana.com",
  nobleLcd: "https://noble-api.polkachu.com",
};

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
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

export interface TokenBalance {
  /** Symbol or short label ("ETH", "USDC", "WETH", "UNKNOWN"). */
  symbol: string;
  /** Atomic balance as base-10 string (uint256-safe). */
  amountAtomic: string;
  /** Decimal precision used to render the human amount. */
  decimals: number;
  /**
   * Optional contract / mint / denom for the token — present for
   * everything except the native gas-token. Lets the UI link out
   * to a token page on the explorer.
   */
  tokenIdentifier?: string;
}

export interface WalletBalanceSnapshot {
  walletId: string;
  address: string;
  network: SuverseWallet["network"];
  /** Native gas-token balance (always present). */
  native: TokenBalance;
  /** USDC balance (always present — common denominator across chains). */
  usdc: TokenBalance;
  /** Extra tokens the caller specifically asked us to track. */
  extras: TokenBalance[];
  /**
   * If any read failed, set here per leg ("native", "usdc",
   * "<symbol>"). null means the snapshot is fully populated.
   */
  errors: Record<string, string> | null;
}

/**
 * Spec for an extra token the caller wants tracked alongside the
 * defaults. Symbol is purely a label — the on-chain read uses
 * tokenIdentifier (contract / mint / denom) as the source of truth.
 */
export interface ExtraTokenSpec {
  symbol: string;
  decimals: number;
  tokenIdentifier: string;
}

// ---------------------------------------------------- Base (EVM) RPC ---

async function baseRpc<T>(method: string, params: unknown[]): Promise<T> {
  const rpc = env("DASHBOARD_BASE_RPC_URL", DEFAULTS.baseRpc);
  const res = await fetchWithTimeout(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`base rpc ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  if (j.result === undefined) throw new Error("no result");
  return j.result;
}

async function baseErc20Balance(token: string, owner: string): Promise<bigint> {
  const cleaned = owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const data = "0x70a08231" + cleaned;
  const hex = await baseRpc<string>("eth_call", [
    { to: token, data },
    "latest",
  ]);
  const stripped = hex.replace(/^0x/, "");
  return stripped.length === 0 ? 0n : BigInt("0x" + stripped);
}

async function baseNativeBalance(owner: string): Promise<bigint> {
  const hex = await baseRpc<string>("eth_getBalance", [owner, "latest"]);
  return BigInt(hex);
}

// ---------------------------------------------------- Solana RPC ---

async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const rpc = env("DASHBOARD_SOLANA_RPC_URL", DEFAULTS.solanaRpc);
  const res = await fetchWithTimeout(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`solana rpc ${res.status}`);
  const j = (await res.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  if (j.result === undefined) throw new Error("no result");
  return j.result;
}

async function solanaNativeBalance(owner: string): Promise<bigint> {
  // getBalance returns lamports as a number; the response shape is
  // {value: lamports, context: ...} when wrapped, but the RPC method
  // returns the value directly for getBalance.
  const r = await solanaRpc<{ value: number } | number>("getBalance", [owner]);
  const lamports = typeof r === "number" ? r : r.value;
  return BigInt(lamports);
}

async function solanaSplBalance(mint: string, owner: string): Promise<bigint> {
  // Sum amounts across every token-account the owner holds for `mint`
  // (typically one ATA, but the RPC returns an array to handle the
  // edge case of multiple accounts under the same owner).
  const r = await solanaRpc<{
    value: Array<{
      account: {
        data: { parsed: { info: { tokenAmount: { amount: string } } } };
      };
    }>;
  }>("getTokenAccountsByOwner", [
    owner,
    { mint },
    { encoding: "jsonParsed" },
  ]);
  let total = 0n;
  for (const acct of r.value ?? []) {
    const a = acct.account?.data?.parsed?.info?.tokenAmount?.amount;
    if (a && /^\d+$/.test(a)) total += BigInt(a);
  }
  return total;
}

// ---------------------------------------------------- Cosmos LCD ---

async function nobleAllBalances(
  owner: string,
): Promise<Map<string, bigint>> {
  const lcd = env("DASHBOARD_NOBLE_LCD_URL", DEFAULTS.nobleLcd).replace(
    /\/$/,
    "",
  );
  const url = `${lcd}/cosmos/bank/v1beta1/balances/${encodeURIComponent(owner)}`;
  const res = await fetchWithTimeout(url, { method: "GET" });
  if (!res.ok) throw new Error(`noble lcd ${res.status}`);
  const j = (await res.json()) as {
    balances?: Array<{ denom: string; amount: string }>;
  };
  const out = new Map<string, bigint>();
  for (const c of j.balances ?? []) {
    if (/^\d+$/.test(c.amount)) out.set(c.denom, BigInt(c.amount));
  }
  return out;
}

// ---------------------------------------------------- compose ---

/**
 * Read native + USDC + extras for a single wallet. Each leg is
 * caught individually so one slow / failed RPC doesn't take the
 * whole snapshot down.
 */
export async function readWalletBalances(
  wallet: SuverseWallet,
  extras: ExtraTokenSpec[] = [],
): Promise<WalletBalanceSnapshot> {
  const errors: Record<string, string> = {};
  const chain = chainOf(wallet);
  const result: Omit<WalletBalanceSnapshot, "errors"> = {
    walletId: wallet.id,
    address: wallet.address,
    network: wallet.network,
    native: zeroNative(chain),
    usdc: zeroUsdc(),
    extras: [],
  };

  if (chain === "base") {
    await Promise.all([
      safe("native", () =>
        baseNativeBalance(wallet.address).then((b) => {
          result.native = {
            symbol: "ETH",
            amountAtomic: b.toString(),
            decimals: 18,
          };
        }),
      ),
      safe("USDC", () =>
        baseErc20Balance(BASE_USDC, wallet.address).then((b) => {
          result.usdc = {
            symbol: "USDC",
            amountAtomic: b.toString(),
            decimals: 6,
            tokenIdentifier: BASE_USDC,
          };
        }),
      ),
      ...extras.map((e) =>
        safe(e.symbol, () =>
          baseErc20Balance(e.tokenIdentifier, wallet.address).then((b) => {
            result.extras.push({
              symbol: e.symbol,
              amountAtomic: b.toString(),
              decimals: e.decimals,
              tokenIdentifier: e.tokenIdentifier,
            });
          }),
        ),
      ),
    ]);
  } else if (chain === "solana") {
    await Promise.all([
      safe("native", () =>
        solanaNativeBalance(wallet.address).then((b) => {
          result.native = {
            symbol: "SOL",
            amountAtomic: b.toString(),
            decimals: 9,
          };
        }),
      ),
      safe("USDC", () =>
        solanaSplBalance(SOLANA_USDC_MINT, wallet.address).then((b) => {
          result.usdc = {
            symbol: "USDC",
            amountAtomic: b.toString(),
            decimals: 6,
            tokenIdentifier: SOLANA_USDC_MINT,
          };
        }),
      ),
      ...extras.map((e) =>
        safe(e.symbol, () =>
          solanaSplBalance(e.tokenIdentifier, wallet.address).then((b) => {
            result.extras.push({
              symbol: e.symbol,
              amountAtomic: b.toString(),
              decimals: e.decimals,
              tokenIdentifier: e.tokenIdentifier,
            });
          }),
        ),
      ),
    ]);
  } else {
    // cosmos / noble — a single LCD call returns all balances; we
    // index into it for native, USDC, and any extras. One round-trip.
    await safe("noble-balances", async () => {
      const all = await nobleAllBalances(wallet.address);
      result.native = {
        symbol: "NOBLE",
        amountAtomic: (all.get(NOBLE_NATIVE_DENOM) ?? 0n).toString(),
        decimals: 6,
      };
      result.usdc = {
        symbol: "USDC",
        amountAtomic: (all.get(NOBLE_USDC_DENOM) ?? 0n).toString(),
        decimals: 6,
        tokenIdentifier: NOBLE_USDC_DENOM,
      };
      for (const e of extras) {
        result.extras.push({
          symbol: e.symbol,
          amountAtomic: (all.get(e.tokenIdentifier) ?? 0n).toString(),
          decimals: e.decimals,
          tokenIdentifier: e.tokenIdentifier,
        });
      }
    });
  }

  // Keep extras output stable (Object.keys order != map iteration on
  // some V8 builds). Sort by symbol so the UI doesn't reflow.
  result.extras.sort((a, b) => a.symbol.localeCompare(b.symbol));

  return {
    ...result,
    errors: Object.keys(errors).length === 0 ? null : errors,
  };

  async function safe(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      errors[label] = err instanceof Error ? err.message : String(err);
    }
  }
}

function zeroNative(chain: "base" | "solana" | "cosmos"): TokenBalance {
  if (chain === "base") return { symbol: "ETH", amountAtomic: "0", decimals: 18 };
  if (chain === "solana") return { symbol: "SOL", amountAtomic: "0", decimals: 9 };
  return { symbol: "NOBLE", amountAtomic: "0", decimals: 6 };
}

function zeroUsdc(): TokenBalance {
  return { symbol: "USDC", amountAtomic: "0", decimals: 6 };
}
