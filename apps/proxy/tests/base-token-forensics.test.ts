import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  baseTokenForensics,
  baseTokenForensicsInputSchema,
  baseTokenForensicsPreflight,
  baseTokenForensicsValidator,
  buildForensicsResponse,
  computeConcentration,
  deriveForensicsVerdict,
  type ForensicFacts,
  type HolderShareRow,
} from "../src/handlers/base-token-forensics.js";

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

const ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC
const ADDR_LC = ADDR.toLowerCase();
const DEPLOYER = "0x" + "9".repeat(40);
const TX1 = "0x" + "ab".repeat(32);
const TX2 = "0x" + "cd".repeat(32);
const CREATION_TX = "0x" + "11".repeat(32);
const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ORIGINAL_ETHERSCAN_KEY = process.env["ETHERSCAN_API_KEY"];
beforeAll(() => {
  // etherscan-base-contract-info (the CRITICAL sibling) refuses to run
  // keyless — every in-process reuse path needs this set.
  process.env["ETHERSCAN_API_KEY"] = "test-key";
});
afterAll(() => {
  if (ORIGINAL_ETHERSCAN_KEY === undefined) {
    delete process.env["ETHERSCAN_API_KEY"];
  } else {
    process.env["ETHERSCAN_API_KEY"] = ORIGINAL_ETHERSCAN_KEY;
  }
});

// ─────────────────────────────────────────────────────────────────────
// Upstream fetch stub — the three siblings are reused IN-PROCESS, so
// we stub the UPSTREAM urls their own fetches hit:
//   api.etherscan.io/v2/api                     (contract info)
//   base.blockscout.com/api/v2/tokens/…/holders (+ /tokens/… info)
//   base.blockscout.com/api/v2/tokens/…/transfers
//   mainnet.base.org                            (tx decoder JSON-RPC)
//   base.blockscout.com/api/v2/addresses/… + /transactions/… (age)
// ─────────────────────────────────────────────────────────────────────

interface StubOpts {
  etherscan?: "verified" | "unverified" | "http500" | "down";
  /** Raw holder balances against totalSupply 10000 (value 200 = 2%). null → holders upstream down. */
  holderValues?: string[] | null;
  totalSupply?: string;
  totalHolders?: string;
  /** Transfers list + decoder + address/creation endpoints all down. */
  activityDown?: boolean;
  creationTimestamp?: string;
}

interface StubCounts {
  etherscan: number;
  holders: number;
  tokenInfo: number;
  transfers: number;
  rpc: number;
  addresses: number;
  transactions: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function etherscanBody(mode: "verified" | "unverified"): unknown {
  return {
    status: "1",
    message: "OK",
    result: [
      {
        SourceCode: mode === "verified" ? "contract TestToken {}" : "",
        ABI:
          mode === "verified" ? "[]" : "Contract source code not verified",
        ContractName: mode === "verified" ? "TestToken" : "",
        CompilerVersion: mode === "verified" ? "v0.8.20+commit.a1b79de6" : "",
        OptimizationUsed: mode === "verified" ? "1" : "0",
        Runs: mode === "verified" ? "200" : "",
        LicenseType: mode === "verified" ? "MIT" : "",
        Proxy: "0",
        Implementation: "",
      },
    ],
  };
}

function makeStub(opts: StubOpts = {}): {
  fetchImpl: typeof fetch;
  counts: StubCounts;
} {
  const counts: StubCounts = {
    etherscan: 0,
    holders: 0,
    tokenInfo: 0,
    transfers: 0,
    rpc: 0,
    addresses: 0,
    transactions: 0,
  };
  const supply = opts.totalSupply ?? "10000";
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);

    if (u.includes("api.etherscan.io/v2/api")) {
      counts.etherscan += 1;
      const mode = opts.etherscan ?? "verified";
      if (mode === "down") throw new Error("ECONNREFUSED");
      if (mode === "http500") return new Response("oops", { status: 500 });
      return json(etherscanBody(mode));
    }

