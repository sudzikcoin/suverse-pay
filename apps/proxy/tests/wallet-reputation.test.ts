import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildReputationResponse,
  buildWalletSummary,
  classifyTrade,
  deriveActivity,
  deriveStyleFlags,
  deriveTier,
  deriveWalletConfidence,
  isEligible,
  walletReputation,
  walletReputationPreflight,
  walletReputationValidator,
  type ScoringRow,
  type TradeAggregates,
} from "../src/handlers/wallet-reputation.js";
import type { DbQuerier } from "../src/handlers/types.js";

const NOW = new Date("2026-06-10T12:00:00.000Z");
const ELITE_WALLET = "CBjwziSG9Z48MSAfqXNuKHyQ3JqrC963pNeivoUSAV5b";

const ORIGINAL_HELIUS_KEY = process.env["HELIUS_API_KEY"];
beforeAll(() => {
  process.env["HELIUS_API_KEY"] = "test-key";
});
afterAll(() => {
  if (ORIGINAL_HELIUS_KEY === undefined) delete process.env["HELIUS_API_KEY"];
  else process.env["HELIUS_API_KEY"] = ORIGINAL_HELIUS_KEY;
});

function scoringRow(overrides: Partial<ScoringRow> = {}): ScoringRow {
  return {
    address: ELITE_WALLET,
    status: "candidate",
    score: 80,
    confidence_score: 90,
    score_version: "v1",
    last_scored_at: new Date(NOW.getTime() - 2 * 86_400_000),
    ...overrides,
  };
}

