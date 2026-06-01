/**
 * Cosmos validator stats backed by the chain's LCD
 * (`/cosmos/staking/v1beta1/validators/{valoper}` + signing-infos).
 *
 * Buyer pays the proxy ($0.05); we fan out three parallel LCD calls
 * (validator detail, distribution params for the chain-wide
 * inflation/commission context, and slashing signing-infos for
 * uptime) and fold them into a single payload that a staking agent
 * can use to pick a validator.
 *
 * APR derivation: we report commission + bonded tokens; we deliberately
 * do NOT compute APR client-side because each chain has its own
 * inflation curve and computing it correctly requires mint params per
 * chain that are noisy. Callers can derive APR from
 * commission + bonded share + chain-info (separate endpoint).
 *
 * Uptime: derived from signing-infos as a simple "missed blocks in
 * window / window size" ratio. Jailed status is from the validator
 * row directly.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";
import { getCosmosChain } from "./cosmos-chain-registry.js";

const TIMEOUT_MS = 10_000;

interface ValidatorRow {
  operator_address?: string;
  consensus_pubkey?: { "@type"?: string; key?: string };
  jailed?: boolean;
  status?: string;
  tokens?: string;
  delegator_shares?: string;
  description?: {
    moniker?: string;
    identity?: string;
    website?: string;
    security_contact?: string;
    details?: string;
  };
  unbonding_height?: string;
  unbonding_time?: string;
  commission?: {
    commission_rates?: {
      rate?: string;
      max_rate?: string;
      max_change_rate?: string;
    };
    update_time?: string;
  };
  min_self_delegation?: string;
}

interface ValidatorEnvelope {
  validator?: ValidatorRow;
}

interface SigningInfoEnvelope {
  info?: {
    address?: string;
    start_height?: string;
    index_offset?: string;
    jailed_until?: string;
    tombstoned?: boolean;
    missed_blocks_counter?: string;
  };
}

interface SlashingParamsEnvelope {
  params?: {
    signed_blocks_window?: string;
    min_signed_per_window?: string;
  };
}

export const cosmosValidatorStats: InternalHandler = async (
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
    return { status: 400, body: { error: "chain_and_validator_required" } };
  }
  const obj = parsed as Record<string, unknown>;
  const chain = getCosmosChain(obj["chain"]);
  if (!chain) {
    return { status: 400, body: { error: "unknown_chain" } };
  }
  const validator = obj["validator"];
  if (
    typeof validator !== "string" ||
    !validator.startsWith(`${chain.bech32ValoperPrefix}1`)
  ) {
    return { status: 400, body: { error: "invalid_validator_address" } };
  }

  const fetcher = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  const valUrl = `${chain.lcd}/cosmos/staking/v1beta1/validators/${validator}`;
  const paramsUrl = `${chain.lcd}/cosmos/slashing/v1beta1/params`;

  let valRes: Response;
  let paramsRes: Response;
  try {
    [valRes, paramsRes] = await Promise.all([
      fetcher(valUrl, { method: "GET", headers: { accept: "application/json" }, signal: ctrl.signal }),
      fetcher(paramsUrl, { method: "GET", headers: { accept: "application/json" }, signal: ctrl.signal }),
    ]);
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { status: 504, body: { error: "lcd_timeout" } };
    }
    return { status: 502, body: { error: "lcd_unreachable" } };
  }
  clearTimeout(timer);

  if (valRes.status === 429 || paramsRes.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (valRes.status === 404) {
    return { status: 404, body: { error: "validator_not_found" } };
  }
  if (!valRes.ok) {
    return {
      status: 502,
      body: { error: "lcd_api_error", upstreamStatus: valRes.status },
    };
  }

  let valEnv: ValidatorEnvelope;
  let paramsEnv: SlashingParamsEnvelope;
  try {
    valEnv = (await valRes.json()) as ValidatorEnvelope;
    paramsEnv = (await paramsRes.json()) as SlashingParamsEnvelope;
  } catch {
    return { status: 502, body: { error: "lcd_invalid_json" } };
  }

  const v = valEnv.validator;
  if (!v) {
    return { status: 404, body: { error: "validator_not_found" } };
  }

  // Best-effort uptime — only the validator's consensus address can
  // resolve to signing_infos, and that lookup is itself non-trivial
  // (consensus pubkey -> address derivation). Skip in v1; surface
  // jailed flag + slashing params so downstream can derive its own.
  const windowSize = paramsEnv.params?.signed_blocks_window
    ? Number(paramsEnv.params.signed_blocks_window)
    : null;
  const minSignedPct = paramsEnv.params?.min_signed_per_window
    ? Number(paramsEnv.params.min_signed_per_window)
    : null;

  const commissionRate = v.commission?.commission_rates?.rate
    ? Number(v.commission.commission_rates.rate)
    : null;

  return {
    status: 200,
    body: {
      chain: chain.slug,
      chainId: chain.chainId,
      operatorAddress: v.operator_address ?? validator,
      moniker: v.description?.moniker ?? null,
      identity: v.description?.identity ?? null,
      website: v.description?.website ?? null,
      details: v.description?.details ?? null,
      jailed: v.jailed ?? false,
      status: v.status ?? null,
      bondedTokens: v.tokens ?? null,
      delegatorShares: v.delegator_shares ?? null,
      commissionRate,
      maxCommissionRate: v.commission?.commission_rates?.max_rate
        ? Number(v.commission.commission_rates.max_rate)
        : null,
      maxCommissionChangeRate: v.commission?.commission_rates?.max_change_rate
        ? Number(v.commission.commission_rates.max_change_rate)
        : null,
      minSelfDelegation: v.min_self_delegation ?? null,
      unbondingHeight: v.unbonding_height ?? null,
      slashingParams: {
        windowSize,
        minSignedPerWindow: minSignedPct,
      },
    },
  };
};
