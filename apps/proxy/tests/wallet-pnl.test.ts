import { describe, expect, it } from "vitest";
import {
  buildPnlResponse,
  detectChain,
  parseAddrBody,
  walletPnl,
  walletPnlPreflight,
  walletPnlValidator,
} from "../src/handlers/wallet-pnl.js";
import type { DbQuerier } from "../src/handlers/types.js";

const NOW = new Date("2026-06-22T00:00:00.000Z");
const SOL = "8psNvWTrdNTiVRNzAgsou9kETXNJm2SXZyaKuJraVRtf";
const EVM = "0x28c6c06298d514db089934071355e5743bf21d60";

function buf(o: unknown): Buffer {
  return Buffer.from(JSON.stringify(o));
}

function fakeDb(rows: Array<Record<string, unknown>>): DbQuerier {
  return { query: async () => ({ rows }) } as unknown as DbQuerier;
}
function throwingDb(): DbQuerier {
  return {
    query: async () => {
      throw new Error("connection refused");
    },
  } as unknown as DbQuerier;
}

function scoredRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: SOL,
    chain: "solana",
    tier: "elite",
    status: "active",
    score: 82.4,
    confidence_score: 71,
    pnl_90d_usd: 12345.6,
    realized_pnl_usd: 9000.1,
    win_rate: 0.63,
    profit_factor: 2.4,
    median_return_per_trade: 0.11,
    max_drawdown_90d: -0.32,
    trade_count_90d: 140,
    buy_count_90d: 72,
    sell_count_90d: 68,
    early_entries_30d: 9,
    days_since_last_trade: 1,
    median_holding_time_seconds: 36000,
    last_scored_at: new Date(NOW.getTime() - 3_600_000),
    last_activity_at: new Date(NOW.getTime() - 7_200_000),
    discovered_at: new Date(NOW.getTime() - 60 * 86_400_000),
    score_version: "v3",
    ...overrides,
  };
}

describe("detectChain", () => {
  it("maps 0x… to base and base58 to solana", () => {
    expect(detectChain(EVM)).toBe("base");
    expect(detectChain(SOL)).toBe("solana");
    expect(detectChain("not-an-address")).toBeNull();
  });
});

describe("parseAddrBody", () => {
  it("empty / placeholder body → discovery", () => {
    expect(parseAddrBody(null).kind).toBe("discovery");
    expect(parseAddrBody(buf({})).kind).toBe("discovery");
    expect(parseAddrBody(buf({ address: "<wallet>" })).kind).toBe("discovery");
  });
  it("accepts wallet alias and lowercases EVM", () => {
    const p = parseAddrBody(buf({ wallet: EVM.toUpperCase().replace("0X", "0x") }));
    expect(p.kind).toBe("ok");
    if (p.kind === "ok") {
      expect(p.address).toBe(EVM);
      expect(p.chain).toBe("base");
    }
  });
  it("array body → malformed; junk address → invalid_value; bad chain → invalid_chain", () => {
    expect(parseAddrBody(buf([1, 2])).kind).toBe("malformed");
    expect(parseAddrBody(buf({ address: "notavalidwalletaddress12345" })).kind).toBe(
      "invalid_value",
    );
    expect(parseAddrBody(buf({ address: SOL, chain: "eth" })).kind).toBe("invalid_chain");
  });
});

describe("walletPnlValidator", () => {
  it("passes empty body (discovery → 402) and valid address", () => {
    expect(walletPnlValidator(null, "POST")).toBeNull();
    expect(walletPnlValidator(buf({ address: SOL }), "POST")).toBeNull();
  });
  it("422s a present-but-bad address before the challenge", () => {
    const r = walletPnlValidator(buf({ address: "nope" }), "POST");
    expect(r?.status).toBe(422);
    expect(r?.body).toMatchObject({ error: "invalid_address" });
  });
  it("422s a bad chain override", () => {
    const r = walletPnlValidator(buf({ address: SOL, chain: "eth" }), "POST");
    expect(r?.status).toBe(422);
    expect(r?.body).toMatchObject({ error: "invalid_chain" });
  });
});

