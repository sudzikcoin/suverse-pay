/**
 * Solana NFT metadata lookup backed by Helius RPC `getAsset` (DAS).
 *
 * Buyer pays the proxy ($0.05), then we ask the Digital Asset Standard
 * API for the asset's full metadata. Covers regular Metaplex Token
 * Metadata NFTs and compressed NFTs (cNFT) under one call — the buyer
 * doesn't need to know which kind they're looking up.
 *
 * We return the raw DAS asset object trimmed to the fields a typical
 * consumer cares about (content, ownership, creators, royalty, supply,
 * mutability, compression flag) rather than passing the full RPC
 * envelope through. Anything we don't surface here, the caller would
 * have to round-trip through us anyway, so we may as well shape it
 * once.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

interface DasAsset {
  id?: string;
  interface?: string;
  content?: unknown;
  authorities?: unknown;
  compression?: unknown;
  grouping?: unknown;
  royalty?: unknown;
  creators?: unknown;
  ownership?: unknown;
  supply?: unknown;
  mutable?: boolean;
  burnt?: boolean;
}

interface RpcResponse {
  result?: DasAsset | null;
  error?: { code?: number; message?: string };
}

export const heliusNftMetadata: InternalHandler = async (
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

  const mint =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["mint"]
      : undefined;

  if (typeof mint !== "string" || mint.length === 0) {
    return { status: 400, body: { error: "mint_required" } };
  }

  // Solana base58 addresses are 32-44 chars. Reject obvious garbage
  // before burning a Helius credit.
  if (mint.length < 32 || mint.length > 44) {
    return { status: 400, body: { error: "invalid_mint_format" } };
  }

  const url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getAsset",
        params: { id: mint },
      }),
    });
  } catch {
    return { status: 502, body: { error: "helius_unreachable" } };
  }

  if (!response.ok) {
    return {
      status: 502,
      body: { error: "helius_api_error", upstreamStatus: response.status },
    };
  }

  let data: RpcResponse;
  try {
    data = (await response.json()) as RpcResponse;
  } catch {
    return { status: 502, body: { error: "helius_invalid_json" } };
  }

  if (data.error) {
    return {
      status: 404,
      body: {
        error: "asset_not_found",
        code: data.error.code ?? null,
        message: data.error.message ?? null,
      },
    };
  }

  const asset = data.result;
  if (!asset || !asset.id) {
    return { status: 404, body: { error: "asset_not_found" } };
  }

  return {
    status: 200,
    body: {
      id: asset.id,
      interface: asset.interface ?? null,
      content: asset.content ?? null,
      authorities: asset.authorities ?? [],
      compression: asset.compression ?? null,
      grouping: asset.grouping ?? [],
      royalty: asset.royalty ?? null,
      creators: asset.creators ?? [],
      ownership: asset.ownership ?? null,
      supply: asset.supply ?? null,
      mutable: asset.mutable ?? null,
      burnt: asset.burnt ?? null,
    },
  };
};
