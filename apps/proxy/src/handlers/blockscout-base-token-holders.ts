/**
 * ERC-20 token holder distribution on Base via Blockscout
 * (`base.blockscout.com/api/v2/tokens/{addr}/holders`) plus the
 * /counters and /tokens/{addr} endpoints for supply totals.
 *
 * Buyer pays the proxy ($0.10). We surface the top holders (up to
 * Blockscout's per-page max of 50) and derive concentration metrics:
 * cumulative top-10 share, top-1 share, and a flag for any holder
 * over 1% of supply. Etherscan's `tokenholderlist` is PRO-only, so
 * Blockscout is the only free option here.
 *
 * Gini is intentionally NOT computed — the Blockscout page is capped
 * at 50 holders, so the gini value would be misleading. Callers who
 * need the full distribution can paginate themselves; we just don't
 * pretend our 50-row sample is the population.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

// base.blockscout.com's /tokens/{addr}/holders endpoint routinely
// takes 15-20s when Cloudflare's cache is cold; observed P99 well over
// 10s. We bump the timeout above the proxy's usual 10s budget so
// callers don't see a 504 on the first cold call after deploy.
const TIMEOUT_MS = 25_000;

interface BlockscoutHolder {
  address?: { hash?: string; is_contract?: boolean } | null;
  value?: string;
  token_id?: string | null;
}

interface BlockscoutHoldersEnvelope {
  items?: BlockscoutHolder[];
  next_page_params?: Record<string, unknown> | null;
}

interface BlockscoutTokenInfo {
  address?: string;
  name?: string | null;
  symbol?: string | null;
  decimals?: string | null;
  total_supply?: string | null;
  holders?: string | null;
  type?: string | null;
}

export const blockscoutBaseTokenHolders: InternalHandler = async (
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
    return { status: 400, body: { error: "contract_address_required" } };
  }
  const raw = (parsed as Record<string, unknown>)["contract_address"];
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return { status: 400, body: { error: "invalid_contract_address" } };
  }
  const contract = raw.toLowerCase();

  const fetcher = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  const holdersUrl = `https://base.blockscout.com/api/v2/tokens/${contract}/holders`;
  const tokenInfoUrl = `https://base.blockscout.com/api/v2/tokens/${contract}`;

  let holdersRes: Response;
  let tokenRes: Response;
  try {
    [holdersRes, tokenRes] = await Promise.all([
      fetcher(holdersUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      }),
      fetcher(tokenInfoUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      }),
    ]);
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { status: 504, body: { error: "blockscout_timeout" } };
    }
    return { status: 502, body: { error: "blockscout_unreachable" } };
  }
  clearTimeout(timer);

  if (holdersRes.status === 429 || tokenRes.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (holdersRes.status === 404 || tokenRes.status === 404) {
    return { status: 404, body: { error: "token_not_found" } };
  }
  if (!holdersRes.ok || !tokenRes.ok) {
    return {
      status: 502,
      body: {
        error: "blockscout_api_error",
        upstreamStatus: holdersRes.ok ? tokenRes.status : holdersRes.status,
      },
    };
  }

  let holdersEnv: BlockscoutHoldersEnvelope;
  let tokenInfo: BlockscoutTokenInfo;
  try {
    holdersEnv = (await holdersRes.json()) as BlockscoutHoldersEnvelope;
    tokenInfo = (await tokenRes.json()) as BlockscoutTokenInfo;
  } catch {
    return { status: 502, body: { error: "blockscout_invalid_json" } };
  }

  const totalSupplyRaw = tokenInfo.total_supply ?? "0";
  let totalSupply: bigint;
  try {
    totalSupply = BigInt(totalSupplyRaw);
  } catch {
    totalSupply = 0n;
  }
  const decimals = tokenInfo.decimals ? Number(tokenInfo.decimals) : null;
  const totalHolders = tokenInfo.holders ? Number(tokenInfo.holders) : null;

  const rows = Array.isArray(holdersEnv.items) ? holdersEnv.items : [];
  const holders = rows.map((h) => {
    const valRaw = h.value ?? "0";
    let val: bigint;
    try {
      val = BigInt(valRaw);
    } catch {
      val = 0n;
    }
    const pct =
      totalSupply > 0n ? Number((val * 10000n) / totalSupply) / 100 : null;
    return {
      address: h.address?.hash ?? null,
      isContract: h.address?.is_contract ?? null,
      balance: val.toString(),
      percentOfSupply: pct,
      whaleFlag: pct !== null && pct > 1,
    };
  });

  const top10Pct = holders
    .slice(0, 10)
    .reduce((acc, h) => acc + (h.percentOfSupply ?? 0), 0);
  const top1Pct = holders.length > 0 ? holders[0]!.percentOfSupply : null;
  const whaleCount = holders.filter((h) => h.whaleFlag).length;

  return {
    status: 200,
    body: {
      chain: "base",
      chainId: 8453,
      contract,
      name: tokenInfo.name ?? null,
      symbol: tokenInfo.symbol ?? null,
      decimals,
      tokenType: tokenInfo.type ?? null,
      totalSupply: totalSupply.toString(),
      totalHolders,
      sampleSize: holders.length,
      top1ConcentrationPct: top1Pct,
      top10ConcentrationPct: Number(top10Pct.toFixed(4)),
      whaleCount,
      holders,
    },
  };
};
