/**
 * Base verified-contract info via Etherscan V2 Multichain
 * (`chainid=8453, module=contract, action=getsourcecode`).
 *
 * Buyer pays the proxy ($0.05). Among the Etherscan V2 modules, only
 * `contract` is currently free for non-mainnet chains — `proxy` and
 * `account` require PRO — so this is the one Base lookup we keep
 * pointed at Etherscan. The rest of the Base group runs on the public
 * Base RPC + Blockscout.
 *
 * The handler intentionally truncates the source code body to 64 KiB
 * so a verified large multi-file contract (5+ MiB SourceCode payloads
 * happen) cannot blow up the response. Callers that need the full
 * source can hit Etherscan themselves with the same `address`.
 */
import type {
  InternalHandler,
  InternalHandlerInput,
  InternalHandlerResult,
} from "./types.js";

const TIMEOUT_MS = 10_000;
const MAX_SOURCE_BYTES = 64 * 1024;

interface EtherscanContractRow {
  SourceCode?: string;
  ABI?: string;
  ContractName?: string;
  CompilerVersion?: string;
  OptimizationUsed?: string;
  Runs?: string;
  ConstructorArguments?: string;
  EVMVersion?: string;
  Library?: string;
  LicenseType?: string;
  Proxy?: string;
  Implementation?: string;
  SwarmSource?: string;
}

interface EtherscanEnvelope {
  status?: string;
  message?: string;
  result?: EtherscanContractRow[] | string;
}

export const etherscanBaseContractInfo: InternalHandler = async (
  input: InternalHandlerInput,
): Promise<InternalHandlerResult> => {
  const apiKey = process.env["ETHERSCAN_API_KEY"];
  if (!apiKey) {
    return { status: 503, body: { error: "etherscan_not_configured" } };
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
    return { status: 400, body: { error: "contract_address_required" } };
  }
  const raw = (parsed as Record<string, unknown>)["contract_address"];
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return { status: 400, body: { error: "invalid_contract_address" } };
  }
  const contract = raw.toLowerCase();

  const params = new URLSearchParams();
  params.set("chainid", "8453");
  params.set("module", "contract");
  params.set("action", "getsourcecode");
  params.set("address", contract);
  params.set("apikey", apiKey);
  const url = `https://api.etherscan.io/v2/api?${params.toString()}`;

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
      return { status: 504, body: { error: "etherscan_timeout" } };
    }
    return { status: 502, body: { error: "etherscan_unreachable" } };
  }
  clearTimeout(timer);

  if (response.status === 429) {
    return { status: 503, body: { error: "rate_limit_upstream" } };
  }
  if (!response.ok) {
    return {
      status: 502,
      body: { error: "etherscan_api_error", upstreamStatus: response.status },
    };
  }

  let envelope: EtherscanEnvelope;
  try {
    envelope = (await response.json()) as EtherscanEnvelope;
  } catch {
    return { status: 502, body: { error: "etherscan_invalid_json" } };
  }

  if (envelope.status !== "1" || !Array.isArray(envelope.result)) {
    return {
      status: 502,
      body: {
        error: "etherscan_unexpected_shape",
        upstreamMessage: typeof envelope.message === "string" ? envelope.message : null,
      },
    };
  }

  const row = envelope.result[0];
  if (!row) {
    return { status: 404, body: { error: "contract_not_found" } };
  }

  const verified =
    typeof row.SourceCode === "string" && row.SourceCode.length > 0;
  const sourceCode = verified
    ? row.SourceCode!.length > MAX_SOURCE_BYTES
      ? row.SourceCode!.slice(0, MAX_SOURCE_BYTES)
      : row.SourceCode!
    : null;
  const sourceTruncated =
    verified && row.SourceCode!.length > MAX_SOURCE_BYTES;

  let abiParsed: unknown = null;
  if (typeof row.ABI === "string" && row.ABI.startsWith("[")) {
    try {
      abiParsed = JSON.parse(row.ABI);
    } catch {
      abiParsed = null;
    }
  }

  const implementation =
    typeof row.Implementation === "string" && row.Implementation.length > 0
      ? row.Implementation
      : null;
  const isProxy = row.Proxy === "1" || implementation !== null;

  return {
    status: 200,
    body: {
      chain: "base",
      chainId: 8453,
      contract,
      verified,
      name: row.ContractName ?? null,
      compilerVersion: row.CompilerVersion ?? null,
      evmVersion: row.EVMVersion ?? null,
      optimizationUsed: row.OptimizationUsed === "1",
      runs: row.Runs ? Number(row.Runs) : null,
      licenseType: row.LicenseType ?? null,
      isProxy,
      implementationAddress: implementation,
      constructorArguments: row.ConstructorArguments ?? null,
      library: row.Library ?? null,
      abi: abiParsed,
      sourceCode,
      sourceTruncated,
    },
  };
};
