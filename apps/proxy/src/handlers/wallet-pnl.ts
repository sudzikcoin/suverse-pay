/**
 * wallet-pnl — profit-and-loss + skill snapshot for a single tracked
 * wallet, read straight from our own scoring table (sm_wallets): 90d PnL,
 * realized PnL, win rate, profit factor, drawdown, trade cadence and the
 * derived skill score/tier.
 *
 * Source: sm_wallets (internal; ~11.6k Solana + Base addresses, the same
 * scoring table that backs wallet-reputation and the top-wallets board).
 * An UNTRACKED address is a legitimate 200 answer ({ tracked: false }),
 * not an error — we just don't score it.
 *
 * Fail-closed: the preflight proves sm_wallets is reachable BEFORE
 * settlement (a down table = 503, no charge) and threads the row through
 * as preflightData. A present-but-malformed address is rejected 422
 * pre-challenge; an empty/placeholder body passes to the 402 challenge so
 * crawlers read the input_schema.
 *
 * Accepts an EVM address (0x + 40 hex) OR a Solana base58 address; the
 * chain is auto-detected from the address shape unless given explicitly.
 */
import type {
  DbQuerier,
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerPreflight,
  InternalHandlerResult,
  InternalHandlerValidator,
} from "./types.js";
import { isPlaceholderValue, type InternalHandlerInputSchema } from "./discovery.js";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SUPPORTED_CHAINS = ["base", "solana"] as const;
type Chain = (typeof SUPPORTED_CHAINS)[number];

// last_scored_at older than this → data_quality.stale = true.
const STALE_AFTER_HOURS = 48;

export type AddrParse =
  | { kind: "discovery" }
  | { kind: "invalid_json" }
  | { kind: "malformed" }
  | { kind: "invalid_value"; value: string }
  | { kind: "invalid_chain"; value: string }
  | { kind: "ok"; address: string; chain: Chain | null };

/** Detect chain from address shape: 0x… → base, base58 → solana. */
export function detectChain(address: string): Chain | null {
  if (EVM_RE.test(address)) return "base";
  if (SOL_RE.test(address)) return "solana";
  return null;
}

export function parseAddrBody(body: Buffer | null): AddrParse {
  if (!body || body.length === 0 || body.toString("utf8").trim() === "") {
    return { kind: "discovery" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { kind: "invalid_json" };
  }
  if (parsed === null) return { kind: "discovery" };
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed" };
  }
  const obj = parsed as Record<string, unknown>;
  const raw = obj["address"] ?? obj["wallet"];
  if (typeof raw !== "string" || isPlaceholderValue(raw)) {
    return { kind: "discovery" };
  }
  const address = raw.trim();
  const detected = detectChain(address);
  if (detected === null) {
    return { kind: "invalid_value", value: address };
  }
  let chain: Chain | null = null;
  if (obj["chain"] !== undefined && obj["chain"] !== null && obj["chain"] !== "") {
    const c = String(obj["chain"]).toLowerCase();
    if (!SUPPORTED_CHAINS.includes(c as Chain)) {
      return { kind: "invalid_chain", value: String(obj["chain"]) };
    }
    chain = c as Chain;
  } else {
    chain = detected;
  }
  // EVM addresses are stored lowercase in the scorer; normalize.
  const normAddr = EVM_RE.test(address) ? address.toLowerCase() : address;
  return { kind: "ok", address: normAddr, chain };
}

export const walletPnlInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["address"],
    properties: {
      address: {
        type: "string",
        description:
          "Wallet address to score: EVM (0x + 40 hex) or Solana base58 (32-44 chars).",
        pattern: "^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$",
      },
      chain: {
        type: "string",
        description: "Optional chain override (base | solana); auto-detected otherwise.",
        pattern: "^(base|solana)$",
      },
    },
  },
  example: { address: "8psNvWTrdNTiVRNzAgsou9kETXNJm2SXZyaKuJraVRtf" },
};

