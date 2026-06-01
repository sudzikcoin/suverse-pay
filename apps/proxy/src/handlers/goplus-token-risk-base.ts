/**
 * ERC-20 token risk scan on Base via GoPlus Security (`token_security/8453`).
 *
 * Buyer pays the proxy ($0.20); we forward the contract address to
 * GoPlus and fold the rich 30+ field response into a normalized
 * payload with two arrays — `redFlags` and `greenFlags` — plus a
 * derived 0..100 `riskScore`. We don't reshape the entire upstream
 * doc; callers wanting raw GoPlus data get it under `raw`.
 *
 * GoPlus auth note: the public `token_security` endpoint accepts
 * unauthenticated requests. Sending a Bearer with a free-tier API
 * key (`GOPLUS_API_KEY` env) produces a confusing
 * `4012 signature verification failure`. We therefore deliberately
 * do NOT send the Authorization header — the key in env is reserved
 * for the day GoPlus moves authenticated tiers behind a different
 * auth scheme (HMAC over a v1/token request body, etc.).
 *
 * Scoring keeps it boring on purpose — each surfaced red flag is
 * worth a fixed +N penalty (mint=20, blacklist=15, honeypot=40,
 * paused=15, anti-whale-modifiable=10, owner-not-renounced=10, top-10
 * holders > 70% = 15). Capped at 100. Green flags subtract nothing —
 * they're informational. The simple model is intentional: the buyer
 * gets the raw flags too and can apply their own weighting.
 *
 * GoPlus free tier sometimes rate-limits without a 429 header; we
 * still treat 429 as 503, and any 5xx as 502.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;

interface GoPlusHolder {
  address?: string;
  percent?: string;
  is_locked?: number;
}

interface GoPlusTokenInfo {
  token_name?: string;
  token_symbol?: string;
  total_supply?: string;
  holder_count?: string;
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  owner_address?: string;
  can_take_back_ownership?: string;
  owner_change_balance?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  external_call?: string;
  is_honeypot?: string;
  transfer_pausable?: string;
  cannot_sell_all?: string;
  cannot_buy?: string;
  trading_cooldown?: string;
  is_anti_whale?: string;
  anti_whale_modifiable?: string;
  slippage_modifiable?: string;
  is_blacklisted?: string;
  is_whitelisted?: string;
  is_in_dex?: string;
  buy_tax?: string;
  sell_tax?: string;
  holders?: GoPlusHolder[];
  lp_holders?: GoPlusHolder[];
}

interface GoPlusEnvelope {
  code?: number;
  message?: string;
  result?: Record<string, GoPlusTokenInfo>;
}

function isFlag(v: string | undefined): boolean {
  return v === "1";
}

function toFloat(v: string | undefined): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const goplusTokenRiskBase: InternalHandler = async (
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

  const url = `https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${contract}`;
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
      return { status: 504, body: { error: "goplus_timeout" } };
    }
    return { status: 502, body: { error: "goplus_unreachable" } };
  }
  clearTimeout(timer);

  if (response.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (!response.ok) {
    return {
      status: 502,
      body: { error: "goplus_api_error", upstreamStatus: response.status },
    };
  }

  let envelope: GoPlusEnvelope;
  try {
    envelope = (await response.json()) as GoPlusEnvelope;
  } catch {
    return { status: 502, body: { error: "goplus_invalid_json" } };
  }

  const info = envelope.result?.[contract];
  if (!info) {
    return { status: 404, body: { error: "token_not_indexed" } };
  }

  const redFlags: Array<{ key: string; weight: number }> = [];
  const greenFlags: string[] = [];

  if (isFlag(info.is_mintable)) redFlags.push({ key: "mintable", weight: 20 });
  if (isFlag(info.is_blacklisted))
    redFlags.push({ key: "has_blacklist_function", weight: 15 });
  if (isFlag(info.is_honeypot))
    redFlags.push({ key: "honeypot_detected", weight: 40 });
  if (isFlag(info.transfer_pausable))
    redFlags.push({ key: "transfers_pausable", weight: 15 });
  if (isFlag(info.anti_whale_modifiable))
    redFlags.push({ key: "anti_whale_modifiable", weight: 10 });
  if (isFlag(info.slippage_modifiable))
    redFlags.push({ key: "slippage_modifiable", weight: 10 });
  if (isFlag(info.can_take_back_ownership))
    redFlags.push({ key: "ownership_clawback_possible", weight: 15 });
  if (isFlag(info.hidden_owner))
    redFlags.push({ key: "hidden_owner", weight: 15 });
  if (isFlag(info.selfdestruct))
    redFlags.push({ key: "selfdestruct_present", weight: 25 });
  if (isFlag(info.cannot_sell_all))
    redFlags.push({ key: "cannot_sell_all", weight: 20 });
  if (isFlag(info.cannot_buy))
    redFlags.push({ key: "cannot_buy", weight: 30 });

  const ownerAddress = info.owner_address ?? "";
  const ownerRenounced =
    ownerAddress === "" ||
    ownerAddress === "0x0000000000000000000000000000000000000000";
  if (!ownerRenounced) {
    redFlags.push({ key: "owner_not_renounced", weight: 10 });
  } else {
    greenFlags.push("owner_renounced");
  }

  if (isFlag(info.is_open_source)) greenFlags.push("source_verified");
  if (isFlag(info.is_in_dex)) greenFlags.push("listed_on_dex");

  const top10 = (info.holders ?? []).slice(0, 10);
  const top10Pct = top10.reduce(
    (acc, h) => acc + (toFloat(h.percent) ?? 0),
    0,
  );
  if (top10Pct > 0.7) {
    redFlags.push({ key: "top10_concentration_over_70pct", weight: 15 });
  } else if (top10Pct > 0 && top10Pct < 0.4) {
    greenFlags.push("top10_concentration_under_40pct");
  }

  const riskScore = Math.min(
    100,
    redFlags.reduce((acc, f) => acc + f.weight, 0),
  );

  return {
    status: 200,
    body: {
      chain: "base",
      chainId: 8453,
      contract,
      name: info.token_name ?? null,
      symbol: info.token_symbol ?? null,
      totalSupply: info.total_supply ?? null,
      holderCount: info.holder_count ? Number(info.holder_count) : null,
      buyTax: toFloat(info.buy_tax),
      sellTax: toFloat(info.sell_tax),
      ownerAddress: ownerAddress || null,
      ownerRenounced,
      top10ConcentrationPct: Number((top10Pct * 100).toFixed(2)),
      riskScore,
      verdict:
        riskScore >= 60 ? "high_risk" : riskScore >= 30 ? "medium_risk" : "low_risk",
      redFlags: redFlags.map((f) => f.key),
      greenFlags,
      raw: info,
    },
  };
};
