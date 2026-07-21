/**
 * Dual-key failover for Helius. Exercises the wrapper
 * (`src/lib/helius-client.ts`) directly, plus one end-to-end pass
 * through a handler to prove the switching is actually wired in.
 *
 * Core requirement: a 429 on key_1 must switch the call to key_2 and
 * retry once. Also covered: credit-limit error body, cooldown
 * persistence + preference for key_1, switch-back after cooldown, and
 * the both-keys-cooling clear error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HeliusAllKeysCoolingError,
  heliusFetch,
  loadHeliusKeys,
  __resetHeliusFailoverState,
} from "../src/lib/helius-client.js";
import { heliusNftMetadata } from "../src/handlers/helius-nft-metadata.js";

const RPC = (k: string) =>
  `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(k)}`;

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

/** Capture logger so we can assert switch / all-cooling events. */
function makeLogger() {
  const switches: Array<Record<string, unknown>> = [];
  const allCooling: Array<Record<string, unknown>> = [];
  return {
    switches,
    allCooling,
    logger: {
      info() {},
      warn(obj: unknown) {
        const o = obj as Record<string, unknown>;
        if (o?.["event"] === "helius_key_switch") switches.push(o);
      },
      error(obj: unknown) {
        const o = obj as Record<string, unknown>;
        if (o?.["event"] === "helius_all_keys_cooling") allCooling.push(o);
      },
    },
  };
}

const ORIG = {
  k1: process.env["HELIUS_API_KEY_1"],
  k2: process.env["HELIUS_API_KEY_2"],
  legacy: process.env["HELIUS_API_KEY"],
  cd: process.env["HELIUS_COOLDOWN_MS"],
};

beforeEach(() => {
  __resetHeliusFailoverState();
  process.env["LOG_LEVEL"] = "silent";
  delete process.env["HELIUS_API_KEY"]; // no legacy fallback in these tests
  process.env["HELIUS_API_KEY_1"] = "KEY1";
  process.env["HELIUS_API_KEY_2"] = "KEY2";
  delete process.env["HELIUS_COOLDOWN_MS"]; // default 60s unless a test overrides
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetHeliusFailoverState();
  restore("HELIUS_API_KEY_1", ORIG.k1);
  restore("HELIUS_API_KEY_2", ORIG.k2);
  restore("HELIUS_API_KEY", ORIG.legacy);
  restore("HELIUS_COOLDOWN_MS", ORIG.cd);
});

function restore(name: string, val: string | undefined): void {
  if (val === undefined) delete process.env[name];
  else process.env[name] = val;
}

// ── config loading ────────────────────────────────────────────────

describe("loadHeliusKeys", () => {
  it("returns [key_1, key_2] in preference order", () => {
    expect(loadHeliusKeys()).toEqual(["KEY1", "KEY2"]);
  });

  it("falls back to legacy HELIUS_API_KEY for key_1", () => {
    delete process.env["HELIUS_API_KEY_1"];
    delete process.env["HELIUS_API_KEY_2"];
    process.env["HELIUS_API_KEY"] = "LEGACY";
    expect(loadHeliusKeys()).toEqual(["LEGACY"]);
  });

  it("drops key_2 when it duplicates key_1 (same credit pool)", () => {
    process.env["HELIUS_API_KEY_2"] = "KEY1";
    expect(loadHeliusKeys()).toEqual(["KEY1"]);
  });
});

// ── the core requirement ──────────────────────────────────────────