export const walletPnlValidator: InternalHandlerValidator = (body) => {
  const p = parseAddrBody(body);
  switch (p.kind) {
    case "discovery":
    case "ok":
      return null;
    case "invalid_json":
      return { status: 400, body: { error: "invalid_json_body" } };
    case "malformed":
      return {
        status: 422,
        body: { error: "address_required", expected: walletPnlInputSchema.example },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: "invalid_address",
          detail: "address must be an EVM (0x+40hex) or Solana base58 address",
          expected: walletPnlInputSchema.example,
        },
      };
    case "invalid_chain":
      return {
        status: 422,
        body: { error: "invalid_chain", detail: "chain must be base or solana", received: p.value },
      };
  }
};

// median_holding_time_seconds (NOT the deprecated rounded _hours column).
const PNL_SQL = `
  SELECT address, chain, tier, status,
         score::float8              AS score,
         confidence_score,
         pnl_90d_usd::float8        AS pnl_90d_usd,
         realized_pnl_usd::float8   AS realized_pnl_usd,
         win_rate::float8           AS win_rate,
         profit_factor::float8      AS profit_factor,
         median_return_per_trade::float8 AS median_return_per_trade,
         max_drawdown_90d::float8   AS max_drawdown_90d,
         trade_count_90d, buy_count_90d, sell_count_90d,
         early_entries_30d, days_since_last_trade,
         median_holding_time_seconds,
         last_scored_at, last_activity_at, discovered_at, score_version
    FROM sm_wallets
   WHERE address = $1 AND ($2::text IS NULL OR chain = $2)
   ORDER BY last_scored_at DESC NULLS LAST
   LIMIT 1`;

interface PnlCritical {
  kind: "wallet_pnl_critical";
  address: string;
  chain: Chain | null;
  row: Record<string, unknown> | null;
}

function isPnlCritical(v: unknown): v is PnlCritical {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as PnlCritical).kind === "wallet_pnl_critical"
  );
}

async function queryPnl(
  db: DbQuerier,
  address: string,
  chain: Chain | null,
): Promise<PnlCritical> {
  const { rows } = await db.query(PNL_SQL, [address, chain]);
  return { kind: "wallet_pnl_critical", address, chain, row: rows[0] ?? null };
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function round2(x: number | null): number | null {
  return x === null ? null : Math.round(x * 100) / 100;
}
function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}
function asIso(v: unknown): string | null {
  return asDate(v)?.toISOString() ?? null;
}

/** verdict bucket from realized/unrealized PnL. */
function profitability(pnl: number | null): "profitable" | "unprofitable" | "breakeven" | "unknown" {
  if (pnl === null) return "unknown";
  if (pnl > 1) return "profitable";
  if (pnl < -1) return "unprofitable";
  return "breakeven";
}

