/**
 * token-entry-verdict tests — zero real network / zero real DB.
 *
 * The db stub routes by SQL substring (each of the six queries the
 * endpoint family runs has a unique marker); the fetch stub reuses the
 * token-check Jupiter/Helius/Dexscreener fixture shapes so the safety
 * layer runs its REAL in-process path.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildEntryVerdictResponse,
  deriveEntryVerdict,
  tokenEntryVerdict,
  tokenEntryVerdictInputSchema,
  tokenEntryVerdictPreflight,
  tokenEntryVerdictValidator,
  type EntryFacts,
  type MintFlowWindowData,
} from "../src/handlers/token-entry-verdict.js";
import type { DbQuerier } from "../src/handlers/types.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const MEME = "78B31QV1rtyoe2EYvVNjBVjeowyrtcH5FPTE4tCypump";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const RAW_CAP_BYTES = 6 * 1024;

const ORIGINAL_HELIUS_KEY = process.env["HELIUS_API_KEY"];
beforeAll(() => {
  process.env["HELIUS_API_KEY"] = "test-key";
});
afterAll(() => {
  if (ORIGINAL_HELIUS_KEY === undefined) delete process.env["HELIUS_API_KEY"];
  else process.env["HELIUS_API_KEY"] = ORIGINAL_HELIUS_KEY;
});

// ─────────────────────────────────────────────────────────────────────
// deriveEntryVerdict — pure decision-table tests
// ─────────────────────────────────────────────────────────────────────

function facts(over: Partial<EntryFacts> = {}): EntryFacts {
  return {
    safety_risk_level: "low",
    safety_flags: [],
    safety_confidence: "high",
    netflow_24h_usd: 500,
    netflow_7d_usd: 2000,
    netflow_30d_usd: 5000,
    flow_available: true,
    ring_or_bot_dominated: false,
    labels_available: true,
    tape_stale: false,
    ...over,
  };
}

describe("deriveEntryVerdict", () => {
  it("clean safety + accumulation + no dominance -> ENTER high", () => {
    const v = deriveEntryVerdict(facts());
    expect(v.decision).toBe("ENTER");
    expect(v.confidence).toBe("high");
    expect(v.decisive_factors).toEqual([
      "safety_clean",
      "smart_money_accumulation",
      "no_ring_or_bot_dominance",
    ]);
  });

  it("safety high / critical vetoes any flow -> AVOID", () => {
    for (const risk of ["high", "critical"] as const) {
      const v = deriveEntryVerdict(facts({ safety_risk_level: risk }));
      expect(v.decision).toBe("AVOID");
      expect(v.decisive_factors).toEqual([`safety_risk_${risk}`]);
    }
  });

  it("unreadable safety (null risk) -> AVOID, never a silent pass", () => {
    const v = deriveEntryVerdict(facts({ safety_risk_level: null }));
    expect(v.decision).toBe("AVOID");
    expect(v.decisive_factors).toEqual(["safety_unreadable"]);
  });

  it("moderate risk is not clean -> CAUTION (not AVOID)", () => {
    const v = deriveEntryVerdict(facts({ safety_risk_level: "moderate" }));
    expect(v.decision).toBe("CAUTION");
    expect(v.decisive_factors).toContain("safety_not_clean");
  });

  it("risk low but flags present blocks ENTER -> CAUTION", () => {
    const v = deriveEntryVerdict(
      facts({ safety_flags: ["freeze_authority_live"] }),
    );
    expect(v.decision).toBe("CAUTION");
    expect(v.summary).toContain("freeze_authority_live");
  });

  it("strong distribution in BOTH windows -> AVOID even with clean safety", () => {
    const v = deriveEntryVerdict(
      facts({ netflow_24h_usd: -600, netflow_7d_usd: -1800 }),
    );
    expect(v.decision).toBe("AVOID");
    expect(v.decisive_factors).toEqual(["smart_money_strong_distribution"]);
  });

  it("distribution AVOID boundary is inclusive at -500 / -1500", () => {
    expect(
      deriveEntryVerdict(
        facts({ netflow_24h_usd: -500, netflow_7d_usd: -1500 }),
      ).decision,
    ).toBe("AVOID");
    expect(
      deriveEntryVerdict(
        facts({ netflow_24h_usd: -499.99, netflow_7d_usd: -1500 }),
      ).decision,
    ).toBe("CAUTION");
  });

  it("single-window distribution is CAUTION, not AVOID", () => {
    const v = deriveEntryVerdict(
      facts({ netflow_24h_usd: -600, netflow_7d_usd: -100 }),
    );
    expect(v.decision).toBe("CAUTION");
    expect(v.decisive_factors).toContain("no_meaningful_accumulation");
  });

  it("degraded flow can never produce a distribution AVOID", () => {
    const v = deriveEntryVerdict(
      facts({
        flow_available: false,
        netflow_24h_usd: null,
        netflow_7d_usd: null,
      }),
    );
    expect(v.decision).toBe("CAUTION");
    expect(v.decisive_factors).toContain("flow_unavailable");
    expect(v.confidence).toBe("medium");
  });

  it("ENTER accumulation gate: either window can qualify, boundaries inclusive", () => {
    expect(
      deriveEntryVerdict(
        facts({ netflow_24h_usd: 250, netflow_7d_usd: 0 }),
      ).decision,
    ).toBe("ENTER");
    expect(
      deriveEntryVerdict(
        facts({ netflow_24h_usd: 0, netflow_7d_usd: 1000 }),
      ).decision,
    ).toBe("ENTER");
    expect(
      deriveEntryVerdict(
        facts({ netflow_24h_usd: 249.99, netflow_7d_usd: 999.99 }),
      ).decision,
    ).toBe("CAUTION");
  });

  it("ring/bot dominance blocks ENTER -> CAUTION", () => {
    const v = deriveEntryVerdict(facts({ ring_or_bot_dominated: true }));
    expect(v.decision).toBe("CAUTION");
    expect(v.decisive_factors).toContain("ring_or_bot_dominance");
  });

  it("unknowable dominance (labels layer down) never ENTERs", () => {
    const v = deriveEntryVerdict(
      facts({ labels_available: false, ring_or_bot_dominated: null }),
    );
    expect(v.decision).toBe("CAUTION");
    expect(v.decisive_factors).toContain("label_context_unavailable");
  });

  it("stale tape lowers confidence one step but does not veto ENTER", () => {
    const v = deriveEntryVerdict(facts({ tape_stale: true }));
    expect(v.decision).toBe("ENTER");
    expect(v.confidence).toBe("medium");
  });

  it("stale tape is named when the call lands on CAUTION", () => {
    const v = deriveEntryVerdict(
      facts({ tape_stale: true, netflow_24h_usd: 0, netflow_7d_usd: 0 }),
    );
    expect(v.decision).toBe("CAUTION");
    expect(v.decisive_factors).toContain("stale_tape");
    expect(v.summary).toContain("stale");
  });

  it("confidence math: 0 degradations high, 1 medium, 2+ low", () => {
    expect(deriveEntryVerdict(facts()).confidence).toBe("high");
    expect(
      deriveEntryVerdict(facts({ safety_confidence: "low" })).confidence,
    ).toBe("medium");
    expect(
      deriveEntryVerdict(
        facts({ tape_stale: true, labels_available: false }),
      ).confidence,
    ).toBe("low");
    expect(
      deriveEntryVerdict(
        facts({
          tape_stale: true,
          labels_available: false,
          flow_available: false,
          netflow_24h_usd: null,
          netflow_7d_usd: null,
        }),
      ).confidence,
    ).toBe("low");
  });

  it("confidence applies to AVOID verdicts too", () => {
    const v = deriveEntryVerdict(
      facts({ safety_risk_level: "high", flow_available: false }),
    );
    expect(v.decision).toBe("AVOID");
    expect(v.confidence).toBe("medium");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Validator — discovery split
// ─────────────────────────────────────────────────────────────────────

describe("tokenEntryVerdictValidator", () => {
  it("empty body -> null (discovery pass-through to the 402 challenge)", () => {
    expect(tokenEntryVerdictValidator(null, "POST")).toBeNull();
    expect(tokenEntryVerdictValidator(Buffer.from(""), "POST")).toBeNull();
  });

  it("missing / placeholder mint -> null (discovery)", () => {
    for (const body of [
      {},
      { mint: "" },
      { mint: "string" },
      { mint: "<solana mint address>" },
      { mint: "YOUR_MINT" },
      { mint: 0 },
    ]) {
      expect(
        tokenEntryVerdictValidator(Buffer.from(JSON.stringify(body)), "POST"),
        `expected discovery pass-through for ${JSON.stringify(body)}`,
      ).toBeNull();
    }
  });

  it("invalid JSON -> 400", () => {
    expect(tokenEntryVerdictValidator(Buffer.from("{nope"), "POST")?.status).toBe(
      400,
    );
  });

  it("array body -> 422", () => {
    expect(tokenEntryVerdictValidator(Buffer.from("[1]"), "POST")?.status).toBe(
      422,
    );
  });

  it("present non-base58 mint -> 422 with input_schema", () => {
    const res = tokenEntryVerdictValidator(
      Buffer.from(JSON.stringify({ mint: "0xdeadbeef" })),
      "POST",
    );
    expect(res?.status).toBe(422);
    const body = res?.body as Record<string, unknown>;
    expect(body["error"]).toBe("invalid_mint");
    expect(body["input_schema"]).toBe(tokenEntryVerdictInputSchema);
  });

  it("valid mint passes", () => {
    expect(
      tokenEntryVerdictValidator(
        Buffer.from(JSON.stringify({ mint: BONK })),
        "POST",
      ),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Stubs — db keyed by SQL substring, fetch reusing token-check fixtures
// ─────────────────────────────────────────────────────────────────────

interface FlowRow {
  buy_usd: number;
  sell_usd: number;
  distinct_buyers: number;
  distinct_sellers: number;
  trade_legs: number;
}

interface DbOpts {
  dbThrows?: boolean;
  flowThrows?: boolean;
  labelsThrows?: boolean;
  tapeThrows?: boolean;
  cacheThrows?: boolean;
  flow24?: FlowRow;
  flow7d?: FlowRow;
  cacheRow?: Record<string, unknown> | null;
  traderRows?: Array<Record<string, unknown>>;
  tapeRow?: Record<string, unknown>;
}

const EMPTY_FLOW: FlowRow = {
  buy_usd: 0,
  sell_usd: 0,
  distinct_buyers: 0,
  distinct_sellers: 0,
  trade_legs: 0,
};

const EMPTY_ELITE_CARD = {
  trade_legs: 0,
  distinct_elite_wallets: 0,
  buy_usd: 0,
  sell_usd: 0,
  first_elite_trade: null,
  last_elite_trade: null,
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

function trader(
  addr: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    wallet_address: addr,
    last_trade_at: hoursAgo(2),
    legs: 4,
    is_contract: null,
    is_cex_deposit: null,
    is_market_maker: null,
    is_deployer: null,
    is_lp_actor: null,
    is_probable_bot: null,
    ...over,
  };
}

const LABELED_HUMAN = {
  is_contract: false,
  is_cex_deposit: false,
  is_market_maker: false,
  is_deployer: false,
  is_lp_actor: false,
  is_probable_bot: false,
};

function stubDb(opts: DbOpts = {}): DbQuerier {
  return {
    async query(text: string, values?: unknown[]) {
      if (opts.dbThrows) throw new Error("connection refused");
      // token-check elite feed + card (safety layer runs in-process).
      if (text.includes("last_elite_trade_at")) {
        return { rows: [{ last_elite_trade_at: hoursAgo(1) }] };
      }
      if (text.includes("distinct_elite_wallets")) {
        return { rows: [EMPTY_ELITE_CARD] };
      }
      // Fresh per-mint netflow (24h vs 7d told apart by windowStart).
      if (text.includes("distinct_buyers")) {
        if (opts.flowThrows) throw new Error("netflow query timeout");
        const windowStart = values?.[6] as Date;
        const winHours = (Date.now() - windowStart.getTime()) / 3_600_000;
        const row = winHours < 100 ? opts.flow24 : opts.flow7d;
        return { rows: [row ?? EMPTY_FLOW] };
      }
      if (text.includes("sm_netflow_cache")) {
        if (opts.cacheThrows) throw new Error("cache query timeout");
        if (opts.cacheRow === null) return { rows: [] };
        return {
          rows: [
            opts.cacheRow ?? {
              net_flow_usd: 4321.5,
              buy_usd: 6000,
              sell_usd: 1678.5,
              smart_money_score: 71.2,
              unique_traders: 9,
              computed_at: hoursAgo(3),
            },
          ],
        };
      }
      if (text.includes("recent_traders")) {
        if (opts.labelsThrows) throw new Error("labels query timeout");
        return { rows: opts.traderRows ?? [] };
      }
      if (text.includes("last_chain_trade_at")) {
        if (opts.tapeThrows) throw new Error("tape query timeout");
        return {
          rows: [
            opts.tapeRow ?? {
              last_chain_trade_at: hoursAgo(1),
              last_mint_trade_at: hoursAgo(2),
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    },
  };
}

interface FetchOpts {
  jupTokens?: Array<Record<string, unknown>>;
  jupTokenStatus?: number;
  quoteStatus?: number;
  quoteBody?: Record<string, unknown>;
  /** Per-URL-marker call counter for the fetched-once assertions. */
  counts?: Record<string, number>;
}

