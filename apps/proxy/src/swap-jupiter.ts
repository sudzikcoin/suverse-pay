/**
 * Thin wrapper around the public Jupiter v6 aggregator HTTP API.
 *
 * Jupiter routes across 30+ Solana DEXs (Raydium, Orca, Meteora, …)
 * and returns the best price quote, plus a pre-built swap transaction
 * we sign and broadcast. v6 is the current GA endpoint as of 2026-05.
 *
 * Two endpoints are used:
 *   - GET  /v6/quote — price quote, free, used by both /quote and
 *     /execute (re-fetched at execute time to detect price drift).
 *   - POST /v6/swap  — turns a quote response into a signed-ready
 *     versioned transaction (base64 encoded).
 *
 * No SDK — the API is small enough to call with plain fetch, which
 * also keeps the proxy bundle slim and avoids pulling in @jup-ag/api
 * (which transitively depends on a heavy AMM math library).
 */

const QUOTE_URL = "https://quote-api.jup.ag/v6/quote";
const SWAP_URL = "https://quote-api.jup.ag/v6/swap";

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  /** Atomic units of input (uint256-safe string). */
  amount: string;
  /** Max slippage tolerance, basis points. 100 = 1%. */
  slippageBps: number;
  /** Optional injection seam for tests. */
  fetchImpl?: typeof fetch;
}

export interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot?: number;
  timeTaken?: number;
}

/**
 * Fetch a Jupiter quote. Returns the raw response on 2xx; throws
 * `JupiterError` with the upstream body excerpt on non-2xx so the
 * caller can surface a structured 502/503.
 */
export async function fetchJupiterQuote(
  req: JupiterQuoteRequest,
): Promise<JupiterQuoteResponse> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const url = new URL(QUOTE_URL);
  url.searchParams.set("inputMint", req.inputMint);
  url.searchParams.set("outputMint", req.outputMint);
  url.searchParams.set("amount", req.amount);
  url.searchParams.set("slippageBps", String(req.slippageBps));

  const res = await fetchImpl(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new JupiterError(
      `jupiter_quote_${res.status}`,
      excerpt(text),
      res.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JupiterError(
      "jupiter_quote_invalid_json",
      excerpt(text),
      res.status,
    );
  }
  if (!isQuoteShape(parsed)) {
    throw new JupiterError(
      "jupiter_quote_unexpected_shape",
      excerpt(text),
      res.status,
    );
  }
  return parsed;
}

export interface JupiterSwapRequest {
  quoteResponse: JupiterQuoteResponse;
  /** Wallet that will sign + receive output. */
  userPublicKey: string;
  /** Wrap input SOL / unwrap output SOL automatically. */
  wrapAndUnwrapSol?: boolean;
  /**
   * Optional override — if set, output tokens deposit directly to
   * this ATA instead of the user's ATA. Not used in v1 (we deposit
   * to the swap wallet so we can validate before forwarding).
   */
  destinationTokenAccount?: string;
  /**
   * Optional priority fee in microlamports per CU. Jupiter accepts
   * an auto-priority mode too but it can spike fees on busy slots;
   * we keep it predictable.
   */
  prioritizationFeeLamports?: number | "auto";
  fetchImpl?: typeof fetch;
}

export interface JupiterSwapResponse {
  /** Base64-encoded VersionedTransaction. */
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

export async function fetchJupiterSwap(
  req: JupiterSwapRequest,
): Promise<JupiterSwapResponse> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    quoteResponse: req.quoteResponse,
    userPublicKey: req.userPublicKey,
    wrapAndUnwrapSol: req.wrapAndUnwrapSol ?? true,
  };
  if (req.destinationTokenAccount) {
    body["destinationTokenAccount"] = req.destinationTokenAccount;
  }
  if (req.prioritizationFeeLamports !== undefined) {
    body["prioritizationFeeLamports"] = req.prioritizationFeeLamports;
  }
  const res = await fetchImpl(SWAP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new JupiterError(
      `jupiter_swap_${res.status}`,
      excerpt(text),
      res.status,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JupiterError(
      "jupiter_swap_invalid_json",
      excerpt(text),
      res.status,
    );
  }
  if (!isSwapShape(parsed)) {
    throw new JupiterError(
      "jupiter_swap_unexpected_shape",
      excerpt(text),
      res.status,
    );
  }
  return parsed;
}

export class JupiterError extends Error {
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

function excerpt(s: string): string {
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

function isQuoteShape(v: unknown): v is JupiterQuoteResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["inputMint"] === "string" &&
    typeof r["outputMint"] === "string" &&
    typeof r["inAmount"] === "string" &&
    typeof r["outAmount"] === "string"
  );
}

function isSwapShape(v: unknown): v is JupiterSwapResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["swapTransaction"] === "string" &&
    typeof r["lastValidBlockHeight"] === "number"
  );
}
