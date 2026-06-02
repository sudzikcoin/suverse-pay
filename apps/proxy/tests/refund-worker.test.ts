/**
 * Unit tests for the refund worker.
 *
 * pg-mem is intentionally NOT used here — pg-mem's FOR UPDATE SKIP
 * LOCKED semantics are unreliable (see memory `reference_pgmem_gotchas`),
 * and the worker's correctness hinges on that clause. Instead we mock
 * `pg.Pool.connect()` to return a hand-rolled fake client and assert on
 * the query strings + UPDATE parameters.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runRefundTick,
  startRefundWorker,
  type RefundWorkerDeps,
  type RefundWorkerLogger,
} from "../src/refund-worker.js";
import type { Pool } from "pg";

const NOOP_LOGGER: RefundWorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---- fake pg.Pool ----------------------------------------------------------

interface RecordedQuery {
  text: string;
  params: unknown[];
}

interface FakePool {
  pool: Pool;
  recorded: RecordedQuery[];
}

interface FakeTable<Row extends { id: string }> {
  /** Rows currently queryable. Mutated by INSERT/UPDATE simulation. */
  rows: Row[];
}

interface FakeState {
  swapRefunds: FakeTable<SwapRefundRow & { status: string; refund_tx_hash?: string }>;
  refundsPending: FakeTable<RefundsPendingRow & { status: string; refund_tx_hash?: string }>;
}

interface SwapRefundRow {
  id: string;
  swap_id: string;
  buyer_address: string;
  network: string;
  amount: string;
  retry_count: number;
  input_token: string;
}

interface RefundsPendingRow {
  id: string;
  buyer_address: string;
  buyer_network: string;
  buyer_asset: string;
  buyer_amount_atomic: string;
  retry_count: number;
}

/**
 * Build a fake pg.Pool whose stateful SELECT returns the first
 * still-`pending` row that hasn't exceeded retry_count, and whose
 * UPDATE mutates the in-memory row so subsequent SELECTs see the
 * new state — close enough to real Postgres semantics for the
 * worker's logic.
 */
