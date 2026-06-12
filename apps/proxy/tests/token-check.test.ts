import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bucketAge,
  bucketConcentration,
  bucketLiquidity,
  buildTokenCheckResponse,
  buildTokenSummary,
  classifyHolders,
  deriveAuthorityFlags,
  deriveEliteStatus,
  deriveMomentumLabel,
  deriveRiskLevel,
  deriveTokenCheckConfidence,
  tokenCheck,
  tokenCheckPreflight,
  tokenCheckValidator,
  type BuildTokenCheckArgs,
  type EliteCard,
  type JupTokenInfo,
} from "../src/handlers/token-check.js";
import type { DbQuerier } from "../src/handlers/types.js";

const NOW = new Date("2026-06-11T12:00:00.000Z");
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const MEME = "78B31QV1rtyoe2EYvVNjBVjeowyrtcH5FPTE4tCypump";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const PUMPSWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const ORIGINAL_HELIUS_KEY = process.env["HELIUS_API_KEY"];
beforeAll(() => {
  process.env["HELIUS_API_KEY"] = "test-key";
});
afterAll(() => {
  if (ORIGINAL_HELIUS_KEY === undefined) delete process.env["HELIUS_API_KEY"];
  else process.env["HELIUS_API_KEY"] = ORIGINAL_HELIUS_KEY;
});

// ─────────────────────────────────────────────────────────────────────
// Liquidity buckets — every boundary (research §4)
// ─────────────────────────────────────────────────────────────────────

