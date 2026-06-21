import { describe, it, expect } from "vitest";
import {
  parseRankingInput,
  shapeNetflowRow,
  shapeTopWallet,
  smartMoneyTokenRankings,
  smartMoneyTopWallets,
} from "../src/handlers/smart-money-rankings.js";
import {
  detectChain,
  parseAddrBody,
  buildLabelResponse,
  walletLabel,
} from "../src/handlers/wallet-label.js";
import type { DbQuerier } from "../src/handlers/types.js";

const buf = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8");

function stubDb(rows: Array<Record<string, unknown>>): DbQuerier {
  return { query: async () => ({ rows }) };
}

describe("parseRankingInput", () => {
  it("empty body -> discovery", () => {
    expect(parseRankingInput(null).kind).toBe("discovery");
    expect(parseRankingInput(Buffer.from("")).kind).toBe("discovery");
  });
  it("valid chain+limit -> ok with defaults applied", () => {
    expect(parseRankingInput(buf({}))).toEqual({ kind: "ok", chain: "solana", limit: 20 });
    expect(parseRankingInput(buf({ chain: "base", limit: 5 }))).toEqual({
      kind: "ok",
      chain: "base",
      limit: 5,
    });
  });
  it("bad chain / limit -> typed errors", () => {
    expect(parseRankingInput(buf({ chain: "eth" })).kind).toBe("invalid_chain");
    expect(parseRankingInput(buf({ limit: 0 })).kind).toBe("invalid_limit");
    expect(parseRankingInput(buf({ limit: 9999 })).kind).toBe("invalid_limit");
    expect(parseRankingInput(buf([1, 2])).kind).toBe("malformed");
    expect(parseRankingInput(Buffer.from("{bad")).kind).toBe("invalid_json");
  });
});

describe("shapeNetflowRow / shapeTopWallet", () => {
  it("rounds + maps netflow row", () => {
    const r = shapeNetflowRow({
      token_address: "T", symbol: "X", net_flow_usd: 1.23456, smart_money_score: 88.34,
      unique_traders: 7,
    });
    expect(r.token).toBe("T");
    expect(r.net_flow_usd).toBe(1.23);
    expect(r.smart_money_score).toBe(88.34);
    expect(r.unique_traders).toBe(7);
  });
  it("maps top wallet row", () => {
    const w = shapeTopWallet({ address: "A", score: 93.33, pnl_90d_usd: 100.5 });
    expect(w.address).toBe("A");
    expect(w.score).toBe(93.33);
    expect(w.pnl_90d_usd).toBe(100.5);
  });
});

describe("detectChain / parseAddrBody", () => {
  it("detects chain by shape", () => {
    expect(detectChain("0x4446adc0b8136ffc55ddb7a488ba5509ace2a5ef")).toBe("base");
    expect(detectChain("CBjwziSG9Z48MSAfqXNuKHyQ3JqrC963pNeivoUSAV5b")).toBe("solana");
    expect(detectChain("nonsense")).toBeNull();
  });
  it("lowercases EVM and passes through solana", () => {
    const p = parseAddrBody(buf({ address: "0x4446ADC0B8136FFC55DDB7A488BA5509ACE2A5EF" }));
    expect(p).toMatchObject({ kind: "ok", address: "0x4446adc0b8136ffc55ddb7a488ba5509ace2a5ef", chain: "base" });
  });
  it("empty/placeholder -> discovery; bad -> invalid_value", () => {
    expect(parseAddrBody(null).kind).toBe("discovery");
    expect(parseAddrBody(buf({ address: "<address>" })).kind).toBe("discovery");
    expect(parseAddrBody(buf({ address: "zzz" })).kind).toBe("invalid_value");
  });
});

describe("buildLabelResponse", () => {
  it("unlabeled -> labeled:false, no error", () => {
    const r = buildLabelResponse({ kind: "wallet_label_critical", address: "A", chain: "solana", row: null });
    expect(r["labeled"]).toBe(false);
    expect(r["labels"]).toEqual([]);
  });
  it("labeled -> derives label list from boolean flags", () => {
    const r = buildLabelResponse({
      kind: "wallet_label_critical", address: "A", chain: "base",
      row: { chain: "base", is_market_maker: true, is_cex_deposit: false, source_confidence: "high" },
    });
    expect(r["labeled"]).toBe(true);
    expect(r["labels"]).toEqual(["market_maker"]);
  });
});

describe("handlers (stub db, fail-closed)", () => {
  it("token-rankings 503 when db absent (never settle uncomputable)", async () => {
    const res = await smartMoneyTokenRankings({ body: buf({}), method: "POST" });
    expect(res.status).toBe(503);
  });
  it("token-rankings 200 with rows via preflightData", async () => {
    const res = await smartMoneyTokenRankings({
      body: buf({ chain: "solana", limit: 10 }), method: "POST", db: stubDb([]),
      preflightData: { kind: "sm_netflow_critical", mode: "rankings", chain: "solana", limit: 10, rows: [{ token_address: "T", net_flow_usd: 5 }], latest: new Date() },
    });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)["kind"]).toBe("rankings");
  });
  it("top-wallets 422 on bad chain", async () => {
    const res = await smartMoneyTopWallets({ body: buf({ chain: "eth" }), method: "POST", db: stubDb([]) });
    expect(res.status).toBe(422);
  });
  it("wallet-label 200 from db", async () => {
    const res = await walletLabel({
      body: buf({ address: "0x4446adc0b8136ffc55ddb7a488ba5509ace2a5ef" }), method: "POST",
      db: stubDb([{ chain: "base", is_market_maker: true, source_confidence: "high" }]),
    });
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>)["labeled"]).toBe(true);
  });
  it("wallet-label 422 on garbage address", async () => {
    const res = await walletLabel({ body: buf({ address: "zzz" }), method: "POST", db: stubDb([]) });
    expect(res.status).toBe(422);
  });
});