function aggregates(overrides: Partial<TradeAggregates> = {}): TradeAggregates {
  return {
    trade_count_24h: 1,
    trade_count_7d: 5,
    trade_count_30d: 12,
    trade_count_total: 40,
    volume_usd_30d: 5400.5,
    distinct_tokens_30d: 6,
    avg_trade_size_usd: 450.04,
    first_seen: new Date("2026-01-15T00:00:00Z"),
    last_trade_at: new Date(NOW.getTime() - 3 * 86_400_000),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Tier ladder — boundary semantics
// ─────────────────────────────────────────────────────────────────────

describe("deriveTier", () => {
  it("returns unknown for an untracked wallet (null row)", () => {
    expect(deriveTier(null)).toBe("unknown");
  });

  it("returns unknown for a tracked but never-scored wallet", () => {
    expect(deriveTier(scoringRow({ score: null, confidence_score: null }))).toBe(
      "unknown",
    );
  });

  it("eligible wallet is elite even with a mid score", () => {
    const row = scoringRow({ score: 62, confidence_score: 55 });
    expect(isEligible(row)).toBe(true);
    expect(deriveTier(row)).toBe("elite");
  });

  it("score exactly 70 without eligibility is skilled", () => {
    expect(deriveTier(scoringRow({ score: 70, confidence_score: 10 }))).toBe(
      "skilled",
    );
  });

  it("score 69.99 without eligibility is average", () => {
    expect(deriveTier(scoringRow({ score: 69.99, confidence_score: 10 }))).toBe(
      "average",
    );
    expect(deriveTier(scoringRow({ score: 59.99, confidence_score: 10 }))).toBe(
      "average",
    );
  });

  it("score exactly 40 is average", () => {
    expect(deriveTier(scoringRow({ score: 40, confidence_score: 10 }))).toBe(
      "average",
    );
  });

  it("score 39.99 is weak", () => {
    expect(deriveTier(scoringRow({ score: 39.99, confidence_score: 10 }))).toBe(
      "weak",
    );
  });

  it("quarantined wallet with a top score is skilled, never elite", () => {
    const row = scoringRow({ score: 95, confidence_score: 95, status: "quarantined" });
    expect(isEligible(row)).toBe(false);
    expect(deriveTier(row)).toBe("skilled");
  });

  it("blacklisted wallet cannot be elite", () => {
    const row = scoringRow({ status: "blacklisted" });
    expect(deriveTier(row)).toBe("skilled");
  });

  it("high score with sub-50 confidence is skilled, not elite", () => {
    expect(deriveTier(scoringRow({ score: 88, confidence_score: 49 }))).toBe(
      "skilled",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Activity classification
// ─────────────────────────────────────────────────────────────────────

describe("deriveActivity", () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it("traded 3 days ago → active", () => {
    expect(deriveActivity(days(3), NOW)).toBe("active");
  });

  it("traded exactly 7 days ago → active (inclusive)", () => {
    expect(deriveActivity(days(7), NOW)).toBe("active");
  });

  it("traded 10 days ago → occasional", () => {
    expect(deriveActivity(days(10), NOW)).toBe("occasional");
  });

  it("traded exactly 30 days ago → dormant (inclusive)", () => {
    expect(deriveActivity(days(30), NOW)).toBe("dormant");
  });

  it("traded 90 days ago → dormant", () => {
    expect(deriveActivity(days(90), NOW)).toBe("dormant");
  });

  it("never traded → dormant", () => {
    expect(deriveActivity(null, NOW)).toBe("dormant");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Style flags
// ─────────────────────────────────────────────────────────────────────

describe("deriveStyleFlags", () => {
  it("high_frequency at exactly 20 trades/7d, not at 19", () => {
    expect(deriveStyleFlags(aggregates({ trade_count_7d: 20 }))).toContain(
      "high_frequency",
    );
    expect(deriveStyleFlags(aggregates({ trade_count_7d: 19 }))).not.toContain(
      "high_frequency",
    );
  });

  it("large_size at avg >= $1000, not below, never with zero 30d trades", () => {
    expect(
      deriveStyleFlags(aggregates({ avg_trade_size_usd: 1000 })),
    ).toContain("large_size");
    expect(
      deriveStyleFlags(aggregates({ avg_trade_size_usd: 999.99 })),
    ).not.toContain("large_size");
    expect(
      deriveStyleFlags(
        aggregates({ avg_trade_size_usd: 5000, trade_count_30d: 0 }),
      ),
    ).not.toContain("large_size");
  });

  it("diversified at >= 10 distinct tokens 30d", () => {
    expect(
      deriveStyleFlags(aggregates({ distinct_tokens_30d: 10 })),
    ).toContain("diversified");
    expect(
      deriveStyleFlags(aggregates({ distinct_tokens_30d: 9 })),
    ).not.toContain("diversified");
  });

  it("concentrated needs <= 2 tokens AND >= 5 trades in 30d", () => {
    expect(
      deriveStyleFlags(
        aggregates({ distinct_tokens_30d: 2, trade_count_30d: 5 }),
      ),
    ).toContain("concentrated");
    expect(
      deriveStyleFlags(
        aggregates({ distinct_tokens_30d: 2, trade_count_30d: 4 }),
      ),
    ).not.toContain("concentrated");
    expect(
      deriveStyleFlags(
        aggregates({ distinct_tokens_30d: 3, trade_count_30d: 50 }),
      ),
    ).not.toContain("concentrated");
  });

  it("no concentrated flag when the wallet touched zero volatile tokens", () => {
    expect(
      deriveStyleFlags(
        aggregates({ distinct_tokens_30d: 0, trade_count_30d: 9 }),
      ),
    ).not.toContain("concentrated");
  });

  it("diversified and concentrated are mutually exclusive by construction", () => {
    const flags = deriveStyleFlags(
      aggregates({ distinct_tokens_30d: 12, trade_count_30d: 30, trade_count_7d: 25, avg_trade_size_usd: 2500 }),
    );
    expect(flags).toEqual(["high_frequency", "large_size", "diversified"]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Confidence
// ─────────────────────────────────────────────────────────────────────

describe("deriveWalletConfidence", () => {
  it("tracked + scored 2 days ago + helius ok → high", () => {
    expect(deriveWalletConfidence(scoringRow(), NOW, true)).toBe("high");
  });

  it("tracked but score 10 days old → medium", () => {
    const row = scoringRow({
      last_scored_at: new Date(NOW.getTime() - 10 * 86_400_000),
    });
    expect(deriveWalletConfidence(row, NOW, true)).toBe("medium");
  });

  it("tracked but never scored → medium", () => {
    expect(
      deriveWalletConfidence(scoringRow({ last_scored_at: null }), NOW, true),
    ).toBe("medium");
  });

  it("untracked → low", () => {
    expect(deriveWalletConfidence(null, NOW, true)).toBe("low");
  });

  it("helius failure degrades one level: high→medium, medium→low, low→low", () => {
    expect(deriveWalletConfidence(scoringRow(), NOW, false)).toBe("medium");
    expect(
      deriveWalletConfidence(scoringRow({ last_scored_at: null }), NOW, false),
    ).toBe("low");
    expect(deriveWalletConfidence(null, NOW, false)).toBe("low");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Recent-trade classification
// ─────────────────────────────────────────────────────────────────────

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

describe("classifyTrade", () => {
  const base = {
    timestamp: NOW,
    value_usd: 123.456,
    symbol_in: null,
    symbol_out: null,
  };

  it("stable in / volatile out is a buy of the volatile leg", () => {
    const t = classifyTrade({
      ...base,
      tx_type: "swap",
      token_in: USDC,
      token_out: BONK,
      symbol_out: "BONK",
    });
    expect(t.side).toBe("buy");
    expect(t.token).toBe("BONK");
    expect(t.usd).toBe(123.46);
  });

  it("volatile in / stable out is a sell", () => {
    const t = classifyTrade({
      ...base,
      tx_type: "swap",
      token_in: BONK,
      token_out: WSOL,
      symbol_in: "BONK",
    });
    expect(t.side).toBe("sell");
    expect(t.token).toBe("BONK");
  });

  it("non-swap keeps its tx_type as side", () => {
    const t = classifyTrade({
      ...base,
      tx_type: "transfer",
      token_in: null,
      token_out: BONK,
    });
    expect(t.side).toBe("transfer");
    expect(t.token).toBe(BONK); // falls back to mint when no symbol
  });
});

// ─────────────────────────────────────────────────────────────────────
// Pre-payment validator — discovery probes pass through to the 402
// challenge; PRESENT-but-invalid input is 422 and must never settle.
// ─────────────────────────────────────────────────────────────────────

describe("walletReputationValidator", () => {
  const validate = (body: string | null) =>
    walletReputationValidator(body === null ? null : Buffer.from(body), "POST");

  it("accepts a valid base58 wallet", () => {
    expect(validate(JSON.stringify({ wallet: ELITE_WALLET }))).toBeNull();
  });

  it("passes an empty body through to the 402 challenge (discovery)", () => {
    expect(validate(null)).toBeNull();
    expect(validate("")).toBeNull();
  });

  it("passes a missing / non-string / empty wallet through (discovery)", () => {
    expect(validate("{}")).toBeNull();
    expect(validate(JSON.stringify({ wallet: 42 }))).toBeNull();
    expect(validate(JSON.stringify({ wallet: "" }))).toBeNull();
    expect(validate("null")).toBeNull();
  });

  it("passes known schema placeholders through (discovery)", () => {
    for (const placeholder of [
      "string",
      "<solana base58 address>",
      "YOUR_WALLET",
      "your-wallet-here",
      "{wallet}",
      "${WALLET}",
      "example",
      "xxxxxxxx",
      "YourWalletAddressHere1234567890123456", // accidentally valid base58
    ]) {
      expect(
        validate(JSON.stringify({ wallet: placeholder })),
        `expected discovery pass-through for ${placeholder}`,
      ).toBeNull();
    }
  });

  it("rejects invalid JSON with 400", () => {
    expect(validate("{nope")?.status).toBe(400);
  });

  it("rejects a JSON array body with 422", () => {
    expect(validate("[1,2]")?.status).toBe(422);
  });

  it("rejects present non-base58 garbage with 422", () => {
    for (const bad of [
      "hello",
      "0x260fbe1ec46968ee02e5b972507d7bb7f09f82b0", // EVM address: 0 and x illegal
      "O0Il" + "a".repeat(30), // 0, O, I, l are not base58
      "CBjwziSG9Z48MSAfqXNuKHyQ3JqrC963pNeivoUSAV5b!!",
      "abcd", // too short, but a real attempt — not a placeholder
      "1".repeat(45), // too long
    ]) {
      const res = validate(JSON.stringify({ wallet: bad }));
      expect(res?.status, `expected 422 for ${bad}`).toBe(422);
      expect((res?.body as { error: string }).error).toMatch(
        /invalid_wallet_address|wallet_required/,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// DB + fetch stubs for handler / preflight integration
// ─────────────────────────────────────────────────────────────────────

interface DbStubOpts {
  scoringRows?: Array<Record<string, unknown>>;
  aggRow?: Record<string, unknown>;
  distinctTokens?: number;
  recentRows?: Array<Record<string, unknown>>;
  throwOnScoring?: boolean;
  throwOnTrades?: boolean;
}

function makeDbStub(opts: DbStubOpts = {}): DbQuerier {
  return {
    query: async (sql: string) => {
      if (sql.includes("FROM sm_wallets")) {
        if (opts.throwOnScoring) throw new Error("connection refused");
        return { rows: opts.scoringRows ?? [] };
      }
      if (opts.throwOnTrades) throw new Error("connection refused");
      if (sql.includes("trade_count_24h")) {
        return {
          rows: [
            opts.aggRow ?? {
              trade_count_24h: 2,
              trade_count_7d: 6,
              trade_count_30d: 15,
              trade_count_total: 60,
              volume_usd_30d: 9000,
              avg_trade_size_usd: 600,
              first_seen: new Date("2026-02-01T00:00:00Z"),
              last_trade_at: new Date(Date.now() - 2 * 86_400_000),
            },
          ],
        };
      }
      if (sql.includes("distinct_tokens_30d FROM")) {
        return { rows: [{ distinct_tokens_30d: opts.distinctTokens ?? 4 }] };
      }
      if (sql.includes("ORDER BY t.timestamp")) {
        return {
          rows:
            opts.recentRows ?? [
              {
                timestamp: new Date(Date.now() - 2 * 86_400_000),
                tx_type: "swap",
                token_in: USDC,
                token_out: BONK,
                value_usd: 250.5,
                symbol_in: "USDC",
                symbol_out: "BONK",
              },
            ],
        };
      }
      throw new Error(`unexpected sql in test: ${sql.slice(0, 60)}`);
    },
  };
}

const HELIUS_TXS = [
  { signature: "sig1", type: "SWAP", timestamp: 1781300000 },
  { signature: "sig2", type: "TRANSFER", timestamp: 1781200000 },
  { signature: "sig3", type: "SWAP", timestamp: 1781100000 },
  { signature: "sig4", type: "SWAP", timestamp: 1781000000 },
];

function makeFetchStub(
  helius: "ok" | "http500" | "down" = "ok",
): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    if (u.includes("api.helius.xyz")) {
      if (helius === "down") throw new Error("ECONNREFUSED");
      if (helius === "http500") return new Response("oops", { status: 500 });
      return new Response(JSON.stringify(HELIUS_TXS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected url in test: ${u}`);
  }) as typeof fetch;
}

function input(
  wallet: string | Record<string, unknown>,
  db: DbQuerier | undefined,
  fetchImpl: typeof fetch,
  preflightData?: unknown,
) {
  return {
    body: Buffer.from(
      JSON.stringify(typeof wallet === "string" ? { wallet } : wallet),
    ),
    method: "POST",
    fetchImpl,
    ...(db ? { db } : {}),
    ...(preflightData !== undefined ? { preflightData } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Fail-closed preflight
// ─────────────────────────────────────────────────────────────────────

describe("walletReputationPreflight (fail-closed)", () => {
  it("proceeds with threaded data when both tables answer", async () => {
    const pf = await walletReputationPreflight(
      input(
        ELITE_WALLET,
        makeDbStub({ scoringRows: [{ address: ELITE_WALLET, status: "candidate", score: "85.5", confidence_score: 90, score_version: "v1", last_scored_at: new Date() }] }),
        makeFetchStub(),
      ),
    );
    expect(pf.proceed).toBe(true);
    if (pf.proceed) {
      expect((pf.data as { kind: string }).kind).toBe(
        "wallet_reputation_critical",
      );
    }
  });

  it("returns 503 and does NOT proceed when sm_wallets is down", async () => {
    const pf = await walletReputationPreflight(
      input(ELITE_WALLET, makeDbStub({ throwOnScoring: true }), makeFetchStub()),
    );
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) {
      expect(pf.status).toBe(503);
      expect((pf.body as { source: string }).source).toBe("sm_wallets");
    }
  });

  it("returns 503 and does NOT proceed when sm_trades is down", async () => {
    const pf = await walletReputationPreflight(
      input(ELITE_WALLET, makeDbStub({ throwOnTrades: true }), makeFetchStub()),
    );
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) {
      expect(pf.status).toBe(503);
      expect((pf.body as { source: string }).source).toBe("sm_trades");
    }
  });

  it("returns 503 when no db is wired", async () => {
    const pf = await walletReputationPreflight(
      input(ELITE_WALLET, undefined, makeFetchStub()),
    );
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) expect(pf.status).toBe(503);
  });

  it("rejects an invalid wallet with 422 instead of touching the db", async () => {
    const pf = await walletReputationPreflight(
      input("not-base58!", makeDbStub({ throwOnScoring: true }), makeFetchStub()),
    );
    expect(pf.proceed).toBe(false);
    if (!pf.proceed) expect(pf.status).toBe(422);
  });

  it("blocks a PAID discovery-class body (empty/placeholder) with 422 — never settles", async () => {
    // The validator passes these through so unpaid crawlers get the
    // 402 challenge; if someone actually pays with such a body, the
    // preflight is the gate that keeps the no-settle guarantee.
    for (const body of [null, {}, { wallet: "string" }, { wallet: "" }]) {
      const pf = await walletReputationPreflight({
        body: body === null ? null : Buffer.from(JSON.stringify(body)),
        method: "POST",
        db: makeDbStub({ throwOnScoring: true }),
        fetchImpl: makeFetchStub(),
      });
      expect(pf.proceed, `expected no-proceed for ${JSON.stringify(body)}`).toBe(
        false,
      );
      if (!pf.proceed) {
        expect(pf.status).toBe(422);
        // The rejection teaches the schema so the agent can self-correct.
        expect((pf.body as { input_schema?: unknown }).input_schema).toBeDefined();
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Handler — full paths
// ─────────────────────────────────────────────────────────────────────

describe("walletReputation handler", () => {
  it("tracked + fresh score + helius ok → elite verdict, high confidence", async () => {
    const db = makeDbStub({
      scoringRows: [
        {
          address: ELITE_WALLET,
          status: "candidate",
          score: "92.81",
          confidence_score: 95,
          score_version: "v1",
          last_scored_at: new Date(Date.now() - 3 * 86_400_000),
        },
      ],
    });
    const res = await walletReputation(input(ELITE_WALLET, db, makeFetchStub()));
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.verdict.tier).toBe("elite");
    expect(body.verdict.score).toBe(92.81);
    expect(body.verdict.activity).toBe("active");
    expect(body.verdict.confidence).toBe("high");
    expect(body.signals.scoring.eligible).toBe(true);
    expect(body.signals.trading.trade_count_30d).toBe(15);
    expect(body.signals.recent_activity[0].side).toBe("buy");
    expect(body.signals.recent_activity[0].token).toBe("BONK");
    expect(body.data_quality.tracking_coverage).toBe("tracked");
    expect(body.data_quality.stale_sources).toEqual([]);
    expect(body.raw.helius_sample).toHaveLength(3); // capped sample
    expect(typeof body.verdict.summary).toBe("string");
    expect(body.verdict.summary.length).toBeGreaterThan(40);
  });

  it("unknown wallet with zero trades is a valid 200 'no signal' answer", async () => {
    const db = makeDbStub({
      scoringRows: [],
      aggRow: {
        trade_count_24h: 0,
        trade_count_7d: 0,
        trade_count_30d: 0,
        trade_count_total: 0,
        volume_usd_30d: 0,
        avg_trade_size_usd: null,
        first_seen: null,
        last_trade_at: null,
      },
      distinctTokens: 0,
      recentRows: [],
    });
    const res = await walletReputation(input(ELITE_WALLET, db, makeFetchStub()));
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.verdict.tier).toBe("unknown");
    expect(body.verdict.score).toBeNull();
    expect(body.verdict.activity).toBe("dormant");
    expect(body.verdict.confidence).toBe("low");
    expect(body.signals.scoring).toBeNull();
    expect(body.signals.trading.trade_count_30d).toBe(0);
    expect(body.signals.style).toEqual([]);
    expect(body.signals.recent_activity).toEqual([]);
    expect(body.data_quality.tracking_coverage).toBe("untracked");
    expect(body.verdict.summary).toContain("no recorded trades");
  });

  it("untracked wallet WITH trades still returns the trade stats", async () => {
    const db = makeDbStub({ scoringRows: [] });
    const res = await walletReputation(input(ELITE_WALLET, db, makeFetchStub()));
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.verdict.tier).toBe("unknown");
    expect(body.signals.trading.trade_count_30d).toBe(15);
    expect(body.data_quality.tracking_coverage).toBe("untracked");
  });

  it("degraded helius: 200, stale_sources set, confidence drops high→medium", async () => {
    const db = makeDbStub({
      scoringRows: [
        {
          address: ELITE_WALLET,
          status: "candidate",
          score: "92.81",
          confidence_score: 95,
          score_version: "v1",
          last_scored_at: new Date(Date.now() - 3 * 86_400_000),
        },
      ],
    });
    for (const mode of ["http500", "down"] as const) {
      const res = await walletReputation(
        input(ELITE_WALLET, db, makeFetchStub(mode)),
      );
      expect(res.status).toBe(200);
      const body = res.body as Record<string, any>;
      expect(body.data_quality.stale_sources).toEqual([
        "helius_enhanced_transactions",
      ]);
      expect(body.verdict.confidence).toBe("medium");
      expect(body.raw.helius_sample).toBeNull();
      expect(body.verdict.summary).toContain("confidence is reduced");
    }
  });

  it("returns 503 (not 200) when the db dies and no preflight data exists", async () => {
    const res = await walletReputation(
      input(ELITE_WALLET, makeDbStub({ throwOnScoring: true }), makeFetchStub()),
    );
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe(
      "critical_source_unavailable",
    );
  });

  it("rejects invalid input before doing any work", async () => {
    const res = await walletReputation(
      input({ wallet: "garbage!!" }, makeDbStub({ throwOnScoring: true }), makeFetchStub()),
    );
    expect(res.status).toBe(422);
  });

  it("consumes preflightData without re-querying the db", async () => {
    let queries = 0;
    const countingDb: DbQuerier = {
      query: async () => {
        queries += 1;
        throw new Error("should not be called");
      },
    };
    const pf = await walletReputationPreflight(
      input(
        ELITE_WALLET,
        makeDbStub({
          scoringRows: [
            {
              address: ELITE_WALLET,
              status: "candidate",
              score: "75",
              confidence_score: 80,
              score_version: "v1",
              last_scored_at: new Date(),
            },
          ],
        }),
        makeFetchStub(),
      ),
    );
    expect(pf.proceed).toBe(true);
    const res = await walletReputation(
      input(ELITE_WALLET, countingDb, makeFetchStub(), (pf as { data?: unknown }).data),
    );
    expect(res.status).toBe(200);
    expect(queries).toBe(0);
    expect((res.body as Record<string, any>).verdict.tier).toBe("elite");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Summary text
// ─────────────────────────────────────────────────────────────────────

describe("buildWalletSummary", () => {
  it("mentions score, tier phrase, activity and flags", () => {
    const s = buildWalletSummary({
      tier: "elite",
      score: 92.81,
      activity: "active",
      agg: aggregates(),
      flags: ["diversified"],
      staleSources: [],
    });
    expect(s).toContain("92.81/100");
    expect(s).toContain("elite tier");
    expect(s).toContain("active");
    expect(s).toContain("diversified");
  });

  it("unknown + zero trades reads as an honest no-signal answer", () => {
    const s = buildWalletSummary({
      tier: "unknown",
      score: null,
      activity: "dormant",
      agg: aggregates({
        trade_count_total: 0,
        trade_count_30d: 0,
        volume_usd_30d: 0,
        last_trade_at: null,
      }),
      flags: [],
      staleSources: [],
    });
    expect(s).toContain("no skill signal");
    expect(s).toContain("no recorded trades");
  });
});

// ─────────────────────────────────────────────────────────────────────
// possible_operator_cluster flag (tracker coordinated-timing labels)
// ─────────────────────────────────────────────────────────────────────

describe("operator-cluster flag", () => {
  it("clustered wallet surfaces the flag + size in signals, tier unchanged", () => {
    const row = scoringRow({ score: 80, confidence_score: 90 });
    const body = buildReputationResponse({
      wallet: ELITE_WALLET,
      scoring: row,
      cluster: { cluster_id: "5e0bdf4e-3f3f-4a8e-9f5a-9f8f8f8f8f8f", size: 6 },
      aggregates: aggregates(),
      recentTrades: [],
      helius: { ok: true, transactions: [] },
      computedAt: NOW,
    }) as Record<string, any>;
    expect(body["signals"]["cluster"]).toEqual({
      flag: "possible_operator_cluster",
      cluster_id: "5e0bdf4e-3f3f-4a8e-9f5a-9f8f8f8f8f8f",
      cluster_size: 6,
    });
    expect(body["verdict"]["tier"]).toBe("elite"); // label, not exclusion
  });

  it("unclustered wallet reports signals.cluster = null", () => {
    const body = buildReputationResponse({
      wallet: ELITE_WALLET,
      scoring: scoringRow(),
      cluster: null,
      aggregates: aggregates(),
      recentTrades: [],
      helius: { ok: true, transactions: [] },
      computedAt: NOW,
    }) as Record<string, any>;
    expect(body["signals"]["cluster"]).toBeNull();
  });
});
