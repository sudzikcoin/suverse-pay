/**
 * Base wallet transaction history backed by Blockscout
 * (`base.blockscout.com/api/v2/addresses/{addr}/transactions`).
 *
 * Buyer pays the proxy ($0.10). We use Blockscout — not Etherscan —
 * because the Etherscan free tier does not cover Base's account
 * module. Blockscout V2 returns a richer per-tx shape than the
 * Etherscan envelope, so we map down to the seven fields a portfolio
 * agent typically wants and drop everything else.
 *
 * Pagination is exposed through `before_block` if the caller wants
 * the next page. Limit is enforced client-side (Blockscout's page
 * size is fixed at 50 per response).
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

interface BlockscoutTx {
  hash?: string;
  block_number?: number;
  timestamp?: string;
  from?: { hash?: string } | null;
  to?: { hash?: string } | null;
  value?: string;
  gas_used?: string;
  gas_price?: string;
  status?: string;
  result?: string;
  method?: string | null;
  transaction_types?: string[];
  fee?: { value?: string } | null;
  created_contract?: { hash?: string } | null;
}

interface BlockscoutEnvelope {
  items?: BlockscoutTx[];
  next_page_params?: Record<string, unknown> | null;
}

export const blockscoutBaseWalletHistory: InternalHandler = async (
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
    return { status: 400, body: { error: "address_required" } };
  }
  const obj = parsed as Record<string, unknown>;
  const addr = obj["address"];
  if (typeof addr !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return { status: 400, body: { error: "invalid_address_format" } };
  }
  const rawLimit = obj["limit"];
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit)) {
      return { status: 400, body: { error: "limit_must_be_integer" } };
    }
    if (rawLimit < 1 || rawLimit > MAX_LIMIT) {
      return {
        status: 400,
        body: { error: "limit_out_of_range", max: MAX_LIMIT },
      };
    }
    limit = rawLimit;
  }

  const url = `https://base.blockscout.com/api/v2/addresses/${addr}/transactions`;
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
      return { status: 504, body: { error: "blockscout_timeout" } };
    }
    return { status: 502, body: { error: "blockscout_unreachable" } };
  }
  clearTimeout(timer);

  if (response.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (response.status === 404) {
    return {
      status: 200,
      body: {
        chain: "base",
        chainId: 8453,
        address: addr,
        limit,
        count: 0,
        transactions: [],
        nextPageCursor: null,
      },
    };
  }
  if (!response.ok) {
    return {
      status: 502,
      body: { error: "blockscout_api_error", upstreamStatus: response.status },
    };
  }

  let envelope: BlockscoutEnvelope;
  try {
    envelope = (await response.json()) as BlockscoutEnvelope;
  } catch {
    return { status: 502, body: { error: "blockscout_invalid_json" } };
  }

  const rows = Array.isArray(envelope.items) ? envelope.items.slice(0, limit) : [];
  const transactions = rows.map((t) => {
    const valueWei = t.value ? BigInt(t.value) : null;
    const feeWei = t.fee?.value ? BigInt(t.fee.value) : null;
    return {
      hash: t.hash ?? null,
      blockNumber: typeof t.block_number === "number" ? t.block_number : null,
      timestamp: t.timestamp ?? null,
      from: t.from?.hash ?? null,
      to: t.to?.hash ?? null,
      valueWei: valueWei?.toString() ?? null,
      valueEth: valueWei !== null ? Number(valueWei) / 1e18 : null,
      feeWei: feeWei?.toString() ?? null,
      success: t.status === "ok" || t.result === "success",
      method: t.method ?? null,
      types: Array.isArray(t.transaction_types) ? t.transaction_types : [],
      createdContract: t.created_contract?.hash ?? null,
    };
  });

  const nextParams = envelope.next_page_params ?? null;
  return {
    status: 200,
    body: {
      chain: "base",
      chainId: 8453,
      address: addr,
      limit,
      count: transactions.length,
      transactions,
      nextPageCursor:
        nextParams && typeof nextParams["block_number"] === "number"
          ? { beforeBlock: nextParams["block_number"] }
          : null,
    },
  };
};