describe("heliusFetch failover", () => {
  it("429 on key_1 → switches to key_2 and retries once", async () => {
    const cap = makeLogger();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api-key=KEY1")) return new Response("", { status: 429 });
      if (u.includes("api-key=KEY2")) return jsonResponse({ result: { ok: true } });
      throw new Error(`unexpected url: ${u}`);
    });

    const res = await heliusFetch(RPC, { method: "POST", body: "{}" }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: cap.logger,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: true } });
    // exactly two attempts: key_1 then key_2 — no duplicate, no third try
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("api-key=KEY1");
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("api-key=KEY2");
    // switch was logged: key_1, reason 429
    expect(cap.switches).toHaveLength(1);
    expect(cap.switches[0]).toMatchObject({ key: "key_1", reason: "429" });
  });

  it("credit-limit error body on key_1 → switches to key_2", async () => {
    const cap = makeLogger();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api-key=KEY1")) {
        return jsonResponse({ error: "You have exceeded your credit limit" });
      }
      return jsonResponse({ result: { ok: true } });
    });

    const res = await heliusFetch(RPC, { method: "POST", body: "{}" }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: cap.logger,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { ok: true } });
    expect(cap.switches[0]).toMatchObject({ key: "key_1", reason: "credit" });
  });

  it("happy path sends exactly one request (no duplicate)", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: { ok: true } }));
    const res = await heliusFetch(RPC, { method: "POST", body: "{}" }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("api-key=KEY1");
  });

  it("cooled key_1 stays out: next call goes straight to key_2", async () => {
    const cap = makeLogger();
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api-key=KEY1")) return new Response("", { status: 429 });
      return jsonResponse({ result: { ok: true } });
    });
    const opts = {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: cap.logger,
    };

    // Call 1: key_1 429 → key_2. key_1 now cooling (default 60s).
    await heliusFetch(RPC, { method: "POST", body: "{}" }, opts);
    fetchImpl.mockClear();

    // Call 2: key_1 still cooling → only key_2 is hit, one request.
    const res = await heliusFetch(RPC, { method: "POST", body: "{}" }, opts);
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("api-key=KEY2");
  });

  it("prefers key_1 again once its cooldown has passed", async () => {
    process.env["HELIUS_COOLDOWN_MS"] = "5"; // tiny window so the test can wait it out
    let key1Hits = 0;
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api-key=KEY1")) {
        key1Hits += 1;
        // fail only the very first time key_1 is used
        if (key1Hits === 1) return new Response("", { status: 429 });
        return jsonResponse({ result: { via: "key_1" } });
      }
      return jsonResponse({ result: { via: "key_2" } });
    });
    const opts = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const r1 = await heliusFetch(RPC, { method: "POST", body: "{}" }, opts);
    expect(await r1.json()).toEqual({ result: { via: "key_2" } });

    // wait past the 5ms cooldown → key_1 is eligible again and preferred.
    await new Promise((r) => setTimeout(r, 25));
    const r2 = await heliusFetch(RPC, { method: "POST", body: "{}" }, opts);
    expect(await r2.json()).toEqual({ result: { via: "key_1" } });
  });

  it("both keys cooling → throws HeliusAllKeysCoolingError, logged", async () => {
    const cap = makeLogger();
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    await expect(
      heliusFetch(RPC, { method: "POST", body: "{}" }, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: cap.logger,
      }),
    ).rejects.toBeInstanceOf(HeliusAllKeysCoolingError);
    // both keys were tried exactly once — no infinite retry.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(cap.allCooling).toHaveLength(1);
    expect(cap.allCooling[0]).toMatchObject({ reason: "429" });
  });
});

// ── end-to-end through a real handler ─────────────────────────────

describe("handler routes through failover", () => {
  const MINT = "So11111111111111111111111111111111111111112"; // 44 chars, valid

  it("heliusNftMetadata: 429 on key_1 is transparently served by key_2", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("api-key=KEY1")) return new Response("", { status: 429 });
      return jsonResponse({ result: { id: MINT, interface: "V1_NFT" } });
    });

    const res = await heliusNftMetadata({
      body: buf({ mint: MINT }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id).toBe(MINT);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("heliusNftMetadata: both keys cooling → clear 503, not a silent drop", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 429 }));
    const res = await heliusNftMetadata({
      body: buf({ mint: MINT }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe("helius_all_keys_cooling");
  });
});
