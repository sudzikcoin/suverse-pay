/**
 * Unit tests for the five Cosmos-group internal handlers. Same
 * pattern as base-handlers.test.ts: each handler is exercised
 * against a `fetchImpl` stub for input-validation, upstream-error,
 * and happy-path coverage. No real LCD traffic.
 *
 * Chain mapping lives in cosmos-chain-registry; we use cosmoshub
 * everywhere because all five handlers route through it the same way.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { cosmosChainInfo } from "../src/handlers/cosmos-chain-info.js";
import { cosmosIbcTracker } from "../src/handlers/cosmos-ibc-tracker.js";
import { cosmosTxDecoder } from "../src/handlers/cosmos-tx-decoder.js";
import { cosmosValidatorStats } from "../src/handlers/cosmos-validator-stats.js";
import { cosmosWalletBalance } from "../src/handlers/cosmos-wallet-balance.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

afterEach(() => {
  vi.restoreAllMocks();
});

const TX64 =
  "f7c0fdfa7e8c3a2b14e9b6a09e3b9b8a1cf60b6d6f4e6a9f1d8b6c2e7a90c1b3";
const COSMOS_ADDR = "cosmos1tygms3xhhs3yv487phx3dw4a95jn7t7lpm470r";
const COSMOS_VALOPER =
  "cosmosvaloper1sjllsnramtg7ewxqwwrwjxfgc4n4ef9u2lcnj0";

// ─────────────────────────────────────────────────────────────────────
// cosmos_tx_decoder
// ─────────────────────────────────────────────────────────────────────

describe("cosmosTxDecoder", () => {
  it("400 on unknown chain", async () => {
    const res = await cosmosTxDecoder({
      body: buf({ chain: "made-up", tx_hash: TX64 }),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("unknown_chain");
  });

  it("400 on bad hash", async () => {
    const res = await cosmosTxDecoder({
      body: buf({ chain: "cosmoshub", tx_hash: "xyz" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("404 on upstream 404", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 404 }));
    const res = await cosmosTxDecoder({
      body: buf({ chain: "cosmoshub", tx_hash: TX64 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("200 normalizes MsgSend", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          tx: {
            body: {
              messages: [
                {
                  "@type": "/cosmos.bank.v1beta1.MsgSend",
                  from_address: COSMOS_ADDR,
                  to_address: "cosmos1xxx",
                  amount: [{ denom: "uatom", amount: "1000" }],
                },
              ],
              memo: "hi",
            },
            auth_info: { fee: { amount: [{ denom: "uatom", amount: "5" }], gas_limit: "100000" } },
          },
          tx_response: {
            height: "12345",
            txhash: TX64.toUpperCase(),
            code: 0,
            gas_used: "80000",
            gas_wanted: "100000",
            timestamp: "2026-06-01T00:00:00Z",
          },
        }),
        { status: 200 },
      ),
    );
    const res = await cosmosTxDecoder({
      body: buf({ chain: "cosmoshub", tx_hash: TX64 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      success: boolean;
      messageCount: number;
      messages: Array<{ type: string; summary: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.messageCount).toBe(1);
    expect(body.messages[0]!.summary).toContain("Send from");
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("rate", { status: 429 }));
    const res = await cosmosTxDecoder({
      body: buf({ chain: "cosmoshub", tx_hash: TX64 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// cosmos_wallet_balance
// ─────────────────────────────────────────────────────────────────────

describe("cosmosWalletBalance", () => {
  it("400 on unsupported prefix", async () => {
    const res = await cosmosWalletBalance({
      body: buf({ address: "fake1abc" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 detects native vs IBC denoms", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: [
            { denom: "uatom", amount: "1500000" },
            { denom: "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2", amount: "100000" },
          ],
          pagination: { total: "2" },
        }),
        { status: 200 },
      ),
    );
    const res = await cosmosWalletBalance({
      body: buf({ address: COSMOS_ADDR }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      nativeBalance: string;
      ibcDenomCount: number;
      balances: Array<{ denom: string | null; isNative: boolean }>;
    };
    expect(body.nativeBalance).toBe("1500000");
    expect(body.ibcDenomCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// cosmos_validator_stats
// ─────────────────────────────────────────────────────────────────────

describe("cosmosValidatorStats", () => {
  it("400 when validator prefix wrong", async () => {
    const res = await cosmosValidatorStats({
      body: buf({ chain: "cosmoshub", validator: "noblevaloper1xxx" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 returns commission + bonded tokens", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            validator: {
              operator_address: COSMOS_VALOPER,
              jailed: false,
              status: "BOND_STATUS_BONDED",
              tokens: "100000000000",
              delegator_shares: "100000000000.0",
              description: { moniker: "TestVal" },
              commission: {
                commission_rates: {
                  rate: "0.050000000000000000",
                  max_rate: "0.200000000000000000",
                  max_change_rate: "0.010000000000000000",
                },
              },
              min_self_delegation: "1",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            params: {
              signed_blocks_window: "10000",
              min_signed_per_window: "0.050000000000000000",
            },
          }),
          { status: 200 },
        ),
      );
    const res = await cosmosValidatorStats({
      body: buf({ chain: "cosmoshub", validator: COSMOS_VALOPER }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      moniker: string | null;
      commissionRate: number | null;
      bondedTokens: string | null;
      slashingParams: { windowSize: number | null };
    };
    expect(body.moniker).toBe("TestVal");
    expect(body.commissionRate).toBeCloseTo(0.05, 3);
    expect(body.bondedTokens).toBe("100000000000");
    expect(body.slashingParams.windowSize).toBe(10000);
  });

  it("404 when validator not found", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/validators/")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify({ params: {} }), { status: 200 });
    });
    const res = await cosmosValidatorStats({
      body: buf({ chain: "cosmoshub", validator: COSMOS_VALOPER }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
// cosmos_ibc_tracker
// ─────────────────────────────────────────────────────────────────────

describe("cosmosIbcTracker", () => {
  it("400 on bad hash", async () => {
    const res = await cosmosIbcTracker({
      body: buf({ chain: "cosmoshub", tx_hash: "xyz" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 ibcDetected=false when no IBC events", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          tx_response: { txhash: TX64.toUpperCase(), code: 0, events: [], height: "1" },
        }),
        { status: 200 },
      ),
    );
    const res = await cosmosIbcTracker({
      body: buf({ chain: "cosmoshub", tx_hash: TX64 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect((res.body as { ibcDetected: boolean }).ibcDetected).toBe(false);
  });

  it("200 extracts packet sequence and sender", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          tx_response: {
            txhash: TX64.toUpperCase(),
            code: 0,
            height: "42",
            events: [
              {
                type: "send_packet",
                attributes: [
                  { key: "packet_src_channel", value: "channel-141" },
                  { key: "packet_src_port", value: "transfer" },
                  { key: "packet_dst_channel", value: "channel-0" },
                  { key: "packet_dst_port", value: "transfer" },
                  { key: "packet_sequence", value: "12345" },
                ],
              },
              {
                type: "ibc_transfer",
                attributes: [
                  { key: "sender", value: COSMOS_ADDR },
                  { key: "receiver", value: "osmo1xyz" },
                  { key: "denom", value: "uatom" },
                  { key: "amount", value: "1000" },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const res = await cosmosIbcTracker({
      body: buf({ chain: "cosmoshub", tx_hash: TX64 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      ibcDetected: boolean;
      sequence: string | null;
      sender: string | null;
      status: string;
    };
    expect(body.ibcDetected).toBe(true);
    expect(body.sequence).toBe("12345");
    expect(body.sender).toBe(COSMOS_ADDR);
    expect(body.status).toBe("in_flight");
  });
});

// ─────────────────────────────────────────────────────────────────────
// cosmos_chain_info
// ─────────────────────────────────────────────────────────────────────

describe("cosmosChainInfo", () => {
  it("400 on unknown chain", async () => {
    const res = await cosmosChainInfo({
      body: buf({ chain: "fake" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 returns height + bonded ratio", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/blocks/latest")) {
        return new Response(
          JSON.stringify({
            block: {
              header: { height: "20000000", time: "2026-06-01T00:00:10Z", chain_id: "cosmoshub-4" },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/blocks/19999990")) {
        return new Response(
          JSON.stringify({
            block: {
              header: { height: "19999990", time: "2026-06-01T00:00:00Z", chain_id: "cosmoshub-4" },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/bank/v1beta1/supply")) {
        return new Response(
          JSON.stringify({
            supply: [
              { denom: "uatom", amount: "400000000000000" },
              { denom: "stuatom", amount: "1000" },
            ],
            pagination: { total: "2" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/staking/v1beta1/pool")) {
        return new Response(
          JSON.stringify({
            pool: {
              bonded_tokens: "200000000000000",
              not_bonded_tokens: "1000000000",
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/staking/v1beta1/validators")) {
        return new Response(
          JSON.stringify({ pagination: { total: "180" } }),
          { status: 200 },
        );
      }
      return new Response("?", { status: 404 });
    });
    const res = await cosmosChainInfo({
      body: buf({ chain: "cosmoshub" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      latestHeight: number | null;
      bondedRatio: number | null;
      activeValidatorCount: number | null;
    };
    expect(body.latestHeight).toBe(20000000);
    expect(body.bondedRatio).toBeCloseTo(0.5, 2);
    expect(body.activeValidatorCount).toBe(180);
  });
});
