/**
 * Solana wallet history backed by Helius Enhanced Transactions REST
 * API (`/v0/addresses/{address}/transactions`).
 *
 * Buyer pays the proxy ($0.05), then we ask Helius for the parsed
 * recent transactions of the wallet — types (SWAP, TRANSFER,
 * NFT_SALE, etc.), token + native transfers, fees, timestamps. The
 * upstream returns an array of normalized transactions which we pass
 * through verbatim; reshaping it would just hide useful fields from
 * tomorrow's caller.
 *
 * Pagination is via Helius's `before` cursor (last signature in the
 * previous page). Cap `limit` at 100, the upstream's documented max.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

export const heliusWalletHistory: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const apiKey = process.env["HELIUS_API_KEY"];
  if (!apiKey) {
    return { status: 503, body: { error: "helius_not_configured" } };
  }

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
  const address = obj["address"];
  if (typeof address !== "string" || address.length === 0) {
    return { status: 400, body: { error: "address_required" } };
  }
  if (address.length < 32 || address.length > 44) {
    return { status: 400, body: { error: "invalid_address_format" } };
  }

  let limit = 10;
  const rawLimit = obj["limit"];
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1) {
      return { status: 400, body: { error: "invalid_limit" } };
    }
    limit = Math.min(rawLimit, 100);
  }

  const before = obj["before"];
  if (before !== undefined && typeof before !== "string") {
    return { status: 400, body: { error: "invalid_before_cursor" } };
  }

  const params = new URLSearchParams();
  params.set("api-key", apiKey);
  params.set("limit", String(limit));
  if (typeof before === "string" && before.length > 0) {
    params.set("before", before);
  }

  const url = `https://api.helius.xyz/v0/addresses/${encodeURIComponent(
    address,
  )}/transactions?${params.toString()}`;

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, { method: "GET" });
  } catch {
    return { status: 502, body: { error: "helius_unreachable" } };
  }

  if (!response.ok) {
    return {
      status: 502,
      body: { error: "helius_api_error", upstreamStatus: response.status },
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { status: 502, body: { error: "helius_invalid_json" } };
  }

  if (!Array.isArray(data)) {
    return { status: 502, body: { error: "helius_unexpected_shape" } };
  }

  return {
    status: 200,
    body: {
      address,
      count: data.length,
      transactions: data,
    },
  };
};