describe("bucketLiquidity", () => {
  it("null impact (no route) is untradeable", () => {
    expect(bucketLiquidity(null)).toBe("untradeable");
  });
  it("0.044 (BONK measured) is deep", () => {
    expect(bucketLiquidity(0.044)).toBe("deep");
  });
  it("0.49 is deep, 0.5 is adequate (boundary)", () => {
    expect(bucketLiquidity(0.49)).toBe("deep");
    expect(bucketLiquidity(0.5)).toBe("adequate");
  });
  it("3 is adequate, 3.01 is thin (boundary)", () => {
    expect(bucketLiquidity(3)).toBe("adequate");
    expect(bucketLiquidity(3.01)).toBe("thin");
  });
  it("10 is thin, 10.01 is exit_trap (boundary)", () => {
    expect(bucketLiquidity(10)).toBe("thin");
    expect(bucketLiquidity(10.01)).toBe("exit_trap");
  });
  it("17.6 and 26.6 (measured thin tokens) are exit_trap", () => {
    expect(bucketLiquidity(17.6)).toBe("exit_trap");
    expect(bucketLiquidity(26.6)).toBe("exit_trap");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Concentration buckets — every boundary (research §2a)
// ─────────────────────────────────────────────────────────────────────

describe("bucketConcentration", () => {
  it("5.8 and 16.4 (measured wallet-held values) are distributed", () => {
    expect(bucketConcentration(5.8)).toBe("distributed");
    expect(bucketConcentration(16.4)).toBe("distributed");
  });
  it("19.99 distributed, 20 elevated (boundary)", () => {
    expect(bucketConcentration(19.99)).toBe("distributed");
    expect(bucketConcentration(20)).toBe("elevated");
  });
  it("40 elevated, 40.01 concentrated (boundary)", () => {
    expect(bucketConcentration(40)).toBe("elevated");
    expect(bucketConcentration(40.01)).toBe("concentrated");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Age buckets — every boundary
// ─────────────────────────────────────────────────────────────────────

describe("bucketAge", () => {
  const at = (hoursAgo: number) =>
    new Date(NOW.getTime() - hoursAgo * 3_600_000);
  it("47.9h is very_new, 48h is new (boundary)", () => {
    expect(bucketAge(at(47.9), NOW)).toBe("very_new");
    expect(bucketAge(at(48), NOW)).toBe("new");
  });
  it("13.9d is new, 14d is young (boundary)", () => {
    expect(bucketAge(at(13.9 * 24), NOW)).toBe("new");
    expect(bucketAge(at(14 * 24), NOW)).toBe("young");
  });
  it("89.9d is young, 90d is established (boundary)", () => {
    expect(bucketAge(at(89.9 * 24), NOW)).toBe("young");
    expect(bucketAge(at(90 * 24), NOW)).toBe("established");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Authority flags + momentum
// ─────────────────────────────────────────────────────────────────────

describe("deriveAuthorityFlags", () => {
  it("absent audit emits no flags", () => {
    expect(deriveAuthorityFlags(null)).toEqual([]);
  });
  it("disabled authorities and zero devMints emit no flags", () => {
    expect(
      deriveAuthorityFlags({
        mintAuthorityDisabled: true,
        freezeAuthorityDisabled: true,
        devMints: 0,
      }),
    ).toEqual([]);
  });
  it("live mint authority, live freeze authority, dev mints all flag", () => {
    expect(
      deriveAuthorityFlags({
        mintAuthorityDisabled: false,
        freezeAuthorityDisabled: false,
        devMints: 2,
      }),
    ).toEqual(["mint_authority_live", "freeze_authority_live", "dev_mints"]);
  });
  it("null fields (unknown) do not flag", () => {
    expect(
      deriveAuthorityFlags({
        mintAuthorityDisabled: null,
        freezeAuthorityDisabled: null,
        devMints: null,
      }),
    ).toEqual([]);
  });
});

describe("deriveMomentumLabel", () => {
  it("null when stats missing", () => {
    expect(deriveMomentumLabel(null)).toBeNull();
  });
  it("volatile beats rising at |25|", () => {
    expect(deriveMomentumLabel(25)).toBe("volatile");
    expect(deriveMomentumLabel(-25)).toBe("volatile");
  });
  it("rising at +5, falling at -5, flat between", () => {
    expect(deriveMomentumLabel(5)).toBe("rising");
    expect(deriveMomentumLabel(-5)).toBe("falling");
    expect(deriveMomentumLabel(4.9)).toBe("flat");
    expect(deriveMomentumLabel(-4.9)).toBe("flat");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pool-exclusion math (research §2a)
// ─────────────────────────────────────────────────────────────────────

describe("classifyHolders", () => {
  it("splits pool-held from wallet-held by owning program", () => {
    // Mirrors the measured Openverse shape: pumpswap pool holds 65.8%,
    // wallets hold the rest of the top set.
    const top = [
      { address: "PoolTokenAcct", amount: "658" },
      { address: "WalletAcct1", amount: "35" },
      { address: "WalletAcct2", amount: "28" },
    ];
    const owners = ["PoolAuthority", "Wallet1", "Wallet2"];
    const programs = [PUMPSWAP, SYSTEM_PROGRAM, SYSTEM_PROGRAM];
    const split = classifyHolders(top, owners, programs, 1000);
    expect(split.pool_held_top10_pct).toBe(65.8);
    expect(split.wallet_held_top10_pct).toBeCloseTo(6.3, 5);
    expect(split.holders.map((h) => h.kind)).toEqual([
      "pool",
      "wallet",
      "wallet",
    ]);
  });
  it("missing owner info classifies as pool (never inflates wallet-held)", () => {
    const split = classifyHolders(
      [{ address: "A", amount: "500" }],
      [null],
      [null],
      1000,
    );
    expect(split.wallet_held_top10_pct).toBe(0);
    expect(split.pool_held_top10_pct).toBe(50);
    expect(split.holders[0]!.kind).toBe("pool");
  });
  it("zero supply yields zero shares without dividing by zero", () => {
    const split = classifyHolders(
      [{ address: "A", amount: "10" }],
      ["O"],
      [SYSTEM_PROGRAM],
      0,
    );
    expect(split.wallet_held_top10_pct).toBe(0);
    expect(split.pool_held_top10_pct).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Elite freshness guard (research §1c)
// ─────────────────────────────────────────────────────────────────────

describe("deriveEliteStatus", () => {
  it("token-level data present -> active (full card) even if cohort silent", () => {
    expect(deriveEliteStatus(12, 120)).toBe("active");
    expect(deriveEliteStatus(12, 1)).toBe("active");
  });
  it("empty + fresh cohort -> no_elite_interest", () => {
    expect(deriveEliteStatus(0, 12)).toBe("no_elite_interest");
    expect(deriveEliteStatus(0, 48)).toBe("no_elite_interest");
  });
  it("empty + cohort silent >48h -> no_signal_cohort_silent", () => {
    expect(deriveEliteStatus(0, 48.1)).toBe("no_signal_cohort_silent");
    expect(deriveEliteStatus(0, 120)).toBe("no_signal_cohort_silent");
  });
  it("empty + no elite trade ever (null lag) -> no_signal_cohort_silent", () => {
    expect(deriveEliteStatus(0, null)).toBe("no_signal_cohort_silent");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Risk matrix
// ─────────────────────────────────────────────────────────────────────

describe("deriveRiskLevel", () => {
  const base = {
    liquidity: "deep" as const,
    concentration: "distributed" as const,
    age: "established" as const,
    flags: [] as never[],
  };
  it("clean deep/distributed/established token is low", () => {
    expect(deriveRiskLevel(base)).toBe("low");
  });
  it("untradeable is critical", () => {
    expect(deriveRiskLevel({ ...base, liquidity: "untradeable" })).toBe(
      "critical",
    );
  });
  it("exit_trap AND very_new is critical", () => {
    expect(
      deriveRiskLevel({ ...base, liquidity: "exit_trap", age: "very_new" }),
    ).toBe("critical");
  });
  it("mint_authority_live is critical regardless of axes", () => {
    expect(
      deriveRiskLevel({ ...base, flags: ["mint_authority_live"] }),
    ).toBe("critical");
  });
  it("unknown_token is critical", () => {
    expect(deriveRiskLevel({ ...base, flags: ["unknown_token"] })).toBe(
      "critical",
    );
  });
  it("exit_trap alone (not very_new) is high", () => {
    expect(deriveRiskLevel({ ...base, liquidity: "exit_trap" })).toBe("high");
  });
  it("concentrated alone is high", () => {
    expect(deriveRiskLevel({ ...base, concentration: "concentrated" })).toBe(
      "high",
    );
  });
  it("thin AND very_new is high", () => {
    expect(
      deriveRiskLevel({ ...base, liquidity: "thin", age: "very_new" }),
    ).toBe("high");
  });
  it("thin alone is moderate", () => {
    expect(deriveRiskLevel({ ...base, liquidity: "thin" })).toBe("moderate");
  });
  it("elevated alone is moderate", () => {
    expect(deriveRiskLevel({ ...base, concentration: "elevated" })).toBe(
      "moderate",
    );
  });
  it("new with freeze authority flag is moderate", () => {
    expect(
      deriveRiskLevel({
        ...base,
        age: "new",
        flags: ["freeze_authority_live"],
      }),
    ).toBe("moderate");
  });
  it("established with freeze authority flag alone stays low", () => {
    expect(
      deriveRiskLevel({ ...base, flags: ["freeze_authority_live"] }),
    ).toBe("low");
  });
  it("missing axes (nulls) do not escalate", () => {
    expect(
      deriveRiskLevel({
        liquidity: null,
        concentration: null,
        age: null,
        flags: [],
      }),
    ).toBe("low");
  });
});

describe("deriveTokenCheckConfidence", () => {
  it("0 degradations high, 1 medium, 2+ low", () => {
    expect(deriveTokenCheckConfidence(0)).toBe("high");
    expect(deriveTokenCheckConfidence(1)).toBe("medium");
    expect(deriveTokenCheckConfidence(2)).toBe("low");
    expect(deriveTokenCheckConfidence(3)).toBe("low");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────

function eliteCard(overrides: Partial<EliteCard> = {}): EliteCard {
  return {
    buy_usd: 3326.76,
    sell_usd: 3398.25,
    net_usd: -71.49,
    distinct_elite_wallets: 21,
    trade_legs: 111,
    first_elite_trade: "2026-06-03T13:28:27.000Z",
    last_elite_trade: "2026-06-06T11:49:02.000Z",
    hours_since_last_elite_trade: 120.2,
    ...overrides,
  };
}

describe("buildTokenSummary", () => {
  it("mentions the elite card when present", () => {
    const s = buildTokenSummary({
      symbol: "Openverse",
      riskLevel: "high",
      liquidity: "exit_trap",
      impactPct: 17.56,
      concentration: "distributed",
      walletHeldPct: 16.4,
      age: "new",
      flags: [],
      eliteStatus: "active",
      eliteCard: eliteCard(),
      staleSources: [],
    });
    expect(s).toContain("21 wallets");
    expect(s).toContain("net sellers");
    expect(s).toContain("5d ago");
    expect(s).toContain("exit trap");
  });
  it("cohort-silent emptiness is NOT phrased as elite avoiding the token", () => {
    const s = buildTokenSummary({
      symbol: "X",
      riskLevel: "low",
      liquidity: "deep",
      impactPct: 0.04,
      concentration: "distributed",
      walletHeldPct: 10,
      age: "established",
      flags: [],
      eliteStatus: "no_signal_cohort_silent",
      eliteCard: null,
      staleSources: [],
    });
    expect(s).toContain("silent cohort-wide");
    expect(s).toContain("carries no signal");
    expect(s).not.toContain("touched this token");
  });
  it("fresh-cohort emptiness reads as no elite interest", () => {
    const s = buildTokenSummary({
      symbol: "X",
      riskLevel: "low",
      liquidity: "deep",
      impactPct: 0.04,
      concentration: "distributed",
      walletHeldPct: 10,
      age: "established",
      flags: [],
      eliteStatus: "no_elite_interest",
      eliteCard: null,
      staleSources: [],
    });
    expect(s).toContain("None of our elite smart-money wallets touched");
  });
  it("metadata_mismatch surfaces an impersonation warning", () => {
    const s = buildTokenSummary({
      symbol: "FAKE",
      riskLevel: "moderate",
      liquidity: "thin",
      impactPct: 5,
      concentration: null,
      walletHeldPct: null,
      age: null,
      flags: ["metadata_mismatch"],
      eliteStatus: "no_elite_interest",
      eliteCard: null,
      staleSources: [],
    });
    expect(s).toContain("impersonation");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Validator — discovery probes pass to the 402 challenge; present-but-
// invalid input is 422 before any payment.
// ─────────────────────────────────────────────────────────────────────

describe("tokenCheckValidator", () => {
  it("empty body -> null (discovery — crawler gets the 402 challenge)", () => {
    expect(tokenCheckValidator(null, "POST")).toBeNull();
    expect(tokenCheckValidator(Buffer.from(""), "POST")).toBeNull();
  });
  it("missing / empty / placeholder token -> null (discovery)", () => {
    for (const body of [
      {},
      { token: "" },
      { token: "string" },
      { token: "<solana mint address>" },
      { token: "YOUR_TOKEN_MINT" },
      { token: 0 },
    ]) {
      expect(
        tokenCheckValidator(Buffer.from(JSON.stringify(body)), "POST"),
        `expected discovery pass-through for ${JSON.stringify(body)}`,
      ).toBeNull();
    }
  });
  it("invalid JSON -> 400", () => {
    const res = tokenCheckValidator(Buffer.from("{nope"), "POST");
    expect(res?.status).toBe(400);
  });
  it("JSON array body -> 422", () => {
    const res = tokenCheckValidator(Buffer.from("[1,2]"), "POST");
    expect(res?.status).toBe(422);
  });
  it("non-base58 token -> 422", () => {
    const res = tokenCheckValidator(
      Buffer.from(JSON.stringify({ token: "0xdeadbeef" })),
      "POST",
    );
    expect(res?.status).toBe(422);
    expect((res?.body as { error: string }).error).toBe("invalid_token_mint");
  });
  it("too-short base58 -> 422", () => {
    const res = tokenCheckValidator(
      Buffer.from(JSON.stringify({ token: "abcd" })),
      "POST",
    );
    expect(res?.status).toBe(422);
  });
  it("valid mint passes", () => {
    expect(
      tokenCheckValidator(Buffer.from(JSON.stringify({ token: BONK })), "POST"),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Stubs for handler/preflight integration tests
// ─────────────────────────────────────────────────────────────────────

interface StubOptions {
  cardRow?: Record<string, unknown>;
  feedRow?: Record<string, unknown>;
  dbThrows?: boolean;
  jupTokens?: JupTokenInfo[];
  jupTokenStatus?: number;
  quoteBody?: Record<string, unknown>;
  quoteStatus?: number;
  rpcOverloaded?: boolean;
}

const FRESH_FEED = { last_elite_trade_at: new Date(NOW.getTime() - 3_600_000) };
const EMPTY_CARD = {
  trade_legs: 0,
  distinct_elite_wallets: 0,
  buy_usd: 0,
  sell_usd: 0,
  first_elite_trade: null,
  last_elite_trade: null,
};

function stubDb(opts: StubOptions): DbQuerier {
  return {
    async query(text: string) {
      if (opts.dbThrows) throw new Error("connection refused");
      if (text.includes("MAX(t.timestamp) AS last_elite_trade_at")) {
        return { rows: [opts.feedRow ?? FRESH_FEED] };
      }
      return { rows: [opts.cardRow ?? EMPTY_CARD] };
    },
  };
}

function stubFetch(opts: StubOptions): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("tokens/v2/search")) {
      if (opts.jupTokenStatus && opts.jupTokenStatus !== 200) {
        return new Response("upstream down", { status: opts.jupTokenStatus });
      }
      return Response.json(opts.jupTokens ?? []);
    }
    if (u.includes("swap/v1/quote")) {
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
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
      };
      if (opts.rpcOverloaded) {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32603,
            message: "account index service overloaded, please try again.",
          },
        });
      }
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
      return Response.json({
        pairs: [
          { liquidity: { usd: 4497 }, pairCreatedAt: 1780500000000 },
        ],
      });
    }
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;
}

function jupToken(overrides: Partial<JupTokenInfo> = {}): JupTokenInfo {
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

const body = (token: string) => Buffer.from(JSON.stringify({ token }));

// ─────────────────────────────────────────────────────────────────────
// Preflight — fail-closed gate
// ─────────────────────────────────────────────────────────────────────

describe("tokenCheckPreflight", () => {
  it("DB down -> proceed:false 503 (buyer not charged)", async () => {
    const pf = await tokenCheckPreflight({
      body: body(MEME),
      method: "POST",
      db: stubDb({ dbThrows: true }),
      fetchImpl: stubFetch({}),
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) {
      expect(pf.status).toBe(503);
      expect((pf.body as { source: string }).source).toBe("smart_money_db");
    }
  });
  it("jupiter tokens/v2 down -> proceed:false 503", async () => {
    const pf = await tokenCheckPreflight({
      body: body(MEME),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({ jupTokenStatus: 502 }),
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) expect(pf.status).toBe(503);
  });
  it("quote 5xx -> proceed:false 503", async () => {
    const pf = await tokenCheckPreflight({
      body: body(MEME),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({ quoteStatus: 503 }),
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) expect(pf.status).toBe(503);
  });
  it("quote no-route (400 + errorCode) PROCEEDS — it is an answer", async () => {
    const pf = await tokenCheckPreflight({
      body: body(MEME),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({
        quoteStatus: 400,
        quoteBody: {
          error: "not tradable",
          errorCode: "TOKEN_NOT_TRADABLE",
        },
      }),
    });
    expect(pf.proceed).toBe(true);
  });
  it("no db wired -> proceed:false 503", async () => {
    const pf = await tokenCheckPreflight({
      body: body(MEME),
      method: "POST",
      fetchImpl: stubFetch({}),
    });
    expect(pf.proceed).toBe(false);
  });
  it("invalid mint -> 422, never proceeds", async () => {
    const pf = await tokenCheckPreflight({
      body: Buffer.from(JSON.stringify({ token: "not-base58!" })),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({}),
    });
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) expect(pf.status).toBe(422);
  });
  it("PAID discovery-class body (empty/placeholder) -> 422, never settles", async () => {
    // The validator passes these through so unpaid crawlers get the
    // 402 challenge; if someone actually pays with such a body, the
    // preflight keeps the no-settle guarantee.
    for (const raw of [null, "{}", JSON.stringify({ token: "string" })]) {
      const pf = await tokenCheckPreflight({
        body: raw === null ? null : Buffer.from(raw),
        method: "POST",
        db: stubDb({}),
        fetchImpl: stubFetch({}),
      });
      expect(pf.proceed, `expected no-proceed for ${raw}`).toBe(false);
      if (!pf.proceed) {
        expect(pf.status).toBe(422);
        expect((pf.body as { input_schema?: unknown }).input_schema).toBeDefined();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Full handler paths
// ─────────────────────────────────────────────────────────────────────

describe("tokenCheck handler", () => {
  it("happy path: full response with rpc concentration and pool exclusion", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({
        cardRow: {
          trade_legs: 111,
          distinct_elite_wallets: 21,
          buy_usd: 3326.76,
          sell_usd: 3398.25,
          first_elite_trade: new Date("2026-06-03T13:28:27Z"),
          last_elite_trade: new Date("2026-06-06T11:49:02Z"),
        },
      }),
      fetchImpl: stubFetch({ jupTokens: [jupToken()] }),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    // deep (0.04%) + distributed (16.4 wallet-held) + new age, no flags.
    expect(b["verdict"]["risk_level"]).toBe("low");
    expect(b["signals"]["concentration"]["source"]).toBe("rpc");
    // Pool 65.8% excluded; wallet-held = 16.4% of supply 1000.
    expect(b["signals"]["concentration"]["wallet_held_top10_pct"]).toBe(16.4);
    expect(b["signals"]["concentration"]["pool_held_top10_pct"]).toBe(65.8);
    expect(b["signals"]["elite_flow"]["status"]).toBe("active");
    expect(b["signals"]["elite_flow"]["card"]["distinct_elite_wallets"]).toBe(
      21,
    );
    expect(b["data_quality"]["stale_sources"]).toEqual([]);
    expect(b["verdict"]["confidence"]).toBe("high");
  });

  it("BONK-class degrade: rpc overloaded -> jupiter_audit fallback + medium confidence", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({
        jupTokens: [jupToken()],
        rpcOverloaded: true,
      }),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["signals"]["concentration"]["source"]).toBe("jupiter_audit");
    expect(b["signals"]["concentration"]["wallet_held_top10_pct"]).toBe(20.3);
    expect(b["signals"]["concentration"]["bucket"]).toBe("elevated");
    expect(b["data_quality"]["stale_sources"]).toContain("helius_rpc_holders");
    // rpcOverloaded also kills getAsset (same endpoint) -> 2 degradations.
    expect(b["verdict"]["confidence"]).toBe("low");
  });

  it("no-route quote -> untradeable + critical risk, still a 200 paid answer", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({
        jupTokens: [jupToken()],
        quoteStatus: 400,
        quoteBody: { error: "x", errorCode: "COULD_NOT_FIND_ANY_ROUTE" },
      }),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["signals"]["liquidity"]["bucket"]).toBe("untradeable");
    expect(b["signals"]["liquidity"]["no_route"]).toBe(true);
    expect(b["verdict"]["risk_level"]).toBe("critical");
    expect(b["verdict"]["flags"]).toContain("untradeable");
  });

  it("unknown mint (jup empty + zero trades) -> critical + unknown_token", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({
        jupTokens: [],
        quoteStatus: 400,
        quoteBody: { error: "x", errorCode: "TOKEN_NOT_TRADABLE" },
      }),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["risk_level"]).toBe("critical");
    expect(b["verdict"]["flags"]).toContain("unknown_token");
  });

  it("cohort-silent feed -> elite axis no_signal_cohort_silent with lag hours", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({
        feedRow: {
          last_elite_trade_at: new Date(Date.now() - 5 * 86_400_000),
        },
      }),
      fetchImpl: stubFetch({ jupTokens: [jupToken()] }),
    });
    expect(res.status).toBe(200);
    const b = res.body as Record<string, any>;
    expect(b["signals"]["elite_flow"]["status"]).toBe(
      "no_signal_cohort_silent",
    );
    expect(
      b["signals"]["elite_flow"]["elite_feed_lag_hours"],
    ).toBeGreaterThan(48);
    expect(b["verdict"]["summary"]).toContain("carries no signal");
  });

  it("fresh cohort + zero token trades -> no_elite_interest", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({ jupTokens: [jupToken()] }),
    });
    const b = res.body as Record<string, any>;
    expect(b["signals"]["elite_flow"]["status"]).toBe("no_elite_interest");
    expect(b["signals"]["elite_flow"]["card"]).toBeNull();
  });

  it("metadata mismatch between getAsset and jupiter flags impersonation", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({
        jupTokens: [jupToken({ symbol: "TOTALLYREAL" })],
      }),
    });
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["flags"]).toContain("metadata_mismatch");
    expect(b["verdict"]["summary"]).toContain("impersonation");
  });

  it("invalid input -> 422 straight from the handler (never settles)", async () => {
    const res = await tokenCheck({
      body: Buffer.from(JSON.stringify({ token: "l0l" })),
      method: "POST",
      db: stubDb({}),
      fetchImpl: stubFetch({}),
    });
    expect(res.status).toBe(422);
  });

  it("elite axis never changes risk_level (active heavy-sell card stays low)", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({
        cardRow: {
          trade_legs: 639,
          distinct_elite_wallets: 28,
          buy_usd: 15290.35,
          sell_usd: 18869.17,
          first_elite_trade: new Date("2026-06-03T20:26:16Z"),
          last_elite_trade: new Date("2026-06-03T22:46:45Z"),
        },
      }),
      fetchImpl: stubFetch({
        jupTokens: [
          jupToken({
            firstPool: { id: MEME, createdAt: "2024-01-01T00:00:00Z" },
          }),
        ],
      }),
    });
    const b = res.body as Record<string, any>;
    expect(b["signals"]["elite_flow"]["status"]).toBe("active");
    // deep liquidity + distributed (16.4 wallet-held) + established age:
    // the heavy elite net-sell must NOT escalate the risk level.
    expect(b["verdict"]["risk_level"]).toBe("low");
    expect(b["verdict"]["summary"]).toContain("net sellers");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Response assembly edge: quote raw arrays capped
// ─────────────────────────────────────────────────────────────────────

describe("buildTokenCheckResponse raw caps", () => {
  it("caps routePlan and holder arrays at 20", () => {
    const longRoute = Array.from({ length: 50 }, (_, i) => ({ hop: i }));
    const args: BuildTokenCheckArgs = {
      mint: MEME,
      elite: {
        card: {
          buy_usd: 0,
          sell_usd: 0,
          net_usd: 0,
          distinct_elite_wallets: 0,
          trade_legs: 0,
          first_elite_trade: null,
          last_elite_trade: null,
          hours_since_last_elite_trade: null,
        },
        elite_feed_lag_hours: 1,
        status: "no_elite_interest",
      },
      jupToken: { ok: true, data: jupToken(), raw: [] },
      quote: {
        ok: true,
        data: { price_impact_pct: 0.04, no_route: false, error_code: null },
        raw: { priceImpactPct: "0.0004", routePlan: longRoute },
      },
      holders: {
        ok: false,
        degraded: true,
        error: "helius_unreachable",
      },
      asset: { ok: false, error: "get_asset_unreachable" },
      dex: { ok: false, error: "dexscreener_unreachable" },
      computedAt: NOW,
    };
    const b = buildTokenCheckResponse(args) as Record<string, any>;
    expect(b["raw"]["jupiter_quote"]["routePlan"]).toHaveLength(20);
    expect(b["data_quality"]["stale_sources"]).toHaveLength(3);
    expect(b["verdict"]["confidence"]).toBe("low");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Cluster-collapsed elite counts (tracker coordinated-timing labels)
// ─────────────────────────────────────────────────────────────────────

describe("cluster-collapsed elite counts", () => {
  it("summary leads with independent actors when clusters collapse the wallet count", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({
        cardRow: {
          trade_legs: 120,
          distinct_elite_wallets: 21,
          distinct_elite_clusters: 9,
          buy_usd: 3326.76,
          sell_usd: 3398.25,
          first_elite_trade: new Date("2026-06-03T13:28:27Z"),
          last_elite_trade: new Date("2026-06-06T11:49:02Z"),
        },
      }),
      fetchImpl: stubFetch({ jupTokens: [jupToken()] }),
    });
    const b = res.body as Record<string, any>;
    expect(b["signals"]["elite_flow"]["card"]["distinct_elite_wallets"]).toBe(21);
    expect(b["signals"]["elite_flow"]["card"]["distinct_elite_clusters"]).toBe(9);
    expect(b["verdict"]["summary"]).toContain("9 independent actors");
    expect(b["verdict"]["summary"]).toContain("21 wallets, some operator-clustered");
  });

  it("equal counts keep the plain wallet phrasing", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({
        cardRow: {
          trade_legs: 10,
          distinct_elite_wallets: 4,
          distinct_elite_clusters: 4,
          buy_usd: 100,
          sell_usd: 50,
          first_elite_trade: new Date("2026-06-03T13:28:27Z"),
          last_elite_trade: new Date("2026-06-06T11:49:02Z"),
        },
      }),
      fetchImpl: stubFetch({ jupTokens: [jupToken()] }),
    });
    const b = res.body as Record<string, any>;
    expect(b["verdict"]["summary"]).toContain("4 wallets");
    expect(b["verdict"]["summary"]).not.toContain("independent actor");
  });

  it("missing cluster info falls back to wallet count (never inflates the correction)", async () => {
    const res = await tokenCheck({
      body: body(MEME),
      method: "POST",
      db: stubDb({
        cardRow: {
          trade_legs: 10,
          distinct_elite_wallets: 5,
          buy_usd: 100,
          sell_usd: 50,
          first_elite_trade: new Date("2026-06-03T13:28:27Z"),
          last_elite_trade: new Date("2026-06-06T11:49:02Z"),
        },
      }),
      fetchImpl: stubFetch({ jupTokens: [jupToken()] }),
    });
    const b = res.body as Record<string, any>;
    expect(b["signals"]["elite_flow"]["card"]["distinct_elite_clusters"]).toBe(5);
  });
});
