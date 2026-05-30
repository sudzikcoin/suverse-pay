import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendPurchase,
  historyPath,
  readRecentPurchases,
  type PurchaseRecord,
} from "../src/history.js";

let tempDir: string;
let path: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "x402-mcp-history-"));
  path = join(tempDir, "history.jsonl");
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function rec(over: Partial<PurchaseRecord> = {}): PurchaseRecord {
  return {
    timestamp: "2026-05-31T00:00:00.000Z",
    url: "https://example.com/x",
    method: "GET",
    listingId: null,
    network: "eip155:8453",
    amount: "50000",
    asset: "USDC",
    payer: "0xpayer",
    payTo: "0xpayee",
    txHash: "0xhash",
    upstreamStatus: 200,
    ...over,
  };
}

describe("history", () => {
  it("returns empty array when the file doesn't exist", async () => {
    expect(await readRecentPurchases(50, path)).toEqual([]);
  });

  it("round-trips a record", async () => {
    await appendPurchase(rec({ url: "https://example.com/one" }), path);
    const got = await readRecentPurchases(50, path);
    expect(got.length).toBe(1);
    expect(got[0]!.url).toBe("https://example.com/one");
  });

  it("returns newest first and respects limit", async () => {
    for (const i of [1, 2, 3, 4, 5]) {
      await appendPurchase(
        rec({ url: `https://example.com/${i}`, timestamp: `2026-05-30T0${i}:00:00Z` }),
        path,
      );
    }
    const got = await readRecentPurchases(3, path);
    expect(got.map((r) => r.url)).toEqual([
      "https://example.com/5",
      "https://example.com/4",
      "https://example.com/3",
    ]);
  });
});

describe("historyPath", () => {
  it("respects XDG_STATE_HOME on POSIX", () => {
    const p = historyPath({ XDG_STATE_HOME: "/tmp/xdg" });
    expect(p).toContain("/tmp/xdg/suverse-x402-mcp/history.jsonl");
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME absent", () => {
    const p = historyPath({});
    expect(p).toMatch(/\.local\/state\/suverse-x402-mcp\/history\.jsonl$/);
  });
});