function buildFakePool(initial: Partial<FakeState> = {}): FakePool {
  const recorded: RecordedQuery[] = [];
  const state: FakeState = {
    swapRefunds: {
      rows: (initial.swapRefunds?.rows ?? []).map((r) => ({
        status: "pending",
        ...r,
      })),
    },
    refundsPending: {
      rows: (initial.refundsPending?.rows ?? []).map((r) => ({
        status: "pending",
        ...r,
      })),
    },
  };

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      recorded.push({ text, params });
      const t = text.replace(/\s+/g, " ").trim();

      if (/FROM swap_refunds sr/i.test(t)) {
        const max = Number(params[0] ?? 3);
        const excludeIds = ((params[1] as string[] | undefined) ?? []);
        const found = state.swapRefunds.rows.find(
          (r) =>
            r.status === "pending" &&
            r.retry_count < max &&
            !excludeIds.includes(r.id),
        );
        return found
          ? { rows: [found], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/FROM refunds_pending/i.test(t)) {
        const max = Number(params[0] ?? 3);
        const excludeIds = ((params[1] as string[] | undefined) ?? []);
        const found = state.refundsPending.rows.find(
          (r) =>
            r.status === "pending" &&
            r.retry_count < max &&
            !excludeIds.includes(r.id),
        );
        return found
          ? { rows: [found], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/UPDATE swap_refunds/i.test(t)) {
        applySwapRefundUpdate(state.swapRefunds, t, params);
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE refunds_pending/i.test(t)) {
        applyRefundsPendingUpdate(state.refundsPending, t, params);
        return { rows: [], rowCount: 1 };
      }
      // BEGIN / COMMIT / ROLLBACK: no-op
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };

  const pool = {
    connect: async () => client,
  } as unknown as Pool;

  return { pool, recorded };
}

function applySwapRefundUpdate(
  table: FakeState["swapRefunds"],
  text: string,
  params: unknown[],
): void {
  // 'refunded' update: ($1=tx_hash, $2=id)
  if (/SET\s+status\s*=\s*'refunded'/.test(text)) {
    const id = params[1] as string;
    const row = table.rows.find((r) => r.id === id);
    if (row) {
      row.status = "refunded";
      row.refund_tx_hash = params[0] as string;
    }
    return;
  }
  // 'retry' update: ($1=count, $2=err, $3=id)
  if (/SET\s+retry_count\s*=\s*\$1/.test(text)) {
    const id = params[2] as string;
    const row = table.rows.find((r) => r.id === id);
    if (row) {
      row.retry_count = params[0] as number;
    }
    return;
  }
  // 'skip' update: ($1=reason, $2=id) — no state change beyond last_error
}

function applyRefundsPendingUpdate(
  table: FakeState["refundsPending"],
  text: string,
  params: unknown[],
): void {
  if (/SET\s+status\s*=\s*'refunded'/.test(text)) {
    const id = params[1] as string;
    const row = table.rows.find((r) => r.id === id);
    if (row) {
      row.status = "refunded";
      row.refund_tx_hash = params[0] as string;
    }
    return;
  }
  if (/SET\s+retry_count\s*=\s*\$1/.test(text)) {
    const id = params[2] as string;
    const row = table.rows.find((r) => r.id === id);
    if (row) {
      row.retry_count = params[0] as number;
    }
    return;
  }
}

// ---- happy path: swap_refunds → solana SPL transfer -----------------------

describe("runRefundTick — swap_refunds Solana happy path", () => {
  it("claims a pending row, broadcasts, marks refunded", async () => {
    const claimed: SwapRefundRow = {
      id: "refund-1",
      swap_id: "swap-1",
      buyer_address: "GEytKjbGUTnBH2M55sRNMibim2LgLMamHBRnXXofdDQk",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "808000",
      retry_count: 0,
      input_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const fake = buildFakePool({ swapRefunds: { rows: [claimed] } });

    const solanaChain = {
      transferOutput: vi.fn(async () => ({ signature: "solanaSig123" })),
    };

    const result = await runRefundTick({
      pool: fake.pool,
      solanaChain: solanaChain as never,
      logger: NOOP_LOGGER,
      alertLogPath: "/tmp/never-written.log",
      maxRetries: 3,
      batchLimit: 5,
    });

    expect(solanaChain.transferOutput).toHaveBeenCalledWith({
      mint: claimed.input_token,
      amount: 808_000n,
      recipient: claimed.buyer_address,
    });
    const refundedUpdate = fake.recorded.find((q) =>
      /UPDATE swap_refunds[\s\S]+status\s*=\s*'refunded'/.test(q.text),
    );
    expect(refundedUpdate).toBeDefined();
    expect(refundedUpdate!.params).toEqual(["solanaSig123", "refund-1"]);

    expect(result.swapRefunds.refunded).toBe(1);
    expect(result.swapRefunds.failed).toBe(0);
    expect(result.swapRefunds.skipped).toBe(0);
  });
});

// ---- happy path: refunds_pending → Base ERC-20 transfer -------------------

describe("runRefundTick — refunds_pending Base happy path", () => {
  it("claims a pending row, broadcasts ERC20, marks refunded", async () => {
    const claimed: RefundsPendingRow = {
      id: "rp-1",
      buyer_address: "0x0145ee0B440300928291668eDC5557f4B0779087",
      buyer_network: "eip155:8453",
      buyer_asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      buyer_amount_atomic: "1000000",
      retry_count: 0,
    };
    const fake = buildFakePool({ refundsPending: { rows: [claimed] } });

    const baseChain = {
      transferERC20: vi.fn(async () => ({ txHash: "0xbaseTx456" })),
    };

    const result = await runRefundTick({
      pool: fake.pool,
      baseChain: baseChain as never,
      logger: NOOP_LOGGER,
      maxRetries: 3,
      batchLimit: 5,
    });

    expect(baseChain.transferERC20).toHaveBeenCalledWith({
      token: claimed.buyer_asset,
      to: claimed.buyer_address,
      amount: 1_000_000n,
    });
    const refundedUpdate = fake.recorded.find((q) =>
      /UPDATE refunds_pending[\s\S]+status\s*=\s*'refunded'/.test(q.text),
    );
    expect(refundedUpdate).toBeDefined();
    expect(refundedUpdate!.params).toEqual(["0xbaseTx456", "rp-1"]);
    expect(result.refundsPending.refunded).toBe(1);
  });
});

// ---- broadcast failure increments retry_count -----------------------------

describe("runRefundTick — broadcast failure", () => {
  it("increments retry_count and stashes last_error on chain error", async () => {
    const claimed: SwapRefundRow = {
      id: "refund-2",
      swap_id: "swap-2",
      buyer_address: "GEytKjbGUTnBH2M55sRNMibim2LgLMamHBRnXXofdDQk",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "1000",
      retry_count: 1,
      input_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const fake = buildFakePool({ swapRefunds: { rows: [claimed] } });

    const solanaChain = {
      transferOutput: vi.fn(async () => {
        throw new Error("rpc_timeout");
      }),
    };

    const result = await runRefundTick({
      pool: fake.pool,
      solanaChain: solanaChain as never,
      logger: NOOP_LOGGER,
      alertLogPath: "/tmp/never-written.log",
      maxRetries: 3,
      batchLimit: 5,
    });

    const retryUpdate = fake.recorded.find((q) =>
      /UPDATE swap_refunds[\s\S]+retry_count\s*=\s*\$1/.test(q.text),
    );
    expect(retryUpdate).toBeDefined();
    expect(retryUpdate!.params[0]).toBe(2); // incremented from 1 → 2
    expect(retryUpdate!.params[1]).toBe("rpc_timeout");
    expect(retryUpdate!.params[2]).toBe("refund-2");
    expect(result.swapRefunds.failed).toBe(1);
    expect(result.swapRefunds.refunded).toBe(0);
  });
});

// ---- alert on third failure ------------------------------------------------

describe("runRefundTick — alert log on retry exhaustion", () => {
  let alertDir: string;
  let alertPath: string;
  beforeEach(() => {
    alertDir = mkdtempSync(join(tmpdir(), "refund-alerts-"));
    alertPath = join(alertDir, "alerts.log");
  });
  afterEach(() => {
    rmSync(alertDir, { recursive: true, force: true });
  });

  it("appends a JSON line when retry_count crosses maxRetries", async () => {
    const claimed: SwapRefundRow = {
      id: "refund-3",
      swap_id: "swap-3",
      buyer_address: "GEytKjbGUTnBH2M55sRNMibim2LgLMamHBRnXXofdDQk",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "500",
      retry_count: 2, // third attempt → next=3 → trips alert
      input_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const fake = buildFakePool({ swapRefunds: { rows: [claimed] } });

    const solanaChain = {
      transferOutput: vi.fn(async () => {
        throw new Error("persistent_error");
      }),
    };

    await runRefundTick({
      pool: fake.pool,
      solanaChain: solanaChain as never,
      logger: NOOP_LOGGER,
      alertLogPath: alertPath,
      maxRetries: 3,
      batchLimit: 5,
    });

    const contents = readFileSync(alertPath, "utf8").trim();
    const parsed = JSON.parse(contents);
    expect(parsed.table).toBe("swap_refunds");
    expect(parsed.id).toBe("refund-3");
    expect(parsed.last_error).toBe("persistent_error");
    expect(parsed.buyer).toBe(claimed.buyer_address);
    expect(parsed.amount).toBe("500");
  });

  it("does NOT alert when retry_count crosses maxRetries on first attempt only", async () => {
    const claimed: SwapRefundRow = {
      id: "refund-4",
      swap_id: "swap-4",
      buyer_address: "GEytKjbGUTnBH2M55sRNMibim2LgLMamHBRnXXofdDQk",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "500",
      retry_count: 0,
      input_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const fake = buildFakePool({ swapRefunds: { rows: [claimed] } });

    const solanaChain = {
      transferOutput: vi.fn(async () => {
        throw new Error("first_failure");
      }),
    };

    await runRefundTick({
      pool: fake.pool,
      solanaChain: solanaChain as never,
      logger: NOOP_LOGGER,
      alertLogPath: alertPath,
      maxRetries: 3,
      batchLimit: 5,
    });

    let threw = false;
    try {
      readFileSync(alertPath, "utf8");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

// ---- skip path: chain not configured --------------------------------------

describe("runRefundTick — skip when chain absent", () => {
  it("marks last_error but does NOT increment retry_count", async () => {
    const claimed: SwapRefundRow = {
      id: "refund-5",
      swap_id: "swap-5",
      buyer_address: "GEytKjbGUTnBH2M55sRNMibim2LgLMamHBRnXXofdDQk",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "100",
      retry_count: 0,
      input_token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const fake = buildFakePool({ swapRefunds: { rows: [claimed] } });

    const result = await runRefundTick({
      pool: fake.pool,
      logger: NOOP_LOGGER,
      maxRetries: 3,
      batchLimit: 5,
    });

    expect(result.swapRefunds.skipped).toBe(1);
    expect(result.swapRefunds.failed).toBe(0);
    expect(result.swapRefunds.refunded).toBe(0);

    const updates = fake.recorded.filter((q) =>
      /UPDATE swap_refunds/.test(q.text),
    );
    // Should be a single skip-update (only sets last_error + last_retry_at)
    expect(updates.length).toBe(1);
    expect(updates[0]!.text).not.toMatch(/retry_count/);
    expect(updates[0]!.text).toMatch(/last_error/);
    expect(updates[0]!.params[0]).toBe("no_solana_chain_configured");
  });
});

// ---- no pending rows -------------------------------------------------------

describe("runRefundTick — no-op when nothing pending", () => {
  it("commits both empty SELECTs and processes zero rows", async () => {
    const fake = buildFakePool([
      {
        match: (t) => /FROM swap_refunds sr/.test(t),
        result: { rows: [], rowCount: 0 },
      },
      {
        match: (t) => /FROM refunds_pending/.test(t),
        result: { rows: [], rowCount: 0 },
      },
    ]);

    const result = await runRefundTick({
      pool: fake.pool,
      logger: NOOP_LOGGER,
      maxRetries: 3,
      batchLimit: 5,
    });

    expect(result.swapRefunds.processed).toBe(0);
    expect(result.refundsPending.processed).toBe(0);
  });
});

// ---- claim query uses FOR UPDATE SKIP LOCKED + retry_count cap -----------

describe("claim SQL", () => {
  it("filters on retry_count and uses FOR UPDATE SKIP LOCKED", async () => {
    const fake = buildFakePool([
      {
        match: (t) => /FROM swap_refunds sr/.test(t),
        result: { rows: [], rowCount: 0 },
      },
      {
        match: (t) => /FROM refunds_pending/.test(t),
        result: { rows: [], rowCount: 0 },
      },
    ]);

    await runRefundTick({
      pool: fake.pool,
      logger: NOOP_LOGGER,
      maxRetries: 3,
      batchLimit: 1,
    });

    const swapSelect = fake.recorded.find((q) =>
      /FROM swap_refunds sr/.test(q.text),
    );
    expect(swapSelect).toBeDefined();
    expect(swapSelect!.text).toMatch(/FOR UPDATE OF sr SKIP LOCKED/);
    expect(swapSelect!.text).toMatch(/retry_count < \$1/);
    expect(swapSelect!.params[0]).toBe(3);
    // swap_refunds.id and swap_id are UUID columns; the exclude clause
    // and SELECT projection MUST cast to text or Postgres errors with
    // `operator does not exist: uuid = text` (seen in production on
    // the first tick after deploy).
    expect(swapSelect!.text).toMatch(/sr\.id::text\s*=\s*ANY/);

    const pendingSelect = fake.recorded.find((q) =>
      /FROM refunds_pending/.test(q.text),
    );
    expect(pendingSelect).toBeDefined();
    expect(pendingSelect!.text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(pendingSelect!.text).toMatch(/retry_count < \$1/);
    expect(pendingSelect!.text).toMatch(/id::text\s*=\s*ANY/);
  });
});

// ---- startRefundWorker timer lifecycle ------------------------------------

describe("startRefundWorker", () => {
  it("returns a handle whose stop() prevents future ticks", () => {
    vi.useFakeTimers();
    try {
      const fake = buildFakePool([
        {
          match: () => true,
          result: { rows: [], rowCount: 0 },
        },
      ]);

      const deps: RefundWorkerDeps = {
        pool: fake.pool,
        logger: NOOP_LOGGER,
        intervalMs: 1000,
        initialDelayMs: 100,
      };
      const handle = startRefundWorker(deps);
      handle.stop();
      // Advance well past two intervals; tick must NOT fire.
      vi.advanceTimersByTime(5000);
      expect(fake.recorded.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
