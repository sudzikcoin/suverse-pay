/**
 * Unit tests for the five Bitcoin-group internal handlers. Same
 * pattern as the other handler tests — fetchImpl stubs only.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { bitcoinAddressInfo } from "../src/handlers/bitcoin-address-info.js";
import { bitcoinBlockInfo } from "../src/handlers/bitcoin-block-info.js";
import { bitcoinFeesRecommended } from "../src/handlers/bitcoin-fees-recommended.js";
import { bitcoinMempoolStats } from "../src/handlers/bitcoin-mempool-stats.js";
import { bitcoinTxDecoder } from "../src/handlers/bitcoin-tx-decoder.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

afterEach(() => {
  vi.restoreAllMocks();
});

const COINBASE_TXID =
  "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b";
const SATOSHI_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const BLOCK_800K =
  "00000000000000000002a7c4c1e48d76c5a37902165a270156b7a8d72728a054";

// ─────────────────────────────────────────────────────────────────────
// bitcoin_tx_decoder
// ─────────────────────────────────────────────────────────────────────

describe("bitcoinTxDecoder", () => {
  it("400 on malformed txid", async () => {
    const res = await bitcoinTxDecoder({
      body: buf({ txid: "xyz" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("404 on upstream 404", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    const res = await bitcoinTxDecoder({
      body: buf({ txid: COINBASE_TXID }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("200 detects coinbase and totals output", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          txid: COINBASE_TXID,
          version: 1,
          locktime: 0,
          size: 134,
          weight: 536,
          fee: 0,
          vin: [
            {
              is_coinbase: true,
              sequence: 0xffffffff,
              prevout: null,
            },
          ],
          vout: [
            {
              scriptpubkey_address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
              value: 5000000000,
              scriptpubkey_type: "p2pkh",
            },
          ],
          status: {
            confirmed: true,
            block_height: 0,
            block_hash: "abcd",
            block_time: 1231006505,
          },
        }),
        { status: 200 },
      ),
    );
    const res = await bitcoinTxDecoder({
      body: buf({ txid: COINBASE_TXID }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      isCoinbase: boolean;
      totalInputSats: number | null;
      totalOutputSats: number;
      totalOutputBtc: number;
    };
    expect(body.isCoinbase).toBe(true);
    expect(body.totalInputSats).toBeNull();
    expect(body.totalOutputSats).toBe(5000000000);
    expect(body.totalOutputBtc).toBe(50);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("rate", { status: 429 }));
    const res = await bitcoinTxDecoder({
      body: buf({ txid: COINBASE_TXID }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// bitcoin_fees_recommended
// ─────────────────────────────────────────────────────────────────────

describe("bitcoinFeesRecommended", () => {
  it("200 merges fees + mempool", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            fastestFee: 30,
            halfHourFee: 20,
            hourFee: 10,
            economyFee: 5,
            minimumFee: 1,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            count: 1000,
            vsize: 5_000_000,
            total_fee: 1234567,
            fee_histogram: [
              [3.5, 1000],
              [2.0, 2000],
            ],
          }),
          { status: 200 },
        ),
      );
    const res = await bitcoinFeesRecommended({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      satsPerVbyte: { fastest: number | null; hour: number | null };
      mempool: { totalVsizeMb: number | null };
      feeHistogram: unknown[];
    };
    expect(body.satsPerVbyte.fastest).toBe(30);
    expect(body.mempool.totalVsizeMb).toBe(5);
    expect(body.feeHistogram.length).toBe(2);
  });

  it("503 on upstream 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("rate", { status: 429 }));
    const res = await bitcoinFeesRecommended({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

// ─────────────────────────────────────────────────────────────────────
// bitcoin_address_info
// ─────────────────────────────────────────────────────────────────────

describe("bitcoinAddressInfo", () => {
  it("400 on missing address", async () => {
    const res = await bitcoinAddressInfo({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("200 classifies bech32 segwit and totals balance", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            address: SATOSHI_ADDR,
            chain_stats: {
              funded_txo_count: 100,
              funded_txo_sum: 5_000_000,
              spent_txo_count: 50,
              spent_txo_sum: 2_000_000,
              tx_count: 100,
            },
            mempool_stats: {
              funded_txo_count: 1,
              funded_txo_sum: 500,
              spent_txo_count: 0,
              spent_txo_sum: 0,
              tx_count: 1,
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              txid: COINBASE_TXID,
              fee: 1000,
              size: 200,
              weight: 800,
              status: { confirmed: true, block_height: 800000, block_time: 1690168629 },
            },
          ]),
          { status: 200 },
        ),
      );
    const res = await bitcoinAddressInfo({
      body: buf({ address: SATOSHI_ADDR }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      addressType: string;
      confirmedBalanceSats: number;
      totalBalanceSats: number;
      recentTxCount: number;
    };
    expect(body.addressType).toBe("p2wpkh");
    expect(body.confirmedBalanceSats).toBe(3_000_000);
    expect(body.totalBalanceSats).toBe(3_000_500);
    expect(body.recentTxCount).toBe(1);
  });

  it("404 when address not found upstream", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    const res = await bitcoinAddressInfo({
      body: buf({ address: SATOSHI_ADDR }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
// bitcoin_mempool_stats
// ─────────────────────────────────────────────────────────────────────

describe("bitcoinMempoolStats", () => {
  it("200 aggregates mempool + tip + diff", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/api/mempool")) {
        return new Response(
          JSON.stringify({
            count: 10000,
            vsize: 30_000_000,
            total_fee: 6_000_000,
            fee_histogram: [[2.0, 1000]],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/blocks/tip/height")) {
        return new Response("951947", { status: 200 });
      }
      if (url.endsWith("/api/v1/difficulty-adjustment")) {
        return new Response(
          JSON.stringify({
            progressPercent: 50,
            difficultyChange: -1.5,
            remainingBlocks: 1000,
            remainingTime: 600000,
            previousRetarget: 2.1,
            timeAvg: 600000,
            nextRetargetHeight: 952000,
          }),
          { status: 200 },
        );
      }
      return new Response("?", { status: 404 });
    });
    const res = await bitcoinMempoolStats({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      tipHeight: number | null;
      mempool: { unconfirmedTxCount: number | null; avgSatsPerVbyte: number | null };
      difficultyAdjustment: { remainingBlocks: number | null; avgBlockTimeSeconds: number | null };
    };
    expect(body.tipHeight).toBe(951947);
    expect(body.mempool.unconfirmedTxCount).toBe(10000);
    expect(body.mempool.avgSatsPerVbyte).toBeCloseTo(0.2, 2);
    expect(body.difficultyAdjustment.remainingBlocks).toBe(1000);
    expect(body.difficultyAdjustment.avgBlockTimeSeconds).toBe(600);
  });
});

// ─────────────────────────────────────────────────────────────────────
// bitcoin_block_info
// ─────────────────────────────────────────────────────────────────────

describe("bitcoinBlockInfo", () => {
  it("400 when neither height nor hash supplied", async () => {
    const res = await bitcoinBlockInfo({ body: buf({}), method: "POST" });
    expect(res.status).toBe(400);
  });

  it("400 when both supplied", async () => {
    const res = await bitcoinBlockInfo({
      body: buf({ height: 800000, hash: BLOCK_800K }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 resolves by hash", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(`/block/${BLOCK_800K}/txids`)) {
        return new Response(
          JSON.stringify(["aa", "bb", "cc"]),
          { status: 200 },
        );
      }
      if (url.includes(`/block/${BLOCK_800K}`)) {
        return new Response(
          JSON.stringify({
            id: BLOCK_800K,
            height: 800000,
            version: 874340352,
            timestamp: 1690168629,
            tx_count: 3721,
            size: 1634536,
            weight: 3992881,
            merkle_root: "abc",
            extras: {
              pool: { name: "Foundry USA", slug: "foundryusa" },
              totalFees: 12345,
              reward: 5012345,
              avgFeeRate: 30,
              medianFee: 25,
            },
          }),
          { status: 200 },
        );
      }
      return new Response("?", { status: 404 });
    });
    const res = await bitcoinBlockInfo({
      body: buf({ hash: BLOCK_800K }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      height: number | null;
      minerPool: string | null;
      txCount: number | null;
      txidCount: number;
    };
    expect(body.height).toBe(800000);
    expect(body.minerPool).toBe("Foundry USA");
    expect(body.txCount).toBe(3721);
    expect(body.txidCount).toBe(3);
  });

  it("200 resolves by height (two-hop lookup)", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/block-height/800000")) {
        return new Response(BLOCK_800K, { status: 200 });
      }
      if (url.includes(`/block/${BLOCK_800K}/txids`)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes(`/block/${BLOCK_800K}`)) {
        return new Response(
          JSON.stringify({
            id: BLOCK_800K,
            height: 800000,
            timestamp: 1690168629,
            tx_count: 3721,
          }),
          { status: 200 },
        );
      }
      return new Response("?", { status: 404 });
    });
    const res = await bitcoinBlockInfo({
      body: buf({ height: 800000 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect((res.body as { height: number | null }).height).toBe(800000);
  });

  it("404 when height not found", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 404 }));
    const res = await bitcoinBlockInfo({
      body: buf({ height: 999999999 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });
});
