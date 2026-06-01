/**
 * Unit tests for the two GeckoTerminal-backed pool handlers. Same
 * shape for both because they only differ in network slug; we
 * exercise validation + happy-path on each, plus the 429-remap
 * on one of them (the path is shared so a single coverage point
 * is enough).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { geckoterminalBasePools } from "../src/handlers/geckoterminal-base-pools.js";
import { geckoterminalSolanaPools } from "../src/handlers/geckoterminal-solana-pools.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

afterEach(() => {
  vi.restoreAllMocks();
});

const SAMPLE_POOL = {
  id: "base_0xabc",
  attributes: {
    address: "0xabc",
    name: "WETH / USDC",
    base_token_price_usd: "3500.10",
    reserve_in_usd: "12345678",
    pool_created_at: "2026-01-01T00:00:00Z",
    volume_usd: { h24: "9876543" },
    price_change_percentage: { h24: "1.23" },
  },
  relationships: {
    dex: { data: { id: "uniswap_v3_base" } },
    base_token: { data: { id: "base_0xWETH" } },
    quote_token: { data: { id: "base_0xUSDC" } },
  },
};

describe("geckoterminalBasePools", () => {
  it("400 on invalid limit", async () => {
    const res = await geckoterminalBasePools({
      body: buf({ limit: 0 }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("caps limit at 20", async () => {
    const pools = Array.from({ length: 25 }, () => SAMPLE_POOL);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: pools }), { status: 200 }),
    );
    const res = await geckoterminalBasePools({
      body: buf({ limit: 100 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as { count: number };
    expect(body.count).toBe(20);
  });

  it("200 normalizes one pool", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [SAMPLE_POOL] }), { status: 200 }),
    );
    const res = await geckoterminalBasePools({
      body: buf({ limit: 5 }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as {
      chain: string;
      pools: Array<{ name: string; dex: string; reserve_usd: string }>;
    };
    expect(body.chain).toBe("base");
    expect(body.pools[0].name).toBe("WETH / USDC");
    expect(body.pools[0].dex).toBe("uniswap_v3_base");
    expect(body.pools[0].reserve_usd).toBe("12345678");
  });

  it("503 on 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    const res = await geckoterminalBasePools({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

describe("geckoterminalSolanaPools", () => {
  it("200 normalizes and tags chain=solana", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [SAMPLE_POOL] }), { status: 200 }),
    );
    const res = await geckoterminalSolanaPools({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = res.body as { chain: string; count: number };
    expect(body.chain).toBe("solana");
    expect(body.count).toBe(1);
  });

  it("hits the solana URL not the base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await geckoterminalSolanaPools({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url).toContain("/networks/solana/pools");
    expect(url).not.toContain("/networks/base/");
  });
});