describe("buildPnlResponse", () => {
  it("untracked wallet is a clean 200 verdict, not an error", () => {
    const body = buildPnlResponse(
      { kind: "wallet_pnl_critical", address: SOL, chain: "solana", row: null },
      NOW,
    );
    expect(body["tracked"]).toBe(false);
    expect((body["data_quality"] as Record<string, unknown>)["tracking_coverage"]).toBe(
      "untracked",
    );
    expect((body["verdict"] as Record<string, unknown>)["profitability"]).toBe("unknown");
  });
  it("tracked wallet surfaces pnl/activity/skill + profitability bucket", () => {
    const body = buildPnlResponse(
      { kind: "wallet_pnl_critical", address: SOL, chain: "solana", row: scoredRow() },
      NOW,
    );
    expect(body["tracked"]).toBe(true);
    const verdict = body["verdict"] as Record<string, unknown>;
    expect(verdict["profitability"]).toBe("profitable");
    expect(verdict["confidence"]).toBe("high");
    const signals = body["signals"] as Record<string, Record<string, unknown>>;
    expect(signals["pnl"]["realized_pnl_usd"]).toBe(9000.1);
    expect(signals["activity"]["trade_count_90d"]).toBe(140);
    expect(signals["skill"]["tier"]).toBe("elite");
    expect((body["data_quality"] as Record<string, unknown>)["stale"]).toBe(false);
  });
  it("negative realized PnL → unprofitable; stale when last_scored old", () => {
    const body = buildPnlResponse(
      {
        kind: "wallet_pnl_critical",
        address: SOL,
        chain: "solana",
        row: scoredRow({
          realized_pnl_usd: -500,
          last_scored_at: new Date(NOW.getTime() - 5 * 86_400_000),
        }),
      },
      NOW,
    );
    expect((body["verdict"] as Record<string, unknown>)["profitability"]).toBe("unprofitable");
    expect((body["data_quality"] as Record<string, unknown>)["stale"]).toBe(true);
  });
});

describe("walletPnlPreflight (fail-closed)", () => {
  it("bad address → 422 input_schema, never settles", async () => {
    const r = await walletPnlPreflight({ body: buf({ address: "nope" }), method: "POST" } as never);
    expect(r.proceed).toBe(false);
    expect(r.status).toBe(422);
  });
  it("no db → 503 (no charge)", async () => {
    const r = await walletPnlPreflight({ body: buf({ address: SOL }), method: "POST" } as never);
    expect(r.proceed).toBe(false);
    expect(r.status).toBe(503);
  });
  it("db throws → 503 critical_source_unavailable", async () => {
    const r = await walletPnlPreflight({
      body: buf({ address: SOL }),
      method: "POST",
      db: throwingDb(),
    } as never);
    expect(r.proceed).toBe(false);
    expect(r.status).toBe(503);
    expect((r.body as Record<string, unknown>)["source"]).toBe("sm_wallets");
  });
  it("reachable db → proceeds and threads the row", async () => {
    const r = await walletPnlPreflight({
      body: buf({ address: SOL }),
      method: "POST",
      db: fakeDb([scoredRow()]),
    } as never);
    expect(r.proceed).toBe(true);
  });
});

describe("walletPnl handler", () => {
  it("uses preflightData when present (no second query)", async () => {
    const res = await walletPnl({
      body: buf({ address: SOL }),
      method: "POST",
      db: throwingDb(), // would 503 if it re-queried
      preflightData: { kind: "wallet_pnl_critical", address: SOL, chain: "solana", row: scoredRow() },
    } as never);
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)["tracked"]).toBe(true);
  });
  it("422s an invalid address end-to-end", async () => {
    const res = await walletPnl({ body: buf({ address: "nope" }), method: "POST" } as never);
    expect(res.status).toBe(422);
  });
});