    if (u.includes(`/tokens/${ADDR_LC}/holders`)) {
      counts.holders += 1;
      if (opts.holderValues === null) {
        return new Response("upstream sad", { status: 500 });
      }
      const values = opts.holderValues ?? Array(10).fill("200");
      return json({
        items: values.map((v, i) => ({
          address: { hash: "0x" + String(i + 1).padStart(40, "0"), is_contract: false },
          value: v,
          token_id: null,
        })),
        next_page_params: null,
      });
    }

    if (u.includes(`/tokens/${ADDR_LC}/transfers`)) {
      counts.transfers += 1;
      if (opts.activityDown) return new Response("sad", { status: 500 });
      return json({
        items: [
          { transaction_hash: TX1 }, // newer Blockscout spelling
          { tx_hash: TX2 }, // older spelling
          { transaction_hash: TX1 }, // duplicate — must be deduped
          { tx_hash: "not-a-hash" },
        ],
      });
    }

    if (u.endsWith(`/tokens/${ADDR_LC}`)) {
      counts.tokenInfo += 1;
      if (opts.holderValues === null) {
        return new Response("upstream sad", { status: 500 });
      }
      return json({
        address: ADDR_LC,
        name: "Test Token",
        symbol: "TEST",
        decimals: "18",
        total_supply: supply,
        holders: opts.totalHolders ?? "5000",
        type: "ERC-20",
      });
    }

    if (u.includes(`/addresses/${ADDR_LC}`)) {
      counts.addresses += 1;
      if (opts.activityDown) return new Response("sad", { status: 500 });
      return json({
        creator_address_hash: DEPLOYER,
        creation_tx_hash: CREATION_TX,
      });
    }

    if (u.includes(`/transactions/${CREATION_TX}`)) {
      counts.transactions += 1;
      if (opts.activityDown) return new Response("sad", { status: 500 });
      return json({
        timestamp: opts.creationTimestamp ?? "2025-01-01T00:00:00.000Z",
      });
    }

    if (u.includes("mainnet.base.org")) {
      counts.rpc += 1;
      if (opts.activityDown) return new Response("sad", { status: 500 });
      const req = JSON.parse(String(init?.body ?? "{}")) as {
        method?: string;
        params?: string[];
        id?: number;
      };
      const hash = req.params?.[0] ?? TX1;
      if (req.method === "eth_getTransactionByHash") {
        return json({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            hash,
            from: "0x" + "1".repeat(40),
            to: ADDR_LC,
            value: "0x0",
            input: "0xa9059cbb" + "0".repeat(128),
            blockNumber: "0x100",
            nonce: "0x1",
          },
        });
      }
      return json({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          status: "0x1",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x3b9aca00",
          contractAddress: null,
          logs: [
            {
              address: ADDR_LC,
              topics: [
                TRANSFER_TOPIC,
                "0x" + "0".repeat(24) + "1".repeat(40),
                "0x" + "0".repeat(24) + "2".repeat(40),
              ],
              data: "0x0de0b6b3a7640000",
            },
          ],
        },
      });
    }

    throw new Error(`unexpected url in test: ${u}`);
  }) as typeof fetch;
  return { fetchImpl, counts };
}