function jupToken(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: MEME,
    name: "Openverse",
    symbol: "Openverse",
    decimals: 6,
    holderCount: 1087,
    organicScore: 0,
    organicScoreLabel: "low",
    audit: {
      mintAuthorityDisabled: true,
      freezeAuthorityDisabled: true,
      devMints: 0,
      topHoldersPercentage: 20.3,
    },
    firstPool: { id: MEME, createdAt: "2026-06-03T13:20:27Z" },
    liquidity: 2263.8,
    mcap: 3395.2,
    stats24h: { priceChange: -0.88, holderChange: -1.9 },
    tags: ["unknown"],
    ...overrides,
  };
}

function stubFetch(opts: FetchOpts = {}): typeof fetch {
  const bump = (key: string) => {
    if (opts.counts) opts.counts[key] = (opts.counts[key] ?? 0) + 1;
  };
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("tokens/v2/search")) {
      bump("jup_search");
      if (opts.jupTokenStatus && opts.jupTokenStatus !== 200) {
        return new Response("upstream down", { status: opts.jupTokenStatus });
      }
      return Response.json(opts.jupTokens ?? [jupToken()]);
    }
    if (u.includes("swap/v1/quote")) {
      bump("jup_quote");
      if (opts.quoteStatus && opts.quoteStatus !== 200) {
        return Response.json(opts.quoteBody ?? { error: "boom" }, {
          status: opts.quoteStatus,
        });
      }
      return Response.json(
        opts.quoteBody ?? { priceImpactPct: "0.0004", routePlan: [] },
      );
    }
    if (u.includes("helius-rpc.com")) {
      bump("helius");
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      if (body.method === "getTokenSupply") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: { value: { amount: "1000", decimals: 6 } },
        });
      }
      if (body.method === "getTokenLargestAccounts") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            value: [
              { address: "PoolAcct", amount: "658" },
              { address: "WalletAcct", amount: "164" },
            ],
          },
        });
      }
      if (body.method === "getMultipleAccounts") {
        const params = JSON.parse(String(init?.body ?? "{}")) as {
          params: [string[], { encoding: string }];
        };
        if (params.params[1].encoding === "jsonParsed") {
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: {
              value: [
                { data: { parsed: { info: { owner: "PoolAuthority" } } } },
                { data: { parsed: { info: { owner: "WalletOwner" } } } },
              ],
            },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            value: params.params[0].map((owner: string) =>
              owner === "PoolAuthority"
                ? { owner: PUMPSWAP }
                : { owner: SYSTEM_PROGRAM },
            ),
          },
        });
      }
      if (body.method === "getAsset") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: { metadata: { name: "Openverse", symbol: "Openverse" } },
            token_info: { decimals: 6, token_program: "tokenkeg" },
          },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: null });
    }
    if (u.includes("dexscreener.com")) {
      bump("dexscreener");
      return Response.json({
        pairs: [{ liquidity: { usd: 4497 }, pairCreatedAt: 1780500000000 }],
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
}

const mintBody = (mint: string) => Buffer.from(JSON.stringify({ mint }));

// ─────────────────────────────────────────────────────────────────────
// Preflight — no-charge guarantees
// ─────────────────────────────────────────────────────────────────────

describe("tokenEntryVerdictPreflight", () => {
  it("PAID discovery-class body -> proceed:false 422 + input_schema (never settles)", async () => {
    for (const raw of [null, "{}", JSON.stringify({ mint: "string" })]) {
      const pf = await tokenEntryVerdictPreflight({
        body: raw === null ? null : Buffer.from(raw),
        method: "POST",
        db: stubDb(),
        fetchImpl: stubFetch(),
      });
      expect(pf.proceed, `expected no-proceed for ${raw}`).toBe(false);
      if (!pf.proceed) {
        expect(pf.status).toBe(422);
        expect(
          (pf.body as { input_schema?: unknown }).input_schema,
        ).toBeDefined();
      }
    }
  });

  it("tokenCheckPreflight DB failure passes through verbatim -> 503, no charge", async () => {
    const pf = await tokenEntryVerdictPreflight({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({ dbThrows: true }),
      fetchImpl: stubFetch(),
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) {
      expect(pf.status).toBe(503);
      const body = pf.body as Record<string, unknown>;
      expect(body["source"]).toBe("smart_money_db");
      expect(body["retryable"]).toBe(true);
    }
  });

  it("Jupiter tokens/v2 down passes through -> 503, no charge", async () => {
    const pf = await tokenEntryVerdictPreflight({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb(),
      fetchImpl: stubFetch({ jupTokenStatus: 502 }),
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) expect(pf.status).toBe(503);
  });

  it("no db wired -> proceed:false (fail-closed)", async () => {
    const pf = await tokenEntryVerdictPreflight({
      body: mintBody(MEME),
      method: "POST",
      fetchImpl: stubFetch(),
    });
    expect(pf.proceed).toBe(false);
  });

  it("healthy critical path proceeds carrying the token-check critical data", async () => {
    const pf = await tokenEntryVerdictPreflight({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb(),
      fetchImpl: stubFetch(),
    });
    expect(pf.proceed).toBe(true);
    if (pf.proceed) {
      const data = pf.data as Record<string, unknown>;
      expect(data["kind"]).toBe("token_entry_verdict_critical");
      expect(data["mint"]).toBe(MEME);
      expect((data["token_check"] as Record<string, unknown>)["kind"]).toBe(
        "token_check_critical",
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Handler integration paths
// ─────────────────────────────────────────────────────────────────────

const ACCUMULATING: Pick<DbOpts, "flow24" | "flow7d"> = {
  flow24: {
    buy_usd: 750,
    sell_usd: 250,
    distinct_buyers: 3,
    distinct_sellers: 1,
    trade_legs: 6,
  },
  flow7d: {
    buy_usd: 3000,
    sell_usd: 500,
    distinct_buyers: 5,
    distinct_sellers: 2,
    trade_legs: 20,
  },
};

describe("tokenEntryVerdict handler", () => {
  it("safe token + smart accumulation + clean traders -> ENTER high", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({
        ...ACCUMULATING,
        traderRows: [
          trader("W1", LABELED_HUMAN),
          trader("W2", { ...LABELED_HUMAN, is_probable_bot: true }),
          trader("W3"),
          trader("W4"),
        ],
      }),
      fetchImpl: stubFetch(),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["decision"]).toBe("ENTER");
    expect(b["verdict"]["confidence"]).toBe("high");
    expect(b["signals"]["safety"]["verdict"]).toBe("low");
    expect(b["signals"]["smart_money"]["netflow_24h_usd"]).toBe(500);
    expect(b["signals"]["smart_money"]["netflow_7d_usd"]).toBe(2500);
    expect(b["signals"]["smart_money"]["netflow_30d_usd"]).toBe(4321.5);
    expect(b["signals"]["smart_money"]["direction"]).toBe("accumulation");
    expect(b["signals"]["trader_context"]["ring_or_bot_dominated"]).toBe(false);
    expect(b["signals"]["trader_context"]["label_counts"]["probable_bot"]).toBe(1);
    expect(b["signals"]["trader_context"]["label_counts"]["unlabeled"]).toBe(2);
    expect(b["data_quality"]["stale_sources"]).toEqual([]);
    expect(b["data_quality"]["windows_used"]).toEqual(["24h", "7d", "30d"]);
    expect(b["data_quality"]["tape_freshness"]["stale"]).toBe(false);
  });

  it("safe token + strong distribution in both windows -> AVOID", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({
        flow24: { ...EMPTY_FLOW, buy_usd: 100, sell_usd: 700 },
        flow7d: { ...EMPTY_FLOW, buy_usd: 300, sell_usd: 2100 },
      }),
      fetchImpl: stubFetch(),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["decision"]).toBe("AVOID");
    expect(b["verdict"]["decisive_factors"]).toEqual([
      "smart_money_strong_distribution",
    ]);
    expect(b["signals"]["smart_money"]["direction"]).toBe("distribution");
  });

  it("single-window distribution stays CAUTION", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({
        flow24: { ...EMPTY_FLOW, buy_usd: 100, sell_usd: 700 },
        flow7d: { ...EMPTY_FLOW, buy_usd: 900, sell_usd: 1000 },
      }),
      fetchImpl: stubFetch(),
    });
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["decision"]).toBe("CAUTION");
  });

  it("unsafe token -> AVOID regardless of heavy smart accumulation", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({ ...ACCUMULATING, traderRows: [trader("W1", LABELED_HUMAN)] }),
      // Unknown to Jupiter + not tradable = unknown_token -> critical.
      fetchImpl: stubFetch({
        jupTokens: [],
        quoteStatus: 400,
        quoteBody: { error: "x", errorCode: "TOKEN_NOT_TRADABLE" },
      }),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["decision"]).toBe("AVOID");
    expect(b["verdict"]["decisive_factors"]).toEqual(["safety_risk_critical"]);
    expect(b["signals"]["safety"]["flags"]).toContain("unknown_token");
  });

  it("netflow query throws -> 200 safety-only degrade, CAUTION floor + stale_sources", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({
        flowThrows: true,
        traderRows: [trader("W1", LABELED_HUMAN)],
      }),
      fetchImpl: stubFetch(),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["decision"]).toBe("CAUTION");
    expect(b["verdict"]["decisive_factors"]).toContain("flow_unavailable");
    expect(b["verdict"]["confidence"]).toBe("medium");
    expect(b["data_quality"]["stale_sources"]).toContain("sm_trades_netflow");
    expect(b["signals"]["smart_money"]["netflow_24h_usd"]).toBeNull();
    expect(b["signals"]["smart_money"]["direction"]).toBe("unknown");
    // 30d cache still readable -> still reported.
    expect(b["data_quality"]["windows_used"]).toEqual(["30d"]);
  });

  it("every non-critical layer down -> still 200, CAUTION, low confidence", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({
        flowThrows: true,
        cacheThrows: true,
        labelsThrows: true,
        tapeThrows: true,
      }),
      fetchImpl: stubFetch(),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["decision"]).toBe("CAUTION");
    expect(b["verdict"]["confidence"]).toBe("low");
    expect(b["data_quality"]["stale_sources"]).toEqual([
      "sm_trades_netflow",
      "sm_netflow_cache_30d",
      "sm_wallet_labels",
      "sm_trades_tape",
    ]);
    expect(b["data_quality"]["windows_used"]).toEqual([]);
  });

  it("stale tape (>24h) lowers confidence and is named in data_quality", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({
        ...ACCUMULATING,
        traderRows: [trader("W1", LABELED_HUMAN)],
        tapeRow: {
          last_chain_trade_at: hoursAgo(40),
          last_mint_trade_at: hoursAgo(41),
        },
      }),
      fetchImpl: stubFetch(),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    // Rules still permit ENTER; honesty shows up as reduced confidence.
    expect(b["verdict"]["decision"]).toBe("ENTER");
    expect(b["verdict"]["confidence"]).toBe("medium");
    expect(b["data_quality"]["stale_sources"]).toContain("stale_tape");
    expect(b["data_quality"]["tape_freshness"]["stale"]).toBe(true);
    expect(
      b["data_quality"]["tape_freshness"]["hours_since_last_chain_trade"],
    ).toBeGreaterThan(24);
  });

  it("empty tape (no trades ever) is treated as stale, never as fresh silence", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({
        tapeRow: { last_chain_trade_at: null, last_mint_trade_at: null },
      }),
      fetchImpl: stubFetch(),
    });
    const b = res.body as Record<string, any>;
    expect(b["data_quality"]["tape_freshness"]["stale"]).toBe(true);
    expect(b["verdict"]["confidence"]).toBe("medium");
  });

  it("bot-dominated recent traders block ENTER -> CAUTION", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({
        ...ACCUMULATING,
        traderRows: [
          trader("B1", { ...LABELED_HUMAN, is_probable_bot: true }),
          trader("B2", { ...LABELED_HUMAN, is_probable_bot: true }),
          trader("W1", LABELED_HUMAN),
        ],
      }),
      fetchImpl: stubFetch(),
    });
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["decision"]).toBe("CAUTION");
    expect(b["verdict"]["decisive_factors"]).toContain("ring_or_bot_dominance");
    expect(b["signals"]["trader_context"]["ring_or_bot_dominated"]).toBe(true);
  });

  it("invalid mint -> 422 straight from the handler", async () => {
    const res = await tokenEntryVerdict({
      body: Buffer.from(JSON.stringify({ mint: "l0l" })),
      method: "POST",
      db: stubDb(),
      fetchImpl: stubFetch(),
    });
    expect(res.status).toBe(422);
  });

  it("safety recompute failure post-payment passes through as retryable 503", async () => {
    // No preflightData threaded and Jupiter down at handler time: the
    // CRITICAL layer cannot degrade — verbatim 503 (refund-worker path).
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb(ACCUMULATING),
      fetchImpl: stubFetch({ jupTokenStatus: 502 }),
    });
    expect(res.status).toBe(503);
    const b = res.body as Record<string, unknown>;
    expect(b["error"]).toBe("critical_source_unavailable");
    expect(b["retryable"]).toBe(true);
  });

  it("empty 30d cache row degrades gracefully (null 30d, window not claimed)", async () => {
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db: stubDb({ cacheRow: null }),
      fetchImpl: stubFetch(),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["signals"]["smart_money"]["netflow_30d_usd"]).toBeNull();
    expect(b["data_quality"]["windows_used"]).toEqual(["24h", "7d"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// preflightData threading — Jupiter fetched at most once end-to-end
// ─────────────────────────────────────────────────────────────────────

describe("preflight -> handler critical-data threading", () => {
  it("handler reuses the preflight's token-check work (tokens/v2 fetched once)", async () => {
    const counts: Record<string, number> = {};
    const fetchImpl = stubFetch({ counts });
    const db = stubDb(ACCUMULATING);

    const pf = await tokenEntryVerdictPreflight({
      body: mintBody(MEME),
      method: "POST",
      db,
      fetchImpl,
    });
    expect(pf.proceed).toBe(true);
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db,
      fetchImpl,
      preflightData: pf.proceed ? pf.data : undefined,
    });
    expect(res.status).toBe(200);
    expect(counts["jup_search"]).toBe(1);
    expect(counts["jup_quote"]).toBe(1);
  });

  it("without threading the handler recomputes (control: fetched twice)", async () => {
    const counts: Record<string, number> = {};
    const fetchImpl = stubFetch({ counts });
    const db = stubDb(ACCUMULATING);

    const pf = await tokenEntryVerdictPreflight({
      body: mintBody(MEME),
      method: "POST",
      db,
      fetchImpl,
    });
    expect(pf.proceed).toBe(true);
    const res = await tokenEntryVerdict({
      body: mintBody(MEME),
      method: "POST",
      db,
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(counts["jup_search"]).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Raw layer cap (<= 6KB) — progressive trim stages
// ─────────────────────────────────────────────────────────────────────

const flowWindow = (over: Partial<MintFlowWindowData> = {}): MintFlowWindowData => ({
  buy_usd: 0,
  sell_usd: 0,
  net_usd: 0,
  distinct_buyers: 0,
  distinct_sellers: 0,
  trade_legs: 0,
  ...over,
});

function buildArgs(tc: Record<string, unknown>, labelRowCount = 0) {
  const labelRow = (i: number) => ({
    wallet_address: `W${i}`,
    last_trade_at: null,
    legs: 1,
    is_contract: false,
    is_cex_deposit: false,
    is_market_maker: false,
    is_deployer: false,
    is_lp_actor: false,
    is_probable_bot: false,
    labeled: true,
  });
  return {
    mint: MEME,
    tokenCheckBody: tc,
    flow: {
      ok: true as const,
      data: { w24: flowWindow(), w7d: flowWindow() },
    },
    cache30: { ok: true as const, data: null },
    labels: {
      ok: true as const,
      data: Array.from({ length: labelRowCount }, (_, i) => labelRow(i)),
    },
    tape: {
      ok: true as const,
      data: {
        last_chain_trade_at: new Date().toISOString(),
        last_mint_trade_at: null,
        hours_since_last_chain_trade: 1,
        stale: false,
      },
    },
    computedAt: new Date(),
  };
}

const cleanTcVerdict = {
  risk_level: "low",
  flags: [],
  confidence: "high",
  summary: "clean",
};

const rawBytes = (b: Record<string, unknown>) =>
  Buffer.byteLength(JSON.stringify(b["raw"]), "utf8");

describe("raw layer cap", () => {
  it("stage 1: oversized token_check raw sub-layer is dropped first", () => {
    const b = buildEntryVerdictResponse(
      buildArgs({
        token: MEME,
        verdict: cleanTcVerdict,
        data_quality: {},
        signals: { small: true },
        raw: { blob: "x".repeat(8000) },
      }),
    );
    expect(rawBytes(b)).toBeLessThanOrEqual(RAW_CAP_BYTES);
    const raw = b["raw"] as Record<string, any>;
    expect(raw["token_check"]["raw"]).toBe("omitted_for_size");
    expect(raw["token_check"]["verdict"]).toEqual(cleanTcVerdict);
  });

  it("stage 2: oversized signals also stripped, label rows capped at 3", () => {
    const b = buildEntryVerdictResponse(
      buildArgs(
        {
          token: MEME,
          verdict: cleanTcVerdict,
          data_quality: {},
          signals: { blob: "y".repeat(8000) },
          raw: { blob: "x".repeat(8000) },
        },
        6,
      ),
    );
    expect(rawBytes(b)).toBeLessThanOrEqual(RAW_CAP_BYTES);
    const raw = b["raw"] as Record<string, any>;
    expect(raw["token_check"]["signals"]).toBe("omitted_for_size");
    expect(raw["token_check"]["verdict"]).toEqual(cleanTcVerdict);
    expect(raw["label_rows"]).toHaveLength(3);
  });

  it("stage 3: pathological verdict payload collapses to a truncation notice", () => {
    const b = buildEntryVerdictResponse(
      buildArgs({
        token: MEME,
        verdict: { ...cleanTcVerdict, blob: "z".repeat(8000) },
        data_quality: {},
        signals: {},
        raw: {},
      }),
    );
    expect(rawBytes(b)).toBeLessThanOrEqual(RAW_CAP_BYTES);
    expect((b["raw"] as Record<string, unknown>)["truncated"]).toBe(true);
    // The verdict layer itself is untouched by raw trimming.
    expect((b["verdict"] as Record<string, unknown>)["decision"]).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Response assembly honesty
// ─────────────────────────────────────────────────────────────────────

describe("buildEntryVerdictResponse", () => {
  it("all non-critical layers degraded -> CAUTION, low confidence, 4 stale sources", () => {
    const b = buildEntryVerdictResponse({
      mint: MEME,
      tokenCheckBody: { verdict: cleanTcVerdict },
      flow: { ok: false, error: "boom" },
      cache30: { ok: false, error: "boom" },
      labels: { ok: false, error: "boom" },
      tape: { ok: false, error: "boom" },
      computedAt: new Date(),
    });
    const v = b["verdict"] as Record<string, unknown>;
    expect(v["decision"]).toBe("CAUTION");
    expect(v["confidence"]).toBe("low");
    expect((b["data_quality"] as Record<string, any>)["stale_sources"]).toHaveLength(4);
    expect(
      (b["signals"] as Record<string, any>)["trader_context"]["ring_or_bot_dominated"],
    ).toBeNull();
  });

  it("garbled token-check verdict shape is treated as unreadable -> AVOID", () => {
    const b = buildEntryVerdictResponse(
      buildArgs({ verdict: { risk_level: "banana" } }),
    );
    const v = b["verdict"] as Record<string, unknown>;
    expect(v["decision"]).toBe("AVOID");
    expect(v["decisive_factors"]).toEqual(["safety_unreadable"]);
  });
});
