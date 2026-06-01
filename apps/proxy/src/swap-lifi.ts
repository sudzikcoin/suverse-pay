/**
 * Thin wrapper around the public LiFi quote API (https://li.quest).
 *
 * LiFi aggregates Uniswap V3, Aerodrome, SushiSwap, KyberSwap, OneInch,
 * 0x and ~20 other Base DEXs. It returns a route quote plus a fully-
 * formed `transactionRequest` (to / data / value / gasLimit / gasPrice)
 * that we sign with the swap liquidity wallet and broadcast.
 *
 * Why LiFi instead of 1inch / 0x directly: both 1inch v6 and 0x v2 now
 * require Bearer / x-api-key authentication. LiFi's `/v1/quote` is
 * still open to anonymous callers (rate-limited per IP), which keeps
 * us key-free for v1 of the Base swap. If we hit limits we can layer a
 * key in via env later — the contract stays the same.
 *
 * `LIFI_API_BASE_URL` overrides the host. Defaults to
 * https://li.quest. `LIFI_INTEGRATOR` sets the optional integrator
 * tag used for LiFi's analytics — defaults to "suverse-pay".
 */

function baseUrl(): string {
  return process.env["LIFI_API_BASE_URL"] ?? "https://li.quest";
}
function quoteUrl(): string {
  return `${baseUrl()}/v1/quote`;
}

function integratorTag(): string {
  return process.env["LIFI_INTEGRATOR"] ?? "suverse-pay";
}

export interface LifiQuoteRequest {
  /** EIP-155 chain id, same for from/to (same-chain swaps only in v1). */
  chainId: number;
  /** Input ERC20 contract address (checksum or lowercase, viem-style 0x). */
  fromToken: string;
  /** Output ERC20 contract address. */
  toToken: string;
  /** Atomic input amount as a base-10 string. */
  fromAmount: string;
  /** Swap wallet address — both signer and (in v1) recipient of the swap output. */
  fromAddress: string;
  /** Optional explicit toAddress (LiFi defaults to fromAddress). */
  toAddress?: string;
  /** Slippage tolerance as decimal fraction. 0.01 = 1%. */
  slippage: number;
  /** Test injection seam. */
  fetchImpl?: typeof fetch;
}

/**
 * Shape of the subset of LiFi's quote response we depend on. LiFi
 * returns a lot more (gas cost estimates, fee breakdowns, route plan,
 * etc.) but the orchestrator only needs the action / estimate /
 * transactionRequest triple.
 */
export interface LifiQuoteResponse {
  /** Quote id (LiFi-internal). Logged for debugging only. */
  id: string;
  /** Sub-tool LiFi routed through, e.g. "sushiswap", "1inch". */
  tool: string;
  estimate: {
    /** Spender for our ERC20 approval. */
    approvalAddress: string;
    /** Quoted output (best estimate). */
    toAmount: string;
    /** Slippage-protected minimum output. */
    toAmountMin: string;
    /** Echo of fromAmount. */
    fromAmount: string;
  };
  transactionRequest: {
    /** Router / diamond contract to call. */
    to: string;
    /** Hex calldata. */
    data: string;
    /** Native value as hex (0x0 for ERC20-in). */
    value: string;
    /** Optional fields LiFi may omit when irrelevant. */
    gasLimit?: string;
    gasPrice?: string;
    chainId?: number;
  };
}

export class LifiError extends Error {
  readonly code: string;
  readonly excerpt: string;
  readonly upstreamStatus: number;
  constructor(code: string, excerpt: string, upstreamStatus: number) {
    super(`${code}: ${excerpt}`);
    this.code = code;
    this.excerpt = excerpt;
    this.upstreamStatus = upstreamStatus;
  }
}

/**
 * Fetch a same-chain Base swap quote from LiFi. Returns the raw
 * response on 2xx; throws `LifiError` on non-2xx so the caller can
 * surface a structured 502/400.
 */
export async function fetchLifiQuote(
  req: LifiQuoteRequest,
): Promise<LifiQuoteResponse> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const url = new URL(quoteUrl());
  url.searchParams.set("fromChain", String(req.chainId));
  url.searchParams.set("toChain", String(req.chainId));
  url.searchParams.set("fromToken", req.fromToken);
  url.searchParams.set("toToken", req.toToken);
  url.searchParams.set("fromAmount", req.fromAmount);
  url.searchParams.set("fromAddress", req.fromAddress);
  url.searchParams.set("toAddress", req.toAddress ?? req.fromAddress);
  url.searchParams.set("slippage", String(req.slippage));
  url.searchParams.set("integrator", integratorTag());
  // Limit to direct swap tools — no cross-chain bridges, no multi-hop
  // bridge+swap (we already constrain fromChain=toChain).
  url.searchParams.set("order", "CHEAPEST");

  const res = await fetchImpl(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new LifiError(
      `lifi_quote_${res.status}`,
      excerpt(text),
      res.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LifiError("lifi_quote_invalid_json", excerpt(text), res.status);
  }
  if (!isQuoteShape(parsed)) {
    throw new LifiError(
      "lifi_quote_unexpected_shape",
      excerpt(text),
      res.status,
    );
  }
  return parsed;
}

function excerpt(s: string): string {
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

function isQuoteShape(v: unknown): v is LifiQuoteResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  const est = r["estimate"] as Record<string, unknown> | undefined;
  const tx = r["transactionRequest"] as Record<string, unknown> | undefined;
  if (typeof r["id"] !== "string" || typeof r["tool"] !== "string") return false;
  if (!est || typeof est !== "object") return false;
  if (
    typeof est["approvalAddress"] !== "string" ||
    typeof est["toAmount"] !== "string" ||
    typeof est["toAmountMin"] !== "string" ||
    typeof est["fromAmount"] !== "string"
  ) {
    return false;
  }
  if (!tx || typeof tx !== "object") return false;
  if (
    typeof tx["to"] !== "string" ||
    typeof tx["data"] !== "string" ||
    typeof tx["value"] !== "string"
  ) {
    return false;
  }
  return true;
}