function input(
  body: string | Record<string, unknown> | null,
  fetchImpl: typeof fetch,
  preflightData?: unknown,
) {
  return {
    body:
      body === null
        ? null
        : Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    method: "POST",
    fetchImpl,
    ...(preflightData !== undefined ? { preflightData } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Pre-payment validator — discovery split
// ─────────────────────────────────────────────────────────────────────

describe("baseTokenForensicsValidator", () => {
  const validate = (body: string | null) =>
    baseTokenForensicsValidator(body === null ? null : Buffer.from(body), "POST");

  it("accepts a valid Base contract address", () => {
    expect(validate(JSON.stringify({ contract_address: ADDR }))).toBeNull();
  });

  it("passes empty body through to the 402 challenge (discovery)", () => {
    expect(validate(null)).toBeNull();
    expect(validate("")).toBeNull();
    expect(validate("   ")).toBeNull();
    expect(validate("null")).toBeNull();
  });

  it("passes missing / non-string / placeholder values through (discovery)", () => {
    expect(validate("{}")).toBeNull();
    expect(validate(JSON.stringify({ contract_address: 42 }))).toBeNull();
    expect(validate(JSON.stringify({ contract_address: "" }))).toBeNull();
    for (const placeholder of [
      "string",
      "<0x base token contract>",
      "YOUR_CONTRACT",
      "{contract_address}",
      "${CONTRACT}",
      "xxxxxxxxxx",
    ]) {
      expect(
        validate(JSON.stringify({ contract_address: placeholder })),
        `expected discovery pass-through for ${placeholder}`,
      ).toBeNull();
    }
  });

  it("rejects invalid JSON with 400", () => {
    expect(validate("{nope")?.status).toBe(400);
  });

  it("rejects a JSON array / scalar body with 422", () => {
    expect(validate("[1,2]")?.status).toBe(422);
    expect(validate("5")?.status).toBe(422);
  });

  it("rejects present-but-invalid addresses with 422 + input_schema", () => {
    for (const bad of [
      "hello-world",
      "0x12345", // too short
      "0x" + "z".repeat(40), // non-hex
      ADDR + "ff", // too long
      "CBjwziSG9Z48MSAfqXNuKHyQ3JqrC963pNeivoUSAV5b", // solana base58
    ]) {
      const res = validate(JSON.stringify({ contract_address: bad }));
      expect(res?.status, `expected 422 for ${bad}`).toBe(422);
      expect(
        (res?.body as { input_schema?: unknown }).input_schema,
        `expected input_schema for ${bad}`,
      ).toBe(baseTokenForensicsInputSchema);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// computeConcentration — table tests
// ─────────────────────────────────────────────────────────────────────

describe("computeConcentration", () => {
  const rows = (pcts: Array<number | null>): HolderShareRow[] =>
    pcts.map((p, i) => ({ address: `0xholder${i}`, percentOfSupply: p }));

  it("empty page → unknown concentration, no holders", () => {
    const c = computeConcentration([]);
    expect(c.top1_share_pct).toBeNull();
    expect(c.top10_share_pct).toBeNull();
    expect(c.top_holders).toEqual([]);
  });

  it("sums the top-10 and reports top-1 from the first row", () => {
    const c = computeConcentration(rows([30, 10, 5, 5, 2, 2, 2, 2, 1, 1, 99]));
    expect(c.top1_share_pct).toBe(30);
    expect(c.top10_share_pct).toBe(60); // 11th row (99) NOT counted
    expect(c.top_holders).toHaveLength(10);
  });

  it("caps top_holders at 10 rows even from a 50-row page", () => {
    const c = computeConcentration(rows(Array(50).fill(1)));
    expect(c.top_holders).toHaveLength(10);
    expect(c.top10_share_pct).toBe(10);
  });

  it("ALL-null shares (missing total supply) → unknown, NOT zero", () => {
    const c = computeConcentration(rows([null, null, null]));
    expect(c.top1_share_pct).toBeNull();
    expect(c.top10_share_pct).toBeNull();
    expect(c.top_holders).toHaveLength(3);
  });

  it("mixed null shares contribute 0 to top-10 but keep their slot", () => {
    const c = computeConcentration(rows([40, null, 10]));
    expect(c.top1_share_pct).toBe(40);
    expect(c.top10_share_pct).toBe(50);
    expect(c.top_holders[1]!.share_pct).toBeNull();
  });

  it("rounds shares to 2 decimals", () => {
    const c = computeConcentration(rows([33.33333, 33.33333, 33.33333]));
    expect(c.top1_share_pct).toBe(33.33);
    expect(c.top10_share_pct).toBe(99.99);
  });
});

// ─────────────────────────────────────────────────────────────────────
// deriveForensicsVerdict — rule table
// ─────────────────────────────────────────────────────────────────────

describe("deriveForensicsVerdict", () => {
  const facts = (o: Partial<ForensicFacts> = {}): ForensicFacts => ({
    is_verified: true,
    top1_share_pct: 5,
    top10_share_pct: 20,
    holder_count: 5000,
    age_days: 400,
    concentration_known: true,
    ...o,
  });

  it("verified + distributed + old + many holders → CLEAN, no flags", () => {
    const v = deriveForensicsVerdict(facts());
    expect(v.status).toBe("CLEAN");
    expect(v.flags).toEqual([]);
    expect(v.summary).toContain("CLEAN");
  });

  it("R1: unverified AND top10 > 70 → RED_FLAG", () => {
    const v = deriveForensicsVerdict(
      facts({ is_verified: false, top10_share_pct: 71 }),
    );
    expect(v.status).toBe("RED_FLAG");
    expect(v.flags).toContain("unverified_contract");
    expect(v.flags).toContain("top10_share_gt_70pct");
  });

  it("verified with top10 > 70 is only WATCH (R1 needs unverified)", () => {
    const v = deriveForensicsVerdict(facts({ top10_share_pct: 80 }));
    expect(v.status).toBe("WATCH");
    expect(v.flags).toEqual(["top10_share_gt_70pct"]);
  });

  it("R2: top1 > 50 → RED_FLAG even for a verified contract", () => {
    const v = deriveForensicsVerdict(
      facts({ top1_share_pct: 60, top10_share_pct: 65 }),
    );
    expect(v.status).toBe("RED_FLAG");
    expect(v.flags).toContain("top1_share_gt_50pct");
  });

  it("R3: age < 7d AND top10 > 50 → RED_FLAG", () => {
    const v = deriveForensicsVerdict(
      facts({ age_days: 3, top10_share_pct: 55 }),
    );
    expect(v.status).toBe("RED_FLAG");
  });

  it("age < 7d with UNKNOWN concentration never escalates to RED", () => {
    const v = deriveForensicsVerdict(
      facts({
        age_days: 3,
        top1_share_pct: null,
        top10_share_pct: null,
        concentration_known: false,
      }),
    );
    expect(v.status).toBe("WATCH");
    expect(v.flags).toContain("new_contract_lt_7d");
    expect(v.flags).toContain("concentration_unknown");
  });

  it("single WATCH flags: unverified / top10>50 / age<7d / holders<50", () => {
    expect(deriveForensicsVerdict(facts({ is_verified: false })).status).toBe(
      "WATCH",
    );
    expect(
      deriveForensicsVerdict(facts({ top10_share_pct: 55 })).flags,
    ).toEqual(["top10_share_gt_50pct"]);
    expect(deriveForensicsVerdict(facts({ age_days: 6.9 })).status).toBe(
      "WATCH",
    );
    expect(deriveForensicsVerdict(facts({ holder_count: 49 })).flags).toEqual([
      "holder_count_lt_50",
    ]);
  });

  it("concentration_unknown alone is WATCH — never silently CLEAN", () => {
    const v = deriveForensicsVerdict(
      facts({
        top1_share_pct: null,
        top10_share_pct: null,
        concentration_known: false,
      }),
    );
    expect(v.status).toBe("WATCH");
    expect(v.flags).toEqual(["concentration_unknown"]);
    expect(v.summary).toContain("could not be determined");
  });

  it("boundary values do NOT fire: top10=50, top1=50, age=7, holders=50", () => {
    const v = deriveForensicsVerdict(
      facts({
        top10_share_pct: 50,
        top1_share_pct: 50,
        age_days: 7,
        holder_count: 50,
      }),
    );
    expect(v.status).toBe("CLEAN");
    expect(v.flags).toEqual([]);
  });

  it("unknown age / unknown holder_count never fire their rules", () => {
    const v = deriveForensicsVerdict(
      facts({ age_days: null, holder_count: null }),
    );
    expect(v.status).toBe("CLEAN");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Fail-closed preflight
// ─────────────────────────────────────────────────────────────────────

describe("baseTokenForensicsPreflight (fail-closed)", () => {
  it("proceeds with threaded critical data when Etherscan answers", async () => {
    const { fetchImpl, counts } = makeStub();
    const pf = await baseTokenForensicsPreflight(
      input({ contract_address: ADDR }, fetchImpl),
    );
    expect(pf.proceed).toBe(true);
    if (pf.proceed) {
      const data = pf.data as {
        kind: string;
        contract: string;
        contractInfo: { verified: boolean; name: string | null };
      };
      expect(data.kind).toBe("base_token_forensics_critical");
      expect(data.contract).toBe(ADDR_LC);
      expect(data.contractInfo.verified).toBe(true);
      expect(data.contractInfo.name).toBe("TestToken");
    }
    // Preflight touches ONLY the critical source.
    expect(counts.etherscan).toBe(1);
    expect(counts.holders).toBe(0);
    expect(counts.rpc).toBe(0);
  });

  it("contract-info upstream down → 503, does NOT proceed (no charge)", async () => {
    for (const mode of ["http500", "down"] as const) {
      const { fetchImpl } = makeStub({ etherscan: mode });
      const pf = await baseTokenForensicsPreflight(
        input({ contract_address: ADDR }, fetchImpl),
      );
      expect(pf.proceed, `expected no-proceed for ${mode}`).toBe(false);
      if (!pf.proceed) {
        expect(pf.status).toBe(503);
        expect((pf.body as { error: string }).error).toBe(
          "critical_source_unavailable",
        );
        expect((pf.body as { source: string }).source).toBe("contract_info");
      }
    }
  });

  it("MISSING ETHERSCAN_API_KEY → 503 fail-closed, never settles", async () => {
    delete process.env["ETHERSCAN_API_KEY"];
    try {
      const { fetchImpl, counts } = makeStub();
      const pf = await baseTokenForensicsPreflight(
        input({ contract_address: ADDR }, fetchImpl),
      );
      expect(pf.proceed).toBe(false);
      if (!pf.proceed) expect(pf.status).toBe(503);
      expect(counts.etherscan).toBe(0); // sibling bails before fetching
    } finally {
      process.env["ETHERSCAN_API_KEY"] = "test-key";
    }
  });

  it("blocks a PAID discovery-class body with 422 + input_schema", async () => {
    for (const body of [
      null,
      {},
      { contract_address: "string" },
      { contract_address: "" },
      { contract_address: "<0x base token contract>" },
    ]) {
      const { fetchImpl, counts } = makeStub();
      const pf = await baseTokenForensicsPreflight(input(body, fetchImpl));
      expect(pf.proceed, `expected no-proceed for ${JSON.stringify(body)}`).toBe(
        false,
      );
      if (!pf.proceed) {
        expect(pf.status).toBe(422);
        expect(
          (pf.body as { input_schema?: unknown }).input_schema,
        ).toBeDefined();
      }
      expect(counts.etherscan).toBe(0); // rejected before any I/O
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Handler — full paths
// ─────────────────────────────────────────────────────────────────────

describe("baseTokenForensics handler", () => {
  it("verified + distributed + aged token → CLEAN, high confidence", async () => {
    const { fetchImpl } = makeStub(); // 10 × 2% holders, 5000 total, 2025 creation
    const res = await baseTokenForensics(
      input({ contract_address: ADDR }, fetchImpl),
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.contract_address).toBe(ADDR_LC);
    expect(body.verdict.status).toBe("CLEAN");
    expect(body.verdict.flags).toEqual([]);
    expect(body.verdict.confidence).toBe("high");
    expect(body.signals.contract.is_verified).toBe(true);
    expect(body.signals.contract.name).toBe("TestToken");
    expect(body.signals.contract.deployer).toBe(DEPLOYER);
    expect(body.signals.contract.age_days).toBeGreaterThan(7);
    expect(body.signals.holders.holder_count).toBe(5000);
    expect(body.signals.holders.top1_share_pct).toBe(2);
    expect(body.signals.holders.top10_share_pct).toBe(20);
    expect(body.signals.holders.top_holders.length).toBeLessThanOrEqual(10);
    // Recent activity: TX1 + TX2, deduped, decoded via base_rpc_tx_decoder.
    expect(body.signals.recent_activity).toHaveLength(2);
    expect(body.signals.recent_activity[0].tx_hash).toBe(TX1);
    expect(body.signals.recent_activity[0].status).toBe("success");
    expect(body.signals.recent_activity[0].method_id).toBe("0xa9059cbb");
    expect(body.signals.recent_activity[0].erc20_transfer_count).toBe(1);
    expect(body.data_quality.stale_sources).toEqual([]);
    expect(body.data_quality.sources).toEqual({
      contract_info: "ok",
      holders: "ok",
      activity: "ok",
    });
    // Raw caps: slim contract info (no source body), ≤10 raw holders.
    expect(body.raw.contract_info.sourceCode).toBeUndefined();
    expect(body.raw.holders_page.holders.length).toBeLessThanOrEqual(10);
  });

  it("unverified + top10 at 80% → RED_FLAG (R1)", async () => {
    const { fetchImpl } = makeStub({
      etherscan: "unverified",
      holderValues: Array(10).fill("800"), // 8% each → top10 = 80%
    });
    const res = await baseTokenForensics(
      input({ contract_address: ADDR }, fetchImpl),
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.verdict.status).toBe("RED_FLAG");
    expect(body.verdict.flags).toContain("unverified_contract");
    expect(body.verdict.flags).toContain("top10_share_gt_70pct");
    expect(body.verdict.summary).toContain("RED-FLAG");
    expect(body.signals.holders.top10_share_pct).toBe(80);
  });

  it("single holder at 60% → RED_FLAG (R2) even though verified", async () => {
    const { fetchImpl } = makeStub({
      holderValues: ["6000", ...Array(9).fill("100")], // 60% + 9×1%
    });
    const res = await baseTokenForensics(
      input({ contract_address: ADDR }, fetchImpl),
    );
    const body = res.body as Record<string, any>;
    expect(body.verdict.status).toBe("RED_FLAG");
    expect(body.verdict.flags).toContain("top1_share_gt_50pct");
    expect(body.signals.holders.top1_share_pct).toBe(60);
  });

  it("holders upstream down → 200 WATCH, degraded + stale_sources", async () => {
    const { fetchImpl } = makeStub({ holderValues: null });
    const res = await baseTokenForensics(
      input({ contract_address: ADDR }, fetchImpl),
    );
    expect(res.status).toBe(200); // buyer still gets the dossier
    const body = res.body as Record<string, any>;
    expect(body.verdict.status).toBe("WATCH");
    expect(body.verdict.flags).toContain("concentration_unknown");
    expect(body.verdict.confidence).toBe("medium");
    expect(body.data_quality.stale_sources).toContain("holders");
    expect(body.data_quality.sources.holders).toBe("degraded");
    expect(body.signals.holders.top10_share_pct).toBeNull();
    expect(body.signals.holders.top_holders).toEqual([]);
    expect(body.raw.holders_page).toBeNull();
  });

  it("activity + age lookups down → 200, degraded activity, age null", async () => {
    const { fetchImpl } = makeStub({ activityDown: true });
    const res = await baseTokenForensics(
      input({ contract_address: ADDR }, fetchImpl),
    );
    expect(res.status).toBe(200);
    const body = res.body as Record<string, any>;
    expect(body.verdict.status).toBe("CLEAN"); // unknown age never escalates
    expect(body.data_quality.stale_sources).toContain("activity");
    expect(body.signals.recent_activity).toEqual([]);
    expect(body.signals.contract.age_days).toBeNull();
    expect(body.signals.contract.created_at).toBeNull();
  });

  it("invalid address → 422 before any upstream I/O", async () => {
    const { fetchImpl, counts } = makeStub();
    const res = await baseTokenForensics(
      input({ contract_address: "0xNOTHEX" }, fetchImpl),
    );
    expect(res.status).toBe(422);
    expect(counts.etherscan + counts.holders + counts.rpc).toBe(0);
  });

  it("critical source down without preflight data → 503 (recompute path)", async () => {
    const { fetchImpl } = makeStub({ etherscan: "down" });
    const res = await baseTokenForensics(
      input({ contract_address: ADDR }, fetchImpl),
    );
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe(
      "critical_source_unavailable",
    );
  });

  it("REUSES preflightData — Etherscan hit exactly once across the paid flow", async () => {
    const pfStub = makeStub();
    const pf = await baseTokenForensicsPreflight(
      input({ contract_address: ADDR }, pfStub.fetchImpl),
    );
    expect(pf.proceed).toBe(true);
    expect(pfStub.counts.etherscan).toBe(1);

    // Handler runs with a FRESH counting stub whose Etherscan is dead:
    // if the handler recomputed the critical source it would 503.
    const handlerStub = makeStub({ etherscan: "down" });
    const res = await baseTokenForensics(
      input(
        { contract_address: ADDR },
        handlerStub.fetchImpl,
        (pf as { data?: unknown }).data,
      ),
    );
    expect(res.status).toBe(200);
    expect(handlerStub.counts.etherscan).toBe(0);
    const body = res.body as Record<string, any>;
    expect(body.signals.contract.is_verified).toBe(true);
    expect(body.verdict.status).toBe("CLEAN");
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildForensicsResponse — degraded-holders honesty
// ─────────────────────────────────────────────────────────────────────

describe("buildForensicsResponse", () => {
  it("confidence drops to low when BOTH non-critical axes degrade", () => {
    const body = buildForensicsResponse({
      contract: ADDR_LC,
      contractInfo: {
        contract: ADDR_LC,
        verified: true,
        name: "TestToken",
        isProxy: false,
        implementationAddress: null,
        compilerVersion: null,
        licenseType: null,
        optimizationUsed: null,
        sourceAvailable: true,
      },
      holders: { ok: false, error: "holders_status_502" },
      activity: { ok: false, error: "transfers_status_500", decoded: [], rawDecoded: [] },
      deployer: null,
      createdAt: null,
      computedAt: new Date("2026-07-01T00:00:00Z"),
    }) as Record<string, any>;
    expect(body.verdict.confidence).toBe("low");
    expect(body.data_quality.stale_sources).toEqual(["holders", "activity"]);
    expect(body.verdict.status).toBe("WATCH"); // concentration_unknown
  });

  it("holders page WITHOUT supply shares → concentration_unknown WATCH", () => {
    const body = buildForensicsResponse({
      contract: ADDR_LC,
      contractInfo: {
        contract: ADDR_LC,
        verified: true,
        name: "TestToken",
        isProxy: false,
        implementationAddress: null,
        compilerVersion: null,
        licenseType: null,
        optimizationUsed: null,
        sourceAvailable: true,
      },
      holders: {
        ok: true,
        page: {
          name: "TestToken",
          symbol: "TEST",
          totalHolders: 900,
          sampleSize: 2,
          holders: [
            { address: "0xa", percentOfSupply: null },
            { address: "0xb", percentOfSupply: null },
          ],
          raw: {},
        },
      },
      activity: { ok: true, error: null, decoded: [], rawDecoded: [] },
      deployer: null,
      createdAt: null,
      computedAt: new Date("2026-07-01T00:00:00Z"),
    }) as Record<string, any>;
    // Source answered but shares are unknowable — must NOT be CLEAN.
    expect(body.verdict.status).toBe("WATCH");
    expect(body.verdict.flags).toContain("concentration_unknown");
    expect(body.signals.holders.holder_count).toBe(900);
  });
});
