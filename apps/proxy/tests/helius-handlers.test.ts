/**
 * Unit tests for the four new Helius-backed internal handlers added
 * alongside helius_tx_decoder. Each test exercises the handler in
 * isolation against a `fetchImpl` stub — no proxy stack, no DB.
 *
 * The contract for every handler is the same:
 *   - missing HELIUS_API_KEY → 503
 *   - missing required input → 400
 *   - upstream network error → 502
 *   - happy path → 200 with normalized body
 *
 * One test per handler per contract slot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { heliusNftMetadata } from "../src/handlers/helius-nft-metadata.js";
import { heliusPriorityFee } from "../src/handlers/helius-priority-fee.js";
import { heliusTxSimulator } from "../src/handlers/helius-tx-simulator.js";
import { heliusWalletHistory } from "../src/handlers/helius-wallet-history.js";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

beforeEach(() => {
  process.env["HELIUS_API_KEY"] = "test-helius-key";
});

afterEach(() => {
  delete process.env["HELIUS_API_KEY"];
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────
// helius_tx_simulator
// ─────────────────────────────────────────────────────────────────────

describe("heliusTxSimulator", () => {
  it("503 when HELIUS_API_KEY missing", async () => {
    delete process.env["HELIUS_API_KEY"];
    const res = await heliusTxSimulator({
      body: buf({ transaction: "AAAA" }),
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("400 when transaction missing", async () => {
    const res = await heliusTxSimulator({
      body: buf({}),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("transaction_required");
  });

  it("400 when body is not valid JSON", async () => {
    const res = await heliusTxSimulator({
      body: Buffer.from("{not json"),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_json_body");
  });

  it("502 when Helius is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("boom"));
    const res = await heliusTxSimulator({
      body: buf({ transaction: "AAAA" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toBe("helius_unreachable");
  });

  it("200 with success=true when RPC returns err=null", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            value: {
              err: null,
              logs: ["Program log: ok"],
              unitsConsumed: 1200,
              accounts: null,
            },
          },
        }),
        { status: 200 },
      ),
    );
    const res = await heliusTxSimulator({
      body: buf({ transaction: "AAAA" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body["success"]).toBe(true);
    expect(body["computeUnits"]).toBe(1200);
    expect(body["logs"]).toEqual(["Program log: ok"]);

    // Verify the RPC envelope we sent.
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { body: string; method: string },
    ];
    expect(url).toContain("mainnet.helius-rpc.com");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body) as {
      method: string;
      params: [string, Record<string, unknown>];
    };
    expect(sent.method).toBe("simulateTransaction");
    expect(sent.params[0]).toBe("AAAA");
    expect(sent.params[1]).toMatchObject({
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
    });
  });

  it("200 with success=false when RPC returns an err object", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            value: {
              err: { InstructionError: [0, "Custom"] },
              logs: ["Program log: failed"],
              unitsConsumed: 800,
            },
          },
        }),
        { status: 200 },
      ),
    );
    const res = await heliusTxSimulator({
      body: buf({ transaction: "AAAA" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body["success"]).toBe(false);
    expect(body["error"]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────
// helius_priority_fee
// ─────────────────────────────────────────────────────────────────────

describe("heliusPriorityFee", () => {
  it("503 when HELIUS_API_KEY missing", async () => {
    delete process.env["HELIUS_API_KEY"];
    const res = await heliusPriorityFee({
      body: null,
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("400 when body is non-JSON garbage", async () => {
    const res = await heliusPriorityFee({
      body: Buffer.from("{nope"),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 with empty body — global estimate (no accountKeys)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            priorityFeeLevels: {
              min: 0,
              low: 1,
              medium: 10,
              high: 100,
              veryHigh: 1000,
              unsafeMax: 100000,
            },
            priorityFeeEstimate: 10,
          },
        }),
        { status: 200 },
      ),
    );
    const res = await heliusPriorityFee({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const levels = body["priorityFeeLevels"] as Record<string, number>;
    expect(levels.medium).toBe(10);
    expect(body["priorityFeeEstimate"]).toBe(10);

    const sent = JSON.parse(
      (fetchImpl.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { method: string; params: [Record<string, unknown>] };
    expect(sent.method).toBe("getPriorityFeeEstimate");
    expect(sent.params[0]).not.toHaveProperty("accountKeys");
    expect(sent.params[0]).toMatchObject({
      options: { includeAllPriorityFeeLevels: true },
    });
  });

  it("forwards accountKeys when supplied", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: { priorityFeeLevels: { medium: 5 }, priorityFeeEstimate: 5 },
        }),
        { status: 200 },
      ),
    );
    const res = await heliusPriorityFee({
      body: buf({ accountKeys: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"] }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const sent = JSON.parse(
      (fetchImpl.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { params: [Record<string, unknown>] };
    expect(sent.params[0]["accountKeys"]).toEqual([
      "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    ]);
  });

  it("400 when accountKeys contains a non-string", async () => {
    const res = await heliusPriorityFee({
      body: buf({ accountKeys: [123] }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("502 when RPC returns an error envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: -32602, message: "Invalid" } }),
        { status: 200 },
      ),
    );
    const res = await heliusPriorityFee({
      body: null,
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
  });
});

// ─────────────────────────────────────────────────────────────────────
// helius_nft_metadata
// ─────────────────────────────────────────────────────────────────────

describe("heliusNftMetadata", () => {
  it("503 when HELIUS_API_KEY missing", async () => {
    delete process.env["HELIUS_API_KEY"];
    const res = await heliusNftMetadata({
      body: buf({ mint: "F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPPiqUyT5RGUMtwba" }),
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("400 when mint missing", async () => {
    const res = await heliusNftMetadata({
      body: buf({}),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("mint_required");
  });

  it("400 on bogus mint length", async () => {
    const res = await heliusNftMetadata({
      body: buf({ mint: "tooshort" }),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_mint_format");
  });

  it("200 on happy path returns flattened asset", async () => {
    const asset = {
      id: "F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPPiqUyT5RGUMtwba",
      interface: "ProgrammableNFT",
      content: { metadata: { name: "Mad Lad #1234" } },
      authorities: [{ address: "AUTH" }],
      compression: { compressed: false },
      grouping: [{ group_key: "collection", group_value: "MAD" }],
      royalty: { percent: 0.05 },
      creators: [{ address: "CR1", share: 100 }],
      ownership: { owner: "OWNER", frozen: false },
      supply: null,
      mutable: true,
      burnt: false,
    };
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: asset }), { status: 200 }),
    );
    const res = await heliusNftMetadata({
      body: buf({ mint: "F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPPiqUyT5RGUMtwba" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body["id"]).toBe(asset.id);
    expect(body["interface"]).toBe("ProgrammableNFT");
    expect((body["content"] as { metadata: { name: string } }).metadata.name).toBe(
      "Mad Lad #1234",
    );
    expect(body["creators"]).toEqual(asset.creators);

    const sent = JSON.parse(
      (fetchImpl.mock.calls[0] as [string, { body: string }])[1].body,
    ) as { method: string; params: { id: string } };
    expect(sent.method).toBe("getAsset");
    expect(sent.params.id).toBe(asset.id);
  });

  it("404 when RPC returns an error envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: -32000, message: "Not found" } }),
        { status: 200 },
      ),
    );
    const res = await heliusNftMetadata({
      body: buf({ mint: "F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPPiqUyT5RGUMtwba" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });

  it("404 when result is null (asset doesn't exist)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: null }), { status: 200 }),
    );
    const res = await heliusNftMetadata({
      body: buf({ mint: "F9Lw3ki3hJ7PF9HQXsBzoY8GyE6sPPiqUyT5RGUMtwba" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────
// helius_wallet_history
// ─────────────────────────────────────────────────────────────────────

describe("heliusWalletHistory", () => {
  it("503 when HELIUS_API_KEY missing", async () => {
    delete process.env["HELIUS_API_KEY"];
    const res = await heliusWalletHistory({
      body: buf({ address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }),
      method: "POST",
    });
    expect(res.status).toBe(503);
  });

  it("400 when address missing", async () => {
    const res = await heliusWalletHistory({
      body: buf({}),
      method: "POST",
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("address_required");
  });

  it("400 on invalid limit", async () => {
    const res = await heliusWalletHistory({
      body: buf({
        address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        limit: 0,
      }),
      method: "POST",
    });
    expect(res.status).toBe(400);
  });

  it("200 on happy path returns transactions verbatim, count populated", async () => {
    const txns = [
      { signature: "s1", type: "SWAP", description: "swap A for B" },
      { signature: "s2", type: "TRANSFER", description: "tx" },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(txns), { status: 200 }),
    );
    const res = await heliusWalletHistory({
      body: buf({
        address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        limit: 10,
      }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body["count"]).toBe(2);
    expect(body["transactions"]).toEqual(txns);

    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url).toContain(
      "/v0/addresses/JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN/transactions",
    );
    expect(url).toContain("limit=10");
    expect(url).toContain("api-key=test-helius-key");
  });

  it("caps limit at 100 when caller asks for more", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    await heliusWalletHistory({
      body: buf({
        address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        limit: 5000,
      }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url).toContain("limit=100");
  });

  it("includes before cursor when supplied", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    await heliusWalletHistory({
      body: buf({
        address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
        before: "prevSig123",
      }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const url = (fetchImpl.mock.calls[0] as [string])[0];
    expect(url).toContain("before=prevSig123");
  });

  it("502 on non-array upstream response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "weird" }), { status: 200 }),
    );
    const res = await heliusWalletHistory({
      body: buf({ address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" }),
      method: "POST",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res.status).toBe(502);
  });
});
