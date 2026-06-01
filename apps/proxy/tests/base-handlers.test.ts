/**
 * Unit tests for the five Base-group internal handlers. Each test
 * isolates one handler against a `fetchImpl` stub — no proxy stack,
 * no DB, no network. The contract slots covered per handler:
 *   - 400 on missing / malformed input
 *   - 502 on upstream-unreachable
 *   - 503 on upstream 429
 *   - 200 happy-path with the response shape callers depend on
 *
 * Etherscan + GoPlus handlers also assert 503 when their respective
 * API-key env var is missing — the proxy hardens against the
 * misconfigured-row case.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { baseRpcTxDecoder } from "../src/handlers/base-rpc-tx-decoder.js";
import { blockscoutBaseTokenHolders } from "../src/handlers/blockscout-base-token-holders.js";
import { blockscoutBaseWalletHistory } from "../src/handlers/blockscout-base-wallet-history.js";
import { etherscanBaseContractInfo } from "../src/handlers/etherscan-base-contract-info.js";
import { goplusTokenRiskBase } from "../src/handlers/goplus-token-risk-base.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

beforeEach(() => {
  process.env["ETHERSCAN_API_KEY"] = "test-etherscan-key";
  process.env["GOPLUS_API_KEY"] = "test-goplus-key";
});

afterEach(() => {
  delete process.env["ETHERSCAN_API_KEY"];
  delete process.env["GOPLUS_API_KEY"];
  vi.restoreAllMocks();
});

const HASH64 =
  "0xb044ab1d32d52d3ebb3689f651071d8d4f9ae0aba55afce64c5e692efdee1ab6";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

// ─────────────────────────────────────────────────────────────────────
// base_rpc_tx_decoder
// ─────────────────────────────────────────────────────────────────────

describe("baseRpcTxDecoder", () => {
  it("400 when tx_hash missing", async () => {
    const res = await baseRpcTxDecoder({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("tx_hash_required");
  });

  it("400 when tx_hash malformed", async () => {
    const res = await baseRpcTxDecoder({
      body: buf({ tx_hash: "0xnotreallyahash" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_tx_hash_format");
  });

  it("400 on invalid JSON body", async () => {
    const res = await baseRpcTxDecoder({
      body: Buffer.from("{not json"),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_json_body");
  });

  it("502 when RPC unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("boom"));
    const res = await baseRpcTxDecoder({
      body: buf({ tx_hash: HASH64 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
  });

  it("503 when RPC returns 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    const res = await baseRpcTxDecoder({
      body: buf({ tx_hash: HASH64 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });

  it("200 happy path with ERC20 transfer log extracted", async () => {
    const transferTopic =
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const fromTopic =
      "0x000000000000000000000000260fbe1ec46968ee02e5b972507d7bb7f09f82b0";
    const toTopic =
      "0x000000000000000000000000a1d64d42a1fbece70794d38b3bee1c69a1c3ba99";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {
              hash: HASH64,
              from: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
              to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
              value: "0x0",
              input: "0xa9059cbb000000",
              blockNumber: "0x2438b2f",
              nonce: "0x1",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            result: {
              status: "0x1",
              gasUsed: "0xf2cf",
              effectiveGasPrice: "0x1707a3",
              logs: [
                {
                  address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
                  topics: [transferTopic, fromTopic, toTopic],
                  data: "0x00000000000000000000000000000000000000000000000000000000001e7df8",
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    const res = await baseRpcTxDecoder({
      body: buf({ tx_hash: HASH64 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      chain: string;
      status: string;
      transferCount: number;
      erc20Transfers: Array<{ token: string; from: string; to: string }>;
    };
    expect(body.chain).toBe("base");
    expect(body.status).toBe("success");
    expect(body.transferCount).toBe(1);
    expect(body.erc20Transfers[0]?.from).toBe(
      "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// goplus_token_risk_base
// ─────────────────────────────────────────────────────────────────────

describe("goplusTokenRiskBase", () => {
  it("503 when GOPLUS_API_KEY missing", async () => {
    delete process.env["GOPLUS_API_KEY"];
    const res = await goplusTokenRiskBase({
      body: buf({ contract_address: USDC_BASE }),
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("400 when contract_address malformed", async () => {
    const res = await goplusTokenRiskBase({
      body: buf({ contract_address: "not-an-address" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 builds redFlags + riskScore from upstream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 1,
          result: {
            [USDC_BASE]: {
              token_name: "Scammy",
              token_symbol: "SCAM",
              total_supply: "1000000",
              holder_count: "42",
              is_mintable: "1",
              is_honeypot: "1",
              transfer_pausable: "1",
              owner_address: "0xdead0000000000000000000000000000000000bb",
              is_open_source: "1",
              holders: [{ percent: "0.5" }, { percent: "0.3" }],
              buy_tax: "0",
              sell_tax: "0",
            },
          },
        }),
        { status: 200 },
      ),
    );
    const res = await goplusTokenRiskBase({
      body: buf({ contract_address: USDC_BASE }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      riskScore: number;
      verdict: string;
      redFlags: string[];
      greenFlags: string[];
    };
    expect(body.redFlags).toContain("mintable");
    expect(body.redFlags).toContain("honeypot_detected");
    expect(body.redFlags).toContain("transfers_pausable");
    expect(body.redFlags).toContain("top10_concentration_over_70pct");
    expect(body.greenFlags).toContain("source_verified");
    expect(body.riskScore).toBeGreaterThanOrEqual(60);
    expect(body.verdict).toBe("high_risk");
  });

  it("404 when token not indexed", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 1, result: {} }), { status: 200 }),
    );
    const res = await goplusTokenRiskBase({
      body: buf({ contract_address: USDC_BASE }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("rate", { status: 429 }));
    const res = await goplusTokenRiskBase({
      body: buf({ contract_address: USDC_BASE }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// blockscout_base_wallet_history
// ─────────────────────────────────────────────────────────────────────

describe("blockscoutBaseWalletHistory", () => {
  it("400 when address malformed", async () => {
    const res = await blockscoutBaseWalletHistory({
      body: buf({ address: "0xfoo" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("400 when limit out of range", async () => {
    const res = await blockscoutBaseWalletHistory({
      body: buf({
        address: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0",
        limit: 9999,
      }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 with empty list on Blockscout 404", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 404 }));
    const res = await blockscoutBaseWalletHistory({
      body: buf({ address: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as { count: number; transactions: unknown[] };
    expect(body.count).toBe(0);
  });

  it("200 maps item fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              hash: HASH64,
              block_number: 38000000,
              timestamp: "2026-05-01T10:00:00Z",
              from: { hash: "0xaaa" },
              to: { hash: "0xbbb" },
              value: "1000000000000000000",
              fee: { value: "100" },
              status: "ok",
              method: "transfer",
              transaction_types: ["token_transfer"],
            },
          ],
          next_page_params: { block_number: 37999999 },
        }),
        { status: 200 },
      ),
    );
    const res = await blockscoutBaseWalletHistory({
      body: buf({ address: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      transactions: Array<{ valueEth: number; success: boolean }>;
      nextPageCursor: { beforeBlock: number } | null;
    };
    expect(body.transactions[0]!.valueEth).toBe(1);
    expect(body.transactions[0]!.success).toBe(true);
    expect(body.nextPageCursor?.beforeBlock).toBe(37999999);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("rate", { status: 429 }));
    const res = await blockscoutBaseWalletHistory({
      body: buf({ address: "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// blockscout_base_token_holders
// ─────────────────────────────────────────────────────────────────────

describe("blockscoutBaseTokenHolders", () => {
  it("400 when contract_address malformed", async () => {
    const res = await blockscoutBaseTokenHolders({
      body: buf({ contract_address: "0xtoo-short" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("404 when both upstream calls 404", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 404 }));
    const res = await blockscoutBaseTokenHolders({
      body: buf({ contract_address: USDC_BASE }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("200 computes top1 + top10 + whaleCount", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { address: { hash: "0xaaa", is_contract: false }, value: "200" },
              { address: { hash: "0xbbb", is_contract: true }, value: "100" },
              { address: { hash: "0xccc", is_contract: false }, value: "1" },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            address: USDC_BASE,
            name: "USDC",
            symbol: "USDC",
            decimals: "6",
            total_supply: "1000",
            holders: "100",
            type: "ERC-20",
          }),
          { status: 200 },
        ),
      );
    const res = await blockscoutBaseTokenHolders({
      body: buf({ contract_address: USDC_BASE }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      symbol: string | null;
      sampleSize: number;
      top1ConcentrationPct: number | null;
      whaleCount: number;
    };
    expect(body.symbol).toBe("USDC");
    expect(body.sampleSize).toBe(3);
    expect(body.top1ConcentrationPct).toBeCloseTo(20, 1);
    expect(body.whaleCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// etherscan_base_contract_info
// ─────────────────────────────────────────────────────────────────────

describe("etherscanBaseContractInfo", () => {
  it("503 when ETHERSCAN_API_KEY missing", async () => {
    delete process.env["ETHERSCAN_API_KEY"];
    const res = await etherscanBaseContractInfo({
      body: buf({ contract_address: USDC_BASE }),
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("400 when contract_address malformed", async () => {
    const res = await etherscanBaseContractInfo({
      body: buf({ contract_address: "0xabc" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 happy path verified proxy contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "1",
          message: "OK",
          result: [
            {
              SourceCode: "contract Foo {}",
              ABI: '[{"type":"function","name":"transfer"}]',
              ContractName: "FiatTokenProxy",
              CompilerVersion: "v0.6.12+commit.27d51765",
              OptimizationUsed: "1",
              Runs: "200",
              LicenseType: "MIT",
              Proxy: "1",
              Implementation: "0xfffffffffffffffffffffffffffffffffffffffe",
              ConstructorArguments: "0x",
              EVMVersion: "istanbul",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const res = await etherscanBaseContractInfo({
      body: buf({ contract_address: USDC_BASE }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      verified: boolean;
      isProxy: boolean;
      implementationAddress: string | null;
      abi: unknown;
    };
    expect(body.verified).toBe(true);
    expect(body.isProxy).toBe(true);
    expect(body.implementationAddress).toBe(
      "0xfffffffffffffffffffffffffffffffffffffffe",
    );
    expect(Array.isArray(body.abi)).toBe(true);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("rate", { status: 429 }));
    const res = await etherscanBaseContractInfo({
      body: buf({ contract_address: USDC_BASE }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});
