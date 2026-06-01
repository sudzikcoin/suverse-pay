/**
 * Unit tests for the Jupiter-backed token metadata resolver.
 *
 * All HTTP is faked via vi.fn fetch impls — no network access.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetTokenMetadataCache,
  _seedTokenMetadataCache,
  formatTokenAmount,
  getTokenMetadata,
  type TokenMetadata,
} from "../src/lib/token-metadata.js";

const BONK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WIF_MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

function jupiterListBody(): unknown {
  return [
    {
      address: USDC_MINT,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
      logoURI: "https://example/usdc.png",
    },
    {
      address: BONK_MINT,
      symbol: "Bonk",
      name: "Bonk",
      decimals: 5,
      logoURI: "https://example/bonk.png",
    },
    { address: WIF_MINT, symbol: "$WIF", name: "dogwifhat", decimals: 6 },
    // Malformed entry — missing decimals; resolver should skip it.
    { address: "deadbeef", symbol: "BAD" },
  ];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getTokenMetadata", () => {
  beforeEach(() => {
    _resetTokenMetadataCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns metadata for a token present in the Jupiter list", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(jupiterListBody()));
    const meta = await getTokenMetadata(BONK_MINT, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(meta.symbol).toBe("Bonk");
    expect(meta.decimals).toBe(5);
    expect(meta.name).toBe("Bonk");
    expect(meta.logoURI).toBe("https://example/bonk.png");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caches the Jupiter list across calls", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(jupiterListBody()));
    const f = fetchImpl as unknown as typeof fetch;
    await getTokenMetadata(BONK_MINT, { fetchImpl: f });
    await getTokenMetadata(USDC_MINT, { fetchImpl: f });
    await getTokenMetadata(WIF_MINT, { fetchImpl: f });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to UNKNOWN when the mint is absent and no helius key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(jupiterListBody()));
    const meta = await getTokenMetadata("UnknownMint11111111111111111111111111111111", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(meta.symbol).toBe("UNKNOWN");
    expect(meta.decimals).toBe(0);
  });

  it("falls back to UNKNOWN when Jupiter returns 5xx and cache is empty", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("upstream blew up", { status: 502 }),
    );
    const meta = await getTokenMetadata(BONK_MINT, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(meta.symbol).toBe("UNKNOWN");
    expect(meta.decimals).toBe(0);
  });

  it("uses Helius DAS when Jupiter list misses the mint", async () => {
    const LONG_TAIL = "DAVE111111111111111111111111111111111111111";
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.startsWith("https://tokens.jup.ag")) {
        return jsonResponse(jupiterListBody());
      }
      if (u.startsWith("https://mainnet.helius-rpc.com")) {
        return jsonResponse({
          jsonrpc: "2.0",
          result: {
            interface: "FungibleToken",
            id: LONG_TAIL,
            token_info: { symbol: "DAVE", decimals: 6 },
            content: {
              metadata: { symbol: "DAVE", name: "Dave Coin" },
              links: { image: "https://example/dave.png" },
            },
          },
        });
      }
      return new Response("not found", { status: 404 });
    });
    const meta = await getTokenMetadata(LONG_TAIL, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      heliusApiKey: "k",
    });
    expect(meta.symbol).toBe("DAVE");
    expect(meta.name).toBe("Dave Coin");
    expect(meta.decimals).toBe(6);
    expect(meta.logoURI).toBe("https://example/dave.png");
  });

  it("memoizes Helius hits so a repeat lookup hits no upstream", async () => {
    const LONG_TAIL = "MEMOIZED1111111111111111111111111111111111";
    let heliusCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.startsWith("https://tokens.jup.ag")) {
        return jsonResponse(jupiterListBody());
      }
      heliusCalls += 1;
      return jsonResponse({
        jsonrpc: "2.0",
        result: {
          id: LONG_TAIL,
          token_info: { symbol: "MEMO", decimals: 9 },
          content: { metadata: { symbol: "MEMO", name: "Memo" } },
        },
      });
    });
    const f = fetchImpl as unknown as typeof fetch;
    const opts = { fetchImpl: f, heliusApiKey: "k" };
    await getTokenMetadata(LONG_TAIL, opts);
    await getTokenMetadata(LONG_TAIL, opts);
    await getTokenMetadata(LONG_TAIL, opts);
    expect(heliusCalls).toBe(1);
  });

  it("falls back to UNKNOWN when Helius also has no record", async () => {
    const LONG_TAIL = "GHOST1111111111111111111111111111111111111";
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.startsWith("https://tokens.jup.ag")) {
        return jsonResponse(jupiterListBody());
      }
      // Helius returns an empty result envelope.
      return jsonResponse({ jsonrpc: "2.0", result: null });
    });
    const meta = await getTokenMetadata(LONG_TAIL, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      heliusApiKey: "k",
    });
    expect(meta.symbol).toBe("UNKNOWN");
  });

  it("skips malformed Jupiter entries without throwing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(jupiterListBody()));
    // "deadbeef" was missing decimals — it should not be cached.
    const meta = await getTokenMetadata("deadbeef", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(meta.symbol).toBe("UNKNOWN");
  });

  it("seedTokenMetadataCache lets tests avoid network entirely", async () => {
    _seedTokenMetadataCache([
      { mint: "M1", symbol: "M1", name: "Mint One", decimals: 4 },
    ]);
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const meta = await getTokenMetadata("M1", {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(meta.decimals).toBe(4);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("formatTokenAmount", () => {
  const bonk: TokenMetadata = {
    mint: BONK_MINT,
    symbol: "Bonk",
    name: "Bonk",
    decimals: 5,
  };
  const usdc: TokenMetadata = {
    mint: USDC_MINT,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
  };

  it("formats with decimals, stripping trailing zeros", () => {
    expect(formatTokenAmount(5976011557n, bonk)).toBe("59760.11557 Bonk");
    expect(formatTokenAmount(1_000_000n, usdc)).toBe("1 USDC");
    expect(formatTokenAmount(333_300n, usdc)).toBe("0.3333 USDC");
  });

  it("handles a whole-number amount", () => {
    expect(formatTokenAmount(10_000_000n, usdc)).toBe("10 USDC");
  });

  it("renders UNKNOWN decimals=0 as raw atomic + symbol", () => {
    const ghost: TokenMetadata = {
      mint: "g",
      symbol: "UNKNOWN",
      name: "g",
      decimals: 0,
    };
    expect(formatTokenAmount(123_456n, ghost)).toBe("123456 UNKNOWN");
  });

  it("formats zero", () => {
    expect(formatTokenAmount(0n, usdc)).toBe("0 USDC");
  });
});
