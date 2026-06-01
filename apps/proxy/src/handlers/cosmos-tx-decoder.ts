/**
 * Cosmos SDK transaction decoder backed by the chain's public LCD
 * (`/cosmos/tx/v1beta1/txs/{hash}`).
 *
 * Buyer pays the proxy ($0.05); we look up the chain → LCD map in
 * cosmos-chain-registry, fetch the tx, and surface the basics every
 * Cosmos analytics agent needs: each message's @type, sender/receiver
 * (where present), amounts, fee, gas, success flag, height, memo,
 * timestamp. We don't try to mirror Cosmos's nested anyOf shape —
 * each message is normalized into a flat `{type, summary, raw}`
 * triple so JS consumers don't have to dig through @type tags.
 *
 * IBC packets get a separate dedicated handler (cosmos-ibc-tracker).
 * Here we only expose the message types as-is.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";
import { getCosmosChain } from "./cosmos-chain-registry.js";

const TIMEOUT_MS = 10_000;

interface CosmosAmount {
  denom?: string;
  amount?: string;
}

interface CosmosMsg {
  "@type"?: string;
  from_address?: string;
  to_address?: string;
  delegator_address?: string;
  validator_address?: string;
  validator_src_address?: string;
  validator_dst_address?: string;
  amount?: CosmosAmount | CosmosAmount[];
  token?: CosmosAmount;
  sender?: string;
  receiver?: string;
  source_channel?: string;
  source_port?: string;
}

interface CosmosTxResponse {
  tx?: {
    body?: {
      messages?: CosmosMsg[];
      memo?: string;
      timeout_height?: string;
    };
    auth_info?: {
      fee?: { amount?: CosmosAmount[]; gas_limit?: string };
    };
  };
  tx_response?: {
    height?: string;
    txhash?: string;
    code?: number;
    raw_log?: string;
    gas_used?: string;
    gas_wanted?: string;
    timestamp?: string;
  };
}

function summarize(msg: CosmosMsg): string {
  const t = msg["@type"] ?? "";
  if (t.endsWith("MsgSend")) {
    return `Send from ${msg.from_address ?? "?"} to ${msg.to_address ?? "?"}`;
  }
  if (t.endsWith("MsgDelegate")) {
    return `Delegate to ${msg.validator_address ?? "?"}`;
  }
  if (t.endsWith("MsgUndelegate")) {
    return `Undelegate from ${msg.validator_address ?? "?"}`;
  }
  if (t.endsWith("MsgBeginRedelegate")) {
    return `Redelegate ${msg.validator_src_address ?? "?"} -> ${msg.validator_dst_address ?? "?"}`;
  }
  if (t.endsWith("MsgTransfer")) {
    return `IBC transfer ${msg.sender ?? "?"} -> ${msg.receiver ?? "?"} via ${msg.source_channel ?? "?"}`;
  }
  if (t.endsWith("MsgWithdrawDelegatorReward")) {
    return `Withdraw rewards from ${msg.validator_address ?? "?"}`;
  }
  return t.split(".").pop() ?? "Unknown message";
}

export const cosmosTxDecoder: InternalHandler = async (
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
    return { status: 400, body: { error: "chain_and_tx_hash_required" } };
  }
  const obj = parsed as Record<string, unknown>;
  const chain = getCosmosChain(obj["chain"]);
  if (!chain) {
    return { status: 400, body: { error: "unknown_chain" } };
  }
  const txHash = obj["tx_hash"];
  if (typeof txHash !== "string" || !/^[0-9a-fA-F]{64}$/.test(txHash)) {
    return { status: 400, body: { error: "invalid_tx_hash_format" } };
  }

  const url = `${chain.lcd}/cosmos/tx/v1beta1/txs/${txHash.toUpperCase()}`;
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
  if (response.status === 404) {
    return { status: 404, body: { error: "transaction_not_found" } };
  }
  if (!response.ok) {
    return {
      status: 502,
      body: { error: "lcd_api_error", upstreamStatus: response.status },
    };
  }

  let envelope: CosmosTxResponse;
  try {
    envelope = (await response.json()) as CosmosTxResponse;
  } catch {
    return { status: 502, body: { error: "lcd_invalid_json" } };
  }

  const messages = envelope.tx?.body?.messages ?? [];
  const messagesOut = messages.map((m) => ({
    type: m["@type"] ?? null,
    summary: summarize(m),
    raw: m,
  }));

  const tr = envelope.tx_response ?? {};
  const fee = envelope.tx?.auth_info?.fee?.amount ?? [];

  return {
    status: 200,
    body: {
      chain: chain.slug,
      chainId: chain.chainId,
      txHash: tr.txhash ?? txHash,
      height: tr.height ? Number(tr.height) : null,
      timestamp: tr.timestamp ?? null,
      success: (tr.code ?? 0) === 0,
      code: tr.code ?? null,
      gasUsed: tr.gas_used ? Number(tr.gas_used) : null,
      gasWanted: tr.gas_wanted ? Number(tr.gas_wanted) : null,
      fee,
      memo: envelope.tx?.body?.memo ?? "",
      messageCount: messagesOut.length,
      messages: messagesOut,
    },
  };
};