export function buildPnlResponse(c: PnlCritical, now: Date): Record<string, unknown> {
  if (c.row === null) {
    return {
      address: c.address,
      chain: c.chain,
      tracked: false,
      verdict: {
        profitability: "unknown",
        summary:
          "This wallet is not in our smart-money scoring set, so we have no PnL or skill metrics for it.",
        confidence: "none",
      },
      signals: null,
      data_quality: { tracking_coverage: "untracked", computed_at: now.toISOString() },
    };
  }
  const r = c.row;
  const pnl90 = round2(num(r["pnl_90d_usd"]));
  const realized = round2(num(r["realized_pnl_usd"]));
  const winRate = round2(num(r["win_rate"]));
  const profitFactor = round2(num(r["profit_factor"]));
  const score = round2(num(r["score"]));
  const confidence = num(r["confidence_score"]);
  const lastScored = asDate(r["last_scored_at"]);
  const stale =
    lastScored === null ||
    (now.getTime() - lastScored.getTime()) / 3_600_000 > STALE_AFTER_HOURS;
  const verdictPnl = realized ?? pnl90;
  const conf: "low" | "medium" | "high" =
    confidence === null ? "low" : confidence >= 70 ? "high" : confidence >= 50 ? "medium" : "low";

  return {
    address: c.address,
    chain: (r["chain"] as string | null) ?? c.chain,
    tracked: true,
    verdict: {
      profitability: profitability(verdictPnl),
      summary:
        `Over the trailing 90d this wallet shows realized PnL ${realized === null ? "n/a" : `$${realized}`}` +
        ` (unrealized-inclusive $${pnl90 ?? "n/a"}), win rate ${winRate === null ? "n/a" : `${winRate}`},` +
        ` profit factor ${profitFactor ?? "n/a"}; skill score ${score ?? "n/a"} (tier ${String(r["tier"] ?? "untiered")}).`,
      confidence: conf,
    },
    signals: {
      pnl: {
        pnl_90d_usd: pnl90,
        realized_pnl_usd: realized,
        win_rate: winRate,
        profit_factor: profitFactor,
        median_return_per_trade: round2(num(r["median_return_per_trade"])),
        max_drawdown_90d: round2(num(r["max_drawdown_90d"])),
      },
      activity: {
        trade_count_90d: num(r["trade_count_90d"]),
        buy_count_90d: num(r["buy_count_90d"]),
        sell_count_90d: num(r["sell_count_90d"]),
        early_entries_30d: num(r["early_entries_30d"]),
        median_holding_time_seconds: num(r["median_holding_time_seconds"]),
        days_since_last_trade: num(r["days_since_last_trade"]),
        last_activity_at: asIso(r["last_activity_at"]),
      },
      skill: {
        score,
        confidence_score: confidence,
        tier: (r["tier"] as string | null) ?? null,
        status: (r["status"] as string | null) ?? null,
        score_version: (r["score_version"] as string | null) ?? null,
      },
    },
    data_quality: {
      tracking_coverage: "tracked",
      stale,
      last_scored_at: asIso(r["last_scored_at"]),
      first_seen: asIso(r["discovered_at"]),
      computed_at: now.toISOString(),
    },
    raw: { sm_wallets_row: r },
  };
}

export const walletPnlPreflight: InternalHandlerPreflight = async (input) => {
  const p = parseAddrBody(input.body);
  if (p.kind !== "ok") {
    // A paid request with a discovery/garbage body lands here (validator
    // lets empty bodies through to the 402). Never settle on it.
    return {
      proceed: false,
      status: 422,
      body: { error: "invalid_address", input_schema: walletPnlInputSchema },
    };
  }
  if (!input.db) {
    return {
      proceed: false,
      status: 503,
      body: { error: "critical_source_unavailable", source: "sm_wallets", retryable: true },
    };
  }
  try {
    const critical = await queryPnl(input.db, p.address, p.chain);
    return { proceed: true, data: critical };
  } catch (err) {
    return {
      proceed: false,
      status: 503,
      body: {
        error: "critical_source_unavailable",
        source: "sm_wallets",
        detail: (err as Error).message ?? "unknown",
        retryable: true,
      },
    };
  }
};

export const walletPnl: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = walletPnlValidator(input.body, input.method);
  if (rejected) return rejected;
  const p = parseAddrBody(input.body);
  if (p.kind !== "ok") {
    return { status: 422, body: { error: "invalid_address" } };
  }
  const now = new Date();
  let critical: PnlCritical;
  if (isPnlCritical(input.preflightData) && input.preflightData.address === p.address) {
    critical = input.preflightData;
  } else {
    if (!input.db) {
      return {
        status: 503,
        body: { error: "critical_source_unavailable", source: "sm_wallets", retryable: true },
      };
    }
    try {
      critical = await queryPnl(input.db, p.address, p.chain);
    } catch (err) {
      return {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "sm_wallets",
          detail: (err as Error).message ?? "unknown",
          retryable: true,
        },
      };
    }
  }
  return { status: 200, body: buildPnlResponse(critical, now) };
};
