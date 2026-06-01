/**
 * IBC transfer tracker backed by the source chain's LCD
 * (`/cosmos/tx/v1beta1/txs/{hash}` + the embedded send_packet event).
 *
 * Buyer pays the proxy ($0.10); we resolve the source chain via the
 * supplied `chain` slug, pull the tx, and extract the IBC envelope —
 * source channel + port, destination channel + port, packet sequence,
 * timeout, sender, receiver, token denom + amount, and the lifecycle
 * status as far as we can see it from the source-chain side
 * ("sent" / "acknowledged"; "timed_out" if a timeout-packet message
 * also appears in this tx, "in_flight" if no ack-yet event).
 *
 * Cross-chain ack lookup would need the destination chain's LCD too;
 * that's a much bigger surface (you have to know which counterparty
 * chain to query) so v1 stops at source-side visibility. Callers
 * watching for completion should poll the destination chain
 * themselves once they have channel + sequence.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";
import { getCosmosChain } from "./cosmos-chain-registry.js";

const TIMEOUT_MS = 10_000;

interface CosmosEventAttr {
  key?: string;
  value?: string;
}

interface CosmosEvent {
  type?: string;
  attributes?: CosmosEventAttr[];
}

interface CosmosTxEnvelope {
  tx_response?: {
    height?: string;
    txhash?: string;
    code?: number;
    raw_log?: string;
    timestamp?: string;
    events?: CosmosEvent[];
  };
  tx?: {
    body?: {
      messages?: Array<Record<string, unknown>>;
    };
  };
}

function attr(ev: CosmosEvent | undefined, key: string): string | null {
  if (!ev || !Array.isArray(ev.attributes)) return null;
  for (const a of ev.attributes) {
    if (a.key === key && typeof a.value === "string") return a.value;
  }
  return null;
}

export const cosmosIbcTracker: InternalHandler = async (
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

  let envelope: CosmosTxEnvelope;
  try {
    envelope = (await response.json()) as CosmosTxEnvelope;
  } catch {
    return { status: 502, body: { error: "lcd_invalid_json" } };
  }

  const tr = envelope.tx_response ?? {};
  const success = (tr.code ?? 0) === 0;
  const events = Array.isArray(tr.events) ? tr.events : [];

  const sendPacket = events.find((e) => e.type === "send_packet");
  const ibcTransferMsg = events.find((e) => e.type === "ibc_transfer");
  const timeoutEv = events.find((e) => e.type === "timeout_packet");
  const ackEv = events.find((e) => e.type === "acknowledge_packet");

  if (!sendPacket && !ibcTransferMsg && !timeoutEv) {
    return {
      status: 200,
      body: {
        chain: chain.slug,
        chainId: chain.chainId,
        txHash: tr.txhash ?? txHash,
        ibcDetected: false,
        success,
        height: tr.height ? Number(tr.height) : null,
        timestamp: tr.timestamp ?? null,
      },
    };
  }

  const status =
    timeoutEv !== undefined
      ? "timed_out"
      : ackEv !== undefined
        ? "acknowledged"
        : "in_flight";

  return {
    status: 200,
    body: {
      chain: chain.slug,
      chainId: chain.chainId,
      txHash: tr.txhash ?? txHash,
      ibcDetected: true,
      success,
      height: tr.height ? Number(tr.height) : null,
      timestamp: tr.timestamp ?? null,
      status,
      sourceChannel: attr(sendPacket, "packet_src_channel"),
      sourcePort: attr(sendPacket, "packet_src_port"),
      destChannel: attr(sendPacket, "packet_dst_channel"),
      destPort: attr(sendPacket, "packet_dst_port"),
      sequence: attr(sendPacket, "packet_sequence"),
      timeoutHeight: attr(sendPacket, "packet_timeout_height"),
      timeoutTimestamp: attr(sendPacket, "packet_timeout_timestamp"),
      sender: attr(ibcTransferMsg, "sender"),
      receiver: attr(ibcTransferMsg, "receiver"),
      denom: attr(ibcTransferMsg, "denom"),
      amount: attr(ibcTransferMsg, "amount"),
    },
  };
};
