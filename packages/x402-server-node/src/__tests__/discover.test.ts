import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetFacilitatorExtrasCache,
  _setCachedFacilitatorExtras,
  facilitatorExtrasKey,
  getAllFacilitatorExtras,
  getFacilitatorExtras,
  warmFacilitatorCache,
} from "../discover.js";

// A canned /supported response shaped like suverse-pay's gateway emits
// after PR-A: Solana with feePayer, Cosmos with grantee + chain meta.
const SAMPLE_SUPPORTED = {
  kinds: [
    {
      x402Version: 2,
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      extra: { feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP" },
    },
    {
      x402Version: 2,
      scheme: "exact_cosmos_authz",
      network: "cosmos:noble-1",
      extra: {
        facilitator: "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt",
        chainId: "noble-1",
        decimals: 6,
        symbol: "USDC",
      },
    },
    // Kind with no `extra` — should not appear in the lookup at all.
    {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:8453",
    },
    // Kind with empty `extra` — also dropped (no useful merge data).
    {
      x402Version: 2,
      scheme: "exact",
      network: "eip155:42161",
      extra: {},
    },
  ],
  extensions: [],
  signers: {},
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  _resetFacilitatorExtrasCache();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("discover — fetch + cache mechanics", () => {
  it("fetches /supported once and caches the per-kind extras", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_SUPPORTED));
    const sol = await getFacilitatorExtras(
      "https://facilitator.suverse.io",
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "exact",
      { fetchImpl },
    );
    expect(sol).toEqual({
      feePayer: "BENrLoUbndxoNMUS5JXApGMtNykLjFXXixMtpDwDR9SP",
    });
    // Second call against the same URL → no additional fetch.
    const cosmos = await getFacilitatorExtras(
      "https://facilitator.suverse.io",
      "cosmos:noble-1",
      "exact_cosmos_authz",
      { fetchImpl },
    );
    expect(cosmos).toMatchObject({
      facilitator: "noble18jq3tgk39z8qk5jz304zqkhd02gs5zkhrj7sqt",
      chainId: "noble-1",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for kinds the facilitator doesn't advertise extras for", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_SUPPORTED));
    // The EVM kind in the fixture has no `extra` — should not be merged.
    const evm = await getFacilitatorExtras(
      "https://facilitator.suverse.io",
      "eip155:8453",
      "exact",
      { fetchImpl },
    );
    expect(evm).toBeUndefined();
    // The kind with empty `extra: {}` is dropped too (no useful data).
    const evmArb = await getFacilitatorExtras(
      "https://facilitator.suverse.io",
      "eip155:42161",
      "exact",
      { fetchImpl },
    );
    expect(evmArb).toBeUndefined();
  });

  it("falls back to empty map on non-200 — does NOT throw to the caller", async () => {
    const warn = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    const all = await getAllFacilitatorExtras("https://facilitator.suverse.io", {
      fetchImpl,
      logger: { warn },
    });
    expect(all.size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("HTTP 500");
  });

  it("falls back to empty map on fetch throw (DNS / network / timeout)", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const all = await getAllFacilitatorExtras("https://nope.invalid", {
      fetchImpl,
      logger: { warn },
    });
    expect(all.size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("getaddrinfo ENOTFOUND");
  });

  it("falls back to empty map on malformed body (no `kinds` array)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ wrong: "shape" }));
    const all = await getAllFacilitatorExtras("https://facilitator.suverse.io", {
      fetchImpl,
    });
    expect(all.size).toBe(0);
  });

  it("refetches after TTL expires", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_SUPPORTED));
    const url = "https://facilitator.suverse.io";
    await getAllFacilitatorExtras(url, { fetchImpl, ttlMs: 50 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Within TTL → no refetch.
    await getAllFacilitatorExtras(url, { fetchImpl, ttlMs: 50 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Past TTL → refetch.
    await new Promise((r) => setTimeout(r, 60));
    await getAllFacilitatorExtras(url, { fetchImpl, ttlMs: 50 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent fetches against the same URL", async () => {
    let resolve: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetchImpl = vi.fn().mockReturnValue(pending);
    const url = "https://facilitator.suverse.io";
    const a = getAllFacilitatorExtras(url, { fetchImpl });
    const b = getAllFacilitatorExtras(url, { fetchImpl });
    const c = getAllFacilitatorExtras(url, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolve(jsonResponse(SAMPLE_SUPPORTED));
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.size).toBe(2); // Solana + Cosmos
    expect(rb).toBe(ra);
    expect(rc).toBe(ra);
  });

  it("caches independently per facilitator URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_SUPPORTED));
    await getAllFacilitatorExtras("https://facilitator-a", { fetchImpl });
    await getAllFacilitatorExtras("https://facilitator-b", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("normalises trailing slashes on facilitator URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_SUPPORTED));
    await getAllFacilitatorExtras("https://facilitator.suverse.io/", {
      fetchImpl,
    });
    await getAllFacilitatorExtras("https://facilitator.suverse.io", {
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("discover — test helpers", () => {
  it("_setCachedFacilitatorExtras pre-populates without HTTP", async () => {
    const fetchImpl = vi.fn();
    const url = "https://facilitator.suverse.io";
    _setCachedFacilitatorExtras(
      url,
      new Map([
        [
          facilitatorExtrasKey(
            "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
            "exact",
          ),
          { feePayer: "TestPubkey" },
        ],
      ]),
    );
    const got = await getFacilitatorExtras(
      url,
      "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "exact",
      { fetchImpl },
    );
    expect(got).toEqual({ feePayer: "TestPubkey" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("warmFacilitatorCache", () => {
  it("kicks off a background fetch (no await)", async () => {
    let resolve: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetchImpl = vi.fn().mockReturnValue(pending);
    warmFacilitatorCache("https://facilitator.suverse.io", { fetchImpl });
    // Synchronous: caller did NOT wait. fetch should have been invoked.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolve(jsonResponse(SAMPLE_SUPPORTED));
    // Allow the microtask queue to process the cache population.
    await new Promise((r) => setTimeout(r, 0));
    // A subsequent getAllFacilitatorExtras should hit the warm cache.
    const all = await getAllFacilitatorExtras("https://facilitator.suverse.io", {
      fetchImpl,
    });
    expect(all.size).toBeGreaterThan(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
