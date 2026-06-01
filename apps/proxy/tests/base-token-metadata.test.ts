/**
 * Unit tests for the Base ERC20 token metadata resolver.
 *
 * Hardcoded popular tokens resolve with zero network. LiFi
 * `/v1/tokens` is mocked via vi.fn fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetBaseTokenMetadataCache,
  _seedBaseTokenMetadataCache,
  getBaseTokenMetadata,
} from "../src/lib/base-token-metadata.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
// Test long-tail token absent from the hardcoded map.
const LONG_TAIL = "0x9a26F5433671751C3276a065f57e5a02D2817973";

function lifiBody(): unknown {
  return {
    tokens: {
      "8453": [
        {
          address: LONG_TAIL,
          symbol: "TAIL",
          name: "Long Tail Token",
          decimals: 18,
          logoURI: "https://example/tail.png",
        },
        // Malformed entry — should be skipped.
        { address: WETH, symbol: "WETH" },
      ],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("getBaseTokenMetadata", () => {
  beforeEach(() => {
    _resetBaseTokenMetadataCache();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns hardcoded USDC metadata with zero network calls", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const meta = await getBaseTokenMetadata(USDC, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(meta.symbol).toBe("USDC");
    expect(meta.decimals).toBe(6);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns hardcoded WETH and AERO", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const f = fetchImpl as unknown as typeof fetch;
    const weth = await getBaseTokenMetadata(WETH, { fetchImpl: f });
    const aero = await getBaseTokenMetadata(AERO, { fetchImpl: f });
    expect(weth.symbol).toBe("WETH");
    expect(weth.decimals).toBe(18);
    expect(aero.symbol).toBe("AERO");
    expect(aero.decimals).toBe(18);
  });

  it("accepts lowercase address and returns checksum mint", async () => {
    const meta = await getBaseTokenMetadata(USDC.toLowerCase());
    expect(meta.mint).toBe(USDC);
  });

  it("resolves a long-tail token via LiFi /v1/tokens", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(lifiBody()));
    const meta = await getBaseTokenMetadata(LONG_TAIL, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(meta.symbol).toBe("TAIL");
    expect(meta.decimals).toBe(18);
    expect(meta.logoURI).toBe("https://example/tail.png");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caches LiFi list — second call hits no network", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(lifiBody()));
    const f = fetchImpl as unknown as typeof fetch;
    await getBaseTokenMetadata(LONG_TAIL, { fetchImpl: f });
    await getBaseTokenMetadata(LONG_TAIL, { fetchImpl: f });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to UNKNOWN for invalid addresses", async () => {
    const meta = await getBaseTokenMetadata("not-an-address");
    expect(meta.symbol).toBe("UNKNOWN");
    expect(meta.decimals).toBe(0);
  });

  it("falls back to UNKNOWN when LiFi misses and token is absent from hardcoded", async () => {
    const ABSENT = "0x" + "ab".repeat(20);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ tokens: { "8453": [] } }),
    );
    const meta = await getBaseTokenMetadata(ABSENT, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(meta.symbol).toBe("UNKNOWN");
  });

  it("seedBaseTokenMetadataCache lets tests avoid network", async () => {
    _seedBaseTokenMetadataCache([
      {
        mint: LONG_TAIL,
        symbol: "SEEDED",
        name: "Seeded",
        decimals: 9,
      },
    ]);
    const fetchImpl = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const meta = await getBaseTokenMetadata(LONG_TAIL, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(meta.symbol).toBe("SEEDED");
    expect(meta.decimals).toBe(9);
  });
});
