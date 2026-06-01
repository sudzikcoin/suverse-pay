/**
 * Cosmos wallet balance lookup backed by the native chain's LCD
 * (`/cosmos/bank/v1beta1/balances/{addr}`).
 *
 * Buyer pays the proxy ($0.10). We detect the chain from the bech32
 * address prefix (cosmos / noble / osmo / juno / stride) and query
 * the matching LCD. IBC-imported denoms are surfaced with their full
 * `ibc/<hash>` denom — denom-trace resolution is out of scope here
 * (it doubles the upstream call count and isn't free on every LCD).
 * Callers that want the underlying chain can resolve denom-trace
 * themselves with one extra LCD hop.
 *
 * Multi-chain lookup over a single wallet is intentionally not
 * supported in v1 — Cosmos uses per-chain addresses (the bech32
 * prefix is part of the identity), so a single "address" maps to
 * exactly one chain. To query across chains, hit the handler N times
 * with the per-chain address.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";
import { chainFromAddress } from "./cosmos-chain-registry.js";

const TIMEOUT_MS = 10_000;

interface BalanceEntry {
  denom?: string;
  amount?: string;
}

interface BalancesEnvelope {
  balances?: BalanceEntry[];
  pagination?: { next_key?: string | null; total?: string };
}

export const cosmosWalletBalance: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  let parsed: unknown;
  try {
    parsed =
      input.body && input.body.length > 0
        ? JSON.parse(input.body.toString("utf8"))
        : null;
  } catch {
    return { status: 400, body: { error: "invalid_json_body" } };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { status: 400, body: { error: "address_required" } };
  }
  const addr = (parsed as Record<string, unknown>)["address"];
  if (typeof addr !== "string" || addr.length < 10) {
    return { status: 400, body: { error: "invalid_address" } };
  }
  const chain = chainFromAddress(addr);
  if (!chain) {
    return { status: 400, body: { error: "unsupported_address_prefix" } };
  }

  const url = `${chain.lcd}/cosmos/bank/v1beta1/balances/${addr}?pagination.limit=100`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { status: 504, body: { error: "lcd_timeout" } };
    }
    return { status: 502, body: { error: "lcd_unreachable" } };
  }
  clearTimeout(timer);

  if (response.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (!response.ok) {
    return {
      status: 502,
      body: { error: "lcd_api_error", upstreamStatus: response.status },
    };
  }

  let envelope: BalancesEnvelope;
  try {
    envelope = (await response.json()) as BalancesEnvelope;
  } catch {
    return { status: 502, body: { error: "lcd_invalid_json" } };
  }

  const balances = (envelope.balances ?? []).map((b) => ({
    denom: b.denom ?? null,
    amount: b.amount ?? "0",
    isIbc: typeof b.denom === "string" && b.denom.startsWith("ibc/"),
    isNative: b.denom === chain.stakingDenom,
  }));
  const nativeBalance =
    balances.find((b) => b.isNative)?.amount ?? "0";
  const ibcCount = balances.filter((b) => b.isIbc).length;

  return {
    status: 200,
    body: {
      chain: chain.slug,
      chainId: chain.chainId,
      address: addr,
      nativeDenom: chain.stakingDenom,
      nativeBalance,
      balanceCount: balances.length,
      ibcDenomCount: ibcCount,
      balances,
    },
  };
};
