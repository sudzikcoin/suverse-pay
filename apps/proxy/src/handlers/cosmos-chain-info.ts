/**
 * Cosmos chain network info aggregator backed by 4 parallel LCD
 * reads — latest block, total supply, staking pool (bonded ratio),
 * and active validator count.
 *
 * Buyer pays the proxy ($0.05). We deliberately do NOT call the mint
 * module here: not every Cosmos SDK chain exposes a mint endpoint
 * (Noble's tokenomics, for example, are governance-controlled and
 * mint/inflation isn't a meaningful concept). Inflation/APR are
 * therefore omitted in v1 rather than computed wrong.
 *
 * Block-time derivation: we sample latest_height + (latest_height -
 * 10) and divide the timestamp delta by 10. Cheap, good enough for
 * a network-health snapshot.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";
import { getCosmosChain } from "./cosmos-chain-registry.js";

const TIMEOUT_MS = 10_000;

interface BlockEnvelope {
  block?: {
    header?: {
      height?: string;
      time?: string;
      chain_id?: string;
    };
  };
}

interface SupplyEntry {
  denom?: string;
  amount?: string;
}

interface SupplyEnvelope {
  supply?: SupplyEntry[];
  pagination?: { total?: string };
}

interface PoolEnvelope {
  pool?: {
    bonded_tokens?: string;
    not_bonded_tokens?: string;
  };
}

interface ValidatorsEnvelope {
  pagination?: { total?: string };
}

export const cosmosChainInfo: InternalHandler = async (
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
    return { status: 400, body: { error: "chain_required" } };
  }
  const chain = getCosmosChain((parsed as Record<string, unknown>)["chain"]);
  if (!chain) {
    return { status: 400, body: { error: "unknown_chain" } };
  }

  const fetcher = input.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  const latestUrl = `${chain.lcd}/cosmos/base/tendermint/v1beta1/blocks/latest`;
  const supplyUrl = `${chain.lcd}/cosmos/bank/v1beta1/supply?pagination.limit=200`;
  const poolUrl = `${chain.lcd}/cosmos/staking/v1beta1/pool`;
  const validatorsUrl = `${chain.lcd}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.count_total=true&pagination.limit=1`;

  let latestRes: Response;
  let supplyRes: Response;
  let poolRes: Response;
  let validatorsRes: Response;
  try {
    [latestRes, supplyRes, poolRes, validatorsRes] = await Promise.all([
      fetcher(latestUrl, { method: "GET", headers: { accept: "application/json" }, signal: ctrl.signal }),
      fetcher(supplyUrl, { method: "GET", headers: { accept: "application/json" }, signal: ctrl.signal }),
      fetcher(poolUrl, { method: "GET", headers: { accept: "application/json" }, signal: ctrl.signal }),
      fetcher(validatorsUrl, { method: "GET", headers: { accept: "application/json" }, signal: ctrl.signal }),
    ]);
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      return { status: 504, body: { error: "lcd_timeout" } };
    }
    return { status: 502, body: { error: "lcd_unreachable" } };
  }
  clearTimeout(timer);

  for (const r of [latestRes, supplyRes, poolRes, validatorsRes]) {
    if (r.status === 429) {
      return { status: 503, body: { error: "rate_limit_upstream" } };
    }
    if (!r.ok) {
      return {
        status: 502,
        body: { error: "lcd_api_error", upstreamStatus: r.status },
      };
    }
  }

  let latestEnv: BlockEnvelope;
  let supplyEnv: SupplyEnvelope;
  let poolEnv: PoolEnvelope;
  let validatorsEnv: ValidatorsEnvelope;
  try {
    latestEnv = (await latestRes.json()) as BlockEnvelope;
    supplyEnv = (await supplyRes.json()) as SupplyEnvelope;
    poolEnv = (await poolRes.json()) as PoolEnvelope;
    validatorsEnv = (await validatorsRes.json()) as ValidatorsEnvelope;
  } catch {
    return { status: 502, body: { error: "lcd_invalid_json" } };
  }

  const latestHeader = latestEnv.block?.header;
  const latestHeight = latestHeader?.height ? Number(latestHeader.height) : null;

  // Block-time sample: best-effort fetch of (height-10) to derive avg.
  let avgBlockTime: number | null = null;
  if (latestHeight !== null && latestHeight > 10 && latestHeader?.time) {
    try {
      const sampleRes = await fetcher(
        `${chain.lcd}/cosmos/base/tendermint/v1beta1/blocks/${latestHeight - 10}`,
        { method: "GET", headers: { accept: "application/json" } },
      );
      if (sampleRes.ok) {
        const sample = (await sampleRes.json()) as BlockEnvelope;
        const sampleTime = sample.block?.header?.time;
        if (sampleTime) {
          const dt =
            (new Date(latestHeader.time).getTime() -
              new Date(sampleTime).getTime()) /
            10000;
          if (Number.isFinite(dt) && dt > 0) {
            avgBlockTime = Number(dt.toFixed(3));
          }
        }
      }
    } catch {
      // sampling failure is non-fatal; we still return the snapshot.
    }
  }

  const stakingSupply = (supplyEnv.supply ?? []).find(
    (s) => s.denom === chain.stakingDenom,
  );
  const totalSupply = stakingSupply?.amount ?? null;
  const bonded = poolEnv.pool?.bonded_tokens ?? null;
  let bondedRatio: number | null = null;
  if (totalSupply && bonded) {
    try {
      const t = BigInt(totalSupply);
      const b = BigInt(bonded);
      if (t > 0n) {
        bondedRatio = Number((b * 10000n) / t) / 10000;
      }
    } catch {
      bondedRatio = null;
    }
  }

  return {
    status: 200,
    body: {
      chain: chain.slug,
      chainId: latestHeader?.chain_id ?? chain.chainId,
      latestHeight,
      latestBlockTime: latestHeader?.time ?? null,
      avgBlockTimeSeconds: avgBlockTime,
      stakingDenom: chain.stakingDenom,
      totalStakingSupply: totalSupply,
      bondedTokens: bonded,
      notBondedTokens: poolEnv.pool?.not_bonded_tokens ?? null,
      bondedRatio,
      activeValidatorCount:
        validatorsEnv.pagination?.total !== undefined
          ? Number(validatorsEnv.pagination.total)
          : null,
      denomCount:
        supplyEnv.pagination?.total !== undefined
          ? Number(supplyEnv.pagination.total)
          : (supplyEnv.supply?.length ?? null),
    },
  };
};
