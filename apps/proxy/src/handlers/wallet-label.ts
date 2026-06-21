/**
 * wallet-label-lookup — entity label for a wallet from our own
 * heuristic-labeling table (sm_wallet_labels): is it a contract, a CEX
 * deposit address, a market maker, a token deployer, an LP actor, or a
 * probable bot — with the supporting evidence and confidence.
 *
 * Source: sm_wallet_labels (internal; ~11.5k Solana + Base addresses).
 * An UNLABELED address is a legitimate 200 answer ({ labeled: false }),
 * not an error — absence of a label is itself information.
 *
 * Fail-closed: the preflight proves sm_wallet_labels is reachable BEFORE
 * settlement (a down table = 503, no charge) and threads the row through
 * as preflightData. A present-but-malformed address is rejected 422
 * pre-challenge; an empty/placeholder body passes to the 402 challenge
 * so crawlers read the input_schema.
 *
 * Accepts an EVM address (0x + 40 hex) OR a Solana base58 address. The
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
  const raw = obj["address"];
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
  // EVM addresses are stored lowercase in the labeler; normalize.
  const normAddr = EVM_RE.test(address) ? address.toLowerCase() : address;
  return { kind: "ok", address: normAddr, chain };
}

export const walletLabelInputSchema: InternalHandlerInputSchema = {
  method: "POST",
  content_type: "application/json",
  body: {
    type: "object",
    required: ["address"],
    properties: {
      address: {
        type: "string",
        description:
          "Wallet address to label: EVM (0x + 40 hex) or Solana base58 (32-44 chars).",
        pattern: "^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$",
      },
      chain: {
        type: "string",
        description: "Optional chain override (base | solana); auto-detected otherwise.",
        pattern: "^(base|solana)$",
      },
    },
  },
  example: { address: "0x28c6c06298d514db089934071355e5743bf21d60" },
};

export const walletLabelValidator: InternalHandlerValidator = (body) => {
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
        body: { error: "address_required", expected: walletLabelInputSchema.example },
      };
    case "invalid_value":
      return {
        status: 422,
        body: {
          error: "invalid_address",
          detail: "address must be an EVM (0x+40hex) or Solana base58 address",
          expected: walletLabelInputSchema.example,
        },
      };
    case "invalid_chain":
      return {
        status: 422,
        body: { error: "invalid_chain", detail: "chain must be base or solana", received: p.value },
      };
  }
};

const LABEL_SQL = `
  SELECT wallet_address, chain, is_contract, is_cex_deposit, is_market_maker,
         is_deployer, is_lp_actor, is_probable_bot, source_confidence,
         evidence, last_observed_at
    FROM sm_wallet_labels
   WHERE wallet_address = $1 AND ($2::text IS NULL OR chain = $2)
   ORDER BY last_observed_at DESC NULLS LAST
   LIMIT 1`;

interface LabelCritical {
  kind: "wallet_label_critical";
  address: string;
  chain: Chain | null;
  row: Record<string, unknown> | null;
}

function isLabelCritical(v: unknown): v is LabelCritical {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as LabelCritical).kind === "wallet_label_critical"
  );
}

async function queryLabel(
  db: DbQuerier,
  address: string,
  chain: Chain | null,
): Promise<LabelCritical> {
  const { rows } = await db.query(LABEL_SQL, [address, chain]);
  return { kind: "wallet_label_critical", address, chain, row: rows[0] ?? null };
}

function asIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function asBool(v: unknown): boolean {
  return v === true || v === "t" || v === "true";
}

export function buildLabelResponse(c: LabelCritical): Record<string, unknown> {
  if (c.row === null) {
    return {
      address: c.address,
      chain: c.chain,
      labeled: false,
      summary: "No entity label on record for this address in our heuristic labeling set.",
      labels: [],
    };
  }
  const r = c.row;
  const flags: Record<string, boolean> = {
    is_contract: asBool(r["is_contract"]),
    is_cex_deposit: asBool(r["is_cex_deposit"]),
    is_market_maker: asBool(r["is_market_maker"]),
    is_deployer: asBool(r["is_deployer"]),
    is_lp_actor: asBool(r["is_lp_actor"]),
    is_probable_bot: asBool(r["is_probable_bot"]),
  };
  const labels = Object.entries(flags)
    .filter(([, v]) => v)
    .map(([k]) => k.replace(/^is_/, ""));
  return {
    address: c.address,
    chain: (r["chain"] as string | null) ?? c.chain,
    labeled: labels.length > 0,
    summary:
      labels.length > 0
        ? `Labeled as: ${labels.join(", ")} (confidence ${String(r["source_confidence"] ?? "unknown")}).`
        : "Address is tracked but carries no positive entity label.",
    labels,
    flags,
    source_confidence: (r["source_confidence"] as string | null) ?? null,
    evidence: r["evidence"] ?? null,
    last_observed_at: asIso(r["last_observed_at"]),
  };
}

export const walletLabelPreflight: InternalHandlerPreflight = async (input) => {
  const p = parseAddrBody(input.body);
  if (p.kind !== "ok") {
    // A paid request with a discovery/garbage body lands here (validator
    // lets empty bodies through to the 402). Never settle on it.
    return {
      proceed: false,
      status: 422,
      body: { error: "invalid_address", input_schema: walletLabelInputSchema },
    };
  }
  if (!input.db) {
    return {
      proceed: false,
      status: 503,
      body: { error: "critical_source_unavailable", source: "sm_wallet_labels", retryable: true },
    };
  }
  try {
    const critical = await queryLabel(input.db, p.address, p.chain);
    return { proceed: true, data: critical };
  } catch (err) {
    return {
      proceed: false,
      status: 503,
      body: {
        error: "critical_source_unavailable",
        source: "sm_wallet_labels",
        detail: (err as Error).message ?? "unknown",
        retryable: true,
      },
    };
  }
};

export const walletLabel: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const rejected = walletLabelValidator(input.body, input.method);
  if (rejected) return rejected;
  const p = parseAddrBody(input.body);
  if (p.kind !== "ok") {
    return { status: 422, body: { error: "invalid_address" } };
  }
  let critical: LabelCritical;
  if (isLabelCritical(input.preflightData) && input.preflightData.address === p.address) {
    critical = input.preflightData;
  } else {
    if (!input.db) {
      return {
        status: 503,
        body: { error: "critical_source_unavailable", source: "sm_wallet_labels", retryable: true },
      };
    }
    try {
      critical = await queryLabel(input.db, p.address, p.chain);
    } catch (err) {
      return {
        status: 503,
        body: {
          error: "critical_source_unavailable",
          source: "sm_wallet_labels",
          detail: (err as Error).message ?? "unknown",
          retryable: true,
        },
      };
    }
  }
  return { status: 200, body: buildLabelResponse(critical) };
};
